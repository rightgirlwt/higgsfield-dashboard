import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../ctx';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { placeholderImage } from '../lib/placeholder';
import { logger } from '../logger';

/**
 * Video effects from the Claude "effects" skill (45 of them), run on this computer. Nothing here calls a paid service:
 * previews and renders cost nothing but a little processing time.
 */

export const DEFAULT_LABEL = 'DRAMATIZATION | AI-GENERATED VIDEO';

export interface EffectInfo {
  name: string;
  description: string;
}

const isWin = process.platform === 'win32';
const enginePaths = () => ({
  python: path.join(config.effectsDir, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python'),
  script: path.join(config.effectsDir, 'scripts', 'fx.py'),
  fonts: path.join(config.effectsDir, 'fonts'),
});

export async function engineStatus(): Promise<{ ready: boolean; message: string }> {
  const { python, script } = enginePaths();
  for (const p of [script, python]) {
    try {
      await fs.access(p);
    } catch {
      return { ready: false, message: `The effects engine is not set up (missing ${path.basename(p)}). See docs/HANDOFF.md, "Video effects".` };
    }
  }
  return { ready: true, message: 'Ready' };
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out'));
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `Exited with code ${code}`));
    });
  });
}

let catalog: EffectInfo[] | null = null;

/** The effects the engine offers, read from the engine itself so the list never drifts from what it can render. */
export async function listEffects(): Promise<EffectInfo[]> {
  if (catalog) return catalog;
  const { python, script } = enginePaths();
  const { stdout } = await run(python, [script, '--list'], { timeoutMs: 60_000 });
  const found: EffectInfo[] = [];
  for (const line of stdout.toString().split(/\r?\n/)) {
    const m = /^\s*\d+\.\s+(\S+)\s+(.*)$/.exec(line);
    if (m) found.push({ name: m[1], description: m[2].trim() });
  }
  catalog = found;
  return found;
}

/** For tests: forget the cached list. */
export const resetEffectCatalog = () => {
  catalog = null;
};

// ---- the effect plan ------------------------------------------------------------------------------------
const optionKey = /^[a-z][a-z0-9_]{0,30}$/;
export const stepSchema = z.object({
  fx: z.string().regex(/^[a-z0-9-]{1,40}$/),
  start: z.number().min(0).max(36_000),
  end: z.number().min(0).max(36_000),
  text: z.string().max(400).optional(),
  /** Other options of the effect: color, grade, zoom, title... */
  options: z.record(z.string().regex(optionKey), z.union([z.string().max(400), z.number()])).default({}),
});
export type Step = z.infer<typeof stepSchema>;

export const labelSchema = z.object({ enabled: z.boolean().default(false), text: z.string().max(80).default(DEFAULT_LABEL) });
export type Label = z.infer<typeof labelSchema>;

/** The JSON plan the engine reads. Fails with a plain message when an effect is unknown or its times are wrong. */
export async function buildPlan(steps: Step[]): Promise<string> {
  if (steps.length === 0) throw badRequest('Add at least one effect');
  const known = new Set((await listEffects()).map((e) => e.name));
  const effects = steps.map((s) => {
    if (!known.has(s.fx)) throw badRequest(`Unknown effect "${s.fx}"`);
    if (s.end <= s.start) throw badRequest(`${s.fx}: the end time must be after the start time`);
    return { ...s.options, fx: s.fx, start: s.start, end: s.end, ...(s.text ? { text: s.text } : {}) };
  });
  return JSON.stringify({ effects });
}

// ---- uploaded videos ------------------------------------------------------------------------------------
/** The effects and label chosen for a video, kept with it so both editors see the same edit. */
export interface EditPlan {
  steps: Step[];
  label: Label;
}

export interface EditVideo {
  id: string;
  name: string;
  durationSec: number | null;
  workspaceId: string | null;
  createdAt: string;
  kind: 'source' | 'result';
  plan?: EditPlan;
  /** A name the team chooses; falls back to the file name. */
  title?: string;
  addedBy?: string;
}

const VIDEO_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
export const EDIT_UPLOAD_TYPES = Object.keys(VIDEO_TYPES);
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export { MAX_UPLOAD_BYTES };

const dir = (...p: string[]) => path.join(config.editDir, ...p);
const isId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

async function duration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 30_000 });
    const n = Number.parseFloat(stdout.toString());
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  } catch {
    return null;
  }
}

async function writeRecord(v: EditVideo): Promise<void> {
  await fs.writeFile(dir('videos', `${v.id}.json`), JSON.stringify(v));
}

export async function saveUpload(body: Buffer, contentType: string, name: string, workspaceId: string | null, addedBy = ''): Promise<EditVideo> {
  const ext = VIDEO_TYPES[contentType];
  if (!ext) throw badRequest('Use an MP4, MOV or WebM video.');
  if (body.length === 0) throw badRequest('The file is empty');
  const id = crypto.randomUUID();
  await fs.mkdir(dir('videos'), { recursive: true });
  const file = dir('videos', id + ext);
  await fs.writeFile(file, body);
  const v: EditVideo = {
    id, name: name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'video', durationSec: await duration(file), workspaceId, createdAt: new Date().toISOString(), kind: 'source', addedBy: addedBy.slice(0, 80),
  };
  await writeRecord(v);
  return v;
}

export async function listVideos(workspaceId: string, isDefaultWorkspace: boolean): Promise<EditVideo[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir('videos'));
  } catch {
    return [];
  }
  const all: EditVideo[] = [];
  for (const n of names.filter((x) => x.endsWith('.json') && !x.endsWith('.words.json'))) {
    try {
      all.push(JSON.parse(await fs.readFile(dir('videos', n), 'utf8')) as EditVideo);
    } catch {
      /* a half-written record: skip it */
    }
  }
  return all
    .filter((v) => v.workspaceId === workspaceId || (isDefaultWorkspace && !v.workspaceId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function videoFile(id: string): Promise<{ file: string; record: EditVideo }> {
  if (!isId(id)) throw notFound('Video not found');
  let record: EditVideo;
  try {
    record = JSON.parse(await fs.readFile(dir('videos', `${id}.json`), 'utf8')) as EditVideo;
  } catch {
    throw notFound('Video not found');
  }
  for (const ext of Object.values(VIDEO_TYPES)) {
    const file = dir('videos', id + ext);
    try {
      await fs.access(file);
      return { file, record };
    } catch {
      /* try the next extension */
    }
  }
  throw notFound('Video not found');
}

export async function getVideo(id: string): Promise<EditVideo> {
  return (await videoFile(id)).record;
}

// ---- transcript (runs on this computer, free) -------------------------------------------------------------
export interface Word {
  w: string;
  s: number;
  e: number;
}

/** Each word with when it starts and ends. Made once with the skill's words.py (faster-whisper), then kept beside the video. */
export async function getWords(videoId: string): Promise<Word[]> {
  const { file } = await videoFile(videoId);
  const out = file.replace(/\.[^.]+$/, '.words.json');
  try {
    return JSON.parse(await fs.readFile(out, 'utf8')) as Word[];
  } catch {
    /* not transcribed yet */
  }
  const { python, fonts } = enginePaths();
  const script = path.join(path.dirname(fonts), 'scripts', 'words.py');
  try {
    await fs.access(script);
  } catch {
    throw badRequest('The transcriber is missing (scripts/words.py in the effects skill). See docs/HANDOFF.md, "Video effects".');
  }
  try {
    await run(python, [script, path.resolve(file)], { timeoutMs: 20 * 60_000 });
  } catch (e) {
    throw new HttpError(502, `Could not transcribe this video: ${e instanceof Error ? e.message : String(e)}`, 'transcribe_failed');
  }
  return JSON.parse(await fs.readFile(out, 'utf8')) as Word[];
}

export async function renameVideo(id: string, title: string): Promise<EditVideo> {
  const { record } = await videoFile(id);
  record.title = title.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;
  await writeRecord(record);
  return record;
}

export const planSchema = z.object({ steps: z.array(stepSchema).max(30), label: labelSchema });

export async function savePlan(id: string, plan: EditPlan): Promise<EditVideo> {
  const { record } = await videoFile(id);
  record.plan = plan;
  await writeRecord(record);
  return record;
}

// ---- previews -------------------------------------------------------------------------------------------
/** One frame of the video with the effects applied at `time`. Quick, so options can be compared side by side. */
export async function previewFrame(videoId: string, steps: Step[], time: number, label: Label = { enabled: false, text: DEFAULT_LABEL }): Promise<Buffer> {
  if (steps.length === 0 && !label.enabled) throw badRequest('Add at least one effect or the label');
  const status = await engineStatus();
  if (!status.ready) throw badRequest(status.message);
  const { file } = await videoFile(videoId);
  // Absolute, because the label step runs from the fonts folder
  const work = path.resolve(dir('tmp', crypto.randomUUID()));
  await fs.mkdir(work, { recursive: true });
  try {
    let frame = path.join(work, 'frame.png');
    try {
      if (steps.length > 0) {
        const plan = await buildPlan(steps);
        await fs.writeFile(path.join(work, 'plan.json'), plan);
        const { python, script } = enginePaths();
        await run(python, [script, '--plan', path.join(work, 'plan.json'), path.resolve(file), frame, '--still', String(time)], { timeoutMs: 180_000 });
      } else {
        // Label only: the plain frame, so the label can be checked against the picture
        await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(time), '-i', path.resolve(file), '-frames:v', '1', frame], { timeoutMs: 60_000 });
      }
      if (label.enabled) {
        const labeled = path.join(work, 'labeled.png');
        await run('ffmpeg', ['-v', 'error', '-y', '-i', frame, '-vf', labelFilter(label.text), '-frames:v', '1', labeled], { cwd: enginePaths().fonts, timeoutMs: 60_000 });
        frame = labeled;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw badRequest(`The preview failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return await fs.readFile(frame);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

// ---- the dramatization label ---------------------------------------------------------------------------
/** Plain letters, numbers and a few marks only, so the text can never alter the ffmpeg command. */
export const cleanLabel = (t: string) => t.replace(/[^A-Za-z0-9 .,|\-/]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || DEFAULT_LABEL;

/** A solid bar across the bottom of the picture with the text centred in it, visible for the whole video. */
export function labelFilter(text: string): string {
  const t = cleanLabel(text);
  // The size shrinks with longer text (this font is about 0.75 of its size wide per letter) so the whole label stays inside the picture.
  const size = `min(h*0.032\\,w*0.9/(${t.length}*0.75))`; // the comma is escaped so the filter list does not split on it
  // drawbox names the picture size ih/iw, drawtext names it h/w.
  return `drawbox=x=0:y=ih-ih*0.075:w=iw:h=ih*0.075:color=black@0.78:t=fill,drawtext=fontfile=ArchivoBlack-Regular.ttf:text='${t}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=h-h*0.075/2-text_h/2`;
}

async function addLabel(input: string, output: string, text: string): Promise<void> {
  const { fonts } = enginePaths();
  await run('ffmpeg', ['-v', 'error', '-y', '-i', path.resolve(input), '-vf', labelFilter(text), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', path.resolve(output)], {
    cwd: fonts, // the font is found by its file name, which avoids drive-letter escaping in the filter
    timeoutMs: 600_000,
  });
}

// ---- rendering ------------------------------------------------------------------------------------------
export interface RenderJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  message: string;
  fileName?: string;
  mediaId?: string;
}
const jobs = new Map<string, RenderJob>();
export const getJob = (id: string) => jobs.get(id) ?? null;

export interface RenderInput {
  orgId: string;
  workspaceId: string | null;
  videoId: string;
  steps: Step[];
  label: Label;
}

/** Starts the render in the background and returns at once; poll the job for progress. */
export async function startRender(r: RenderInput): Promise<RenderJob> {
  const status = await engineStatus();
  if (!status.ready) throw badRequest(status.message);
  if (r.steps.length === 0 && !r.label.enabled) throw badRequest('Add at least one effect or the label');
  const { file, record } = await videoFile(r.videoId);
  const plan = r.steps.length > 0 ? await buildPlan(r.steps) : null;
  const job: RenderJob = { id: crypto.randomUUID(), status: 'running', message: 'Rendering the effects. This takes a few minutes.' };
  jobs.set(job.id, job);
  void (async () => {
    const work = dir('tmp', job.id);
    try {
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(dir('out'), { recursive: true });
      let rendered = path.resolve(file);
      if (plan) {
        await fs.writeFile(path.join(work, 'plan.json'), plan);
        const { python, script } = enginePaths();
        rendered = path.join(work, 'effects.mp4');
        await run(python, [script, '--plan', path.join(work, 'plan.json'), path.resolve(file), rendered], { timeoutMs: 60 * 60_000 });
      }
      const id = crypto.randomUUID();
      const finalFile = dir('out', `${id}.mp4`);
      if (r.label.enabled) {
        job.message = 'Adding the label';
        await addLabel(rendered, finalFile, r.label.text);
      } else {
        await fs.copyFile(rendered, finalFile);
      }
      const title = `${record.name.replace(/\.[^.]+$/, '')} (${[r.steps.length ? 'effects' : '', r.label.enabled ? 'labeled' : ''].filter(Boolean).join(', ')})`;
      const url = `/api/edit/files/${id}.mp4`;
      const { rows } = await getDb().query<{ id: string }>(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata, workspace_id) VALUES ($1,'video',$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
        [r.orgId, title, url, placeholderImage(title, 'video'), ['edit', 'effects'], JSON.stringify({ source: 'edit', effects: r.steps.map((s) => s.fx), labeled: r.label.enabled, sourceVideo: record.name }), r.workspaceId],
      );
      job.fileName = `${id}.mp4`;
      job.mediaId = rows[0].id;
      job.status = 'done';
      job.message = 'Done';
    } catch (e) {
      job.status = 'failed';
      job.message = e instanceof Error ? e.message : String(e);
      logger.warn('effects render failed', { err: job.message });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  })();
  return job;
}

/** Absolute path of a finished edit, or null when the name is not one we made. */
export function resultPath(fileName: string): string | null {
  const m = /^([0-9a-f-]{36})\.mp4$/.exec(fileName);
  return m && isId(m[1]) ? path.resolve(dir('out', fileName)) : null;
}
