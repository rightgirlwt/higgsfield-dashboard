import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../ctx';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { calcCostUsd, estimateTokens } from '../lib/pricing';
import { logger } from '../logger';
import { runPrompt } from './claude';
import { run } from './exec';
import { getSecret } from './secrets';
import { recordUsage } from './usage';
import { findTells, isLegalWorkspace, voiceRules } from './voices';
import { fingerprint, frameAt, probeFile } from './vault';
import { inWorkspace, type Workspace } from './workspaces';

/**
 * Study Session: reference videos (reels she likes, ones that did well) that Claude takes apart so she can build on what works.
 * Reading a video is free and runs here (length, where the picture cuts, a poster). Asking Claude to analyse it, to write a script
 * from the analysis, or to plan Vault reels in its style is only done after the price has been shown and approved.
 */

export const STUDY_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
/** A reference reel is short. Capping the length keeps the price of looking at it known. */
export const MAX_STUDY_SEC = 180;
const FRAMES = [0, 0.04, 0.1, 0.18, 0.28, 0.4, 0.52, 0.65, 0.8, 0.95];
const FRAME_BOX = 512;
const MAX_TRANSCRIPT_CHARS = 6000;

const dir = (...p: string[]) => path.join(config.studyDir, ...p);

// ---- what the analysis looks like ----------------------------------------------------------------------------

const text = (max: number) => z.string().default('').transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max));
const list = (max: number, each: number) => z.array(z.string()).default([]).transform((a) => a.map((s) => s.replace(/\s+/g, ' ').trim().slice(0, each)).filter(Boolean).slice(0, max));

const analysisSchema = z.object({
  summary: text(300),
  format: text(200),
  hook: z.object({ said: text(300), shown: text(300), technique: text(200), why: text(400) }).default({ said: '', shown: '', technique: '', why: '' }),
  structure: z
    .array(z.object({ at: z.coerce.number().default(0), label: text(60), what: text(300) }))
    .default([])
    .transform((a) => a.slice(0, 10).map((s) => ({ ...s, at: Math.max(0, Math.round(s.at * 10) / 10) }))),
  pacing: text(400),
  onScreenText: text(300),
  audio: text(300),
  cta: text(200),
  steal: list(6, 240),
  avoid: list(4, 240),
  template: text(900),
});
export type Analysis = z.infer<typeof analysisSchema>;

export function parseAnalysis(raw: string): Analysis {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw badRequest('Claude did not return an analysis. Try again.');
  let json: unknown;
  try {
    json = JSON.parse(m[0]);
  } catch {
    throw badRequest('Claude did not return an analysis. Try again.');
  }
  const p = analysisSchema.safeParse(json);
  if (!p.success || !p.data.summary) throw badRequest('Claude did not return an analysis. Try again.');
  return p.data;
}

const scriptSchema = z.object({
  title: text(100),
  hook: text(300),
  beats: z
    .array(z.object({ say: text(400), onScreen: text(120), shot: text(240), seconds: z.coerce.number().default(0) }))
    .default([])
    .transform((a) => a.slice(0, 12).map((b) => ({ ...b, seconds: Math.min(30, Math.max(0, Math.round(b.seconds * 10) / 10)) }))),
  caption: text(1800),
  notes: text(500),
});
export type Script = z.infer<typeof scriptSchema> & { id: string; topic: string; tells: string[]; createdAt: string };

export function parseScript(raw: string) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw badRequest('Claude did not return a script. Try again.');
  let json: unknown;
  try {
    json = JSON.parse(m[0]);
  } catch {
    throw badRequest('Claude did not return a script. Try again.');
  }
  const p = scriptSchema.safeParse(json);
  if (!p.success || p.data.beats.length === 0) throw badRequest('Claude did not return a script. Try again.');
  return p.data;
}

// ---- reading a video (free, local) ----------------------------------------------------------------------------

/** The seconds where the picture cuts to a different shot, by ffmpeg's scene detection. */
export async function findCuts(file: string): Promise<number[]> {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-vf', "select='gt(scene,0.3)',metadata=print:file=-", '-an', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 });
    const cuts = [...stdout.toString().matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100).filter((t) => t > 0.2);
    return [...new Set(cuts)];
  } catch (e) {
    logger.warn('study: cut detection failed', { error: (e as Error).message });
    return [];
  }
}

/** How fast the video moves, worked out from its cuts. Claude is told these numbers instead of guessing them from stills. */
export function pacingOf(durationSec: number | null, cuts: number[]) {
  const dur = durationSec && durationSec > 0 ? durationSec : 0;
  const shots = cuts.length + 1;
  return {
    shots,
    averageShotSec: dur ? Math.round((dur / shots) * 10) / 10 : null,
    cutsPer10s: dur ? Math.round((cuts.length / dur) * 100) / 10 : null,
    firstCutSec: cuts[0] ?? null,
  };
}

interface Ref {
  id: string;
  title: string;
  name: string;
  path: string;
  source_url: string;
  note: string;
  size_bytes: number | string;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  cuts: number[];
  meta: Partial<LinkMeta>;
  transcript: string | null;
  analysis: Analysis | null;
  scripts: Script[];
  cost_usd: number;
  created_at: string | Date;
}

const cleanTitle = (s: string) => s.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Reference reel';

/** What a link gave besides the video: the caption she would copy from, and the public numbers at the time. */
export interface LinkMeta {
  platform: string;
  uploader: string;
  caption: string;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  fetchedAt: string;
}

/**
 * Files a video that is already on disk. A copy of one already there is not added twice (its numbers are refreshed instead).
 * The file is removed again when it turns out to be a copy; the caller removes it if this throws.
 */
async function addReference(o: { orgId: string; workspaceId: string; file: string; name: string; sourceUrl?: string; meta?: LinkMeta }): Promise<{ id: string; duplicate: boolean }> {
  const stat = await fs.stat(o.file);
  const info = await probeFile(o.file);
  if (info.durationSec === null) throw badRequest('That file could not be read as a video.');
  if (info.durationSec > MAX_STUDY_SEC) throw badRequest(`Study Session takes reels up to ${MAX_STUDY_SEC / 60} minutes. This one is ${Math.round(info.durationSec)} seconds.`);
  const print = await fingerprint(o.file, stat.size);
  const db = getDb();
  const twin = await db.query<{ id: string }>('SELECT id FROM study_refs WHERE org_id=$1 AND fingerprint=$2 LIMIT 1', [o.orgId, print]);
  if (twin.rows[0]) {
    await fs.rm(o.file, { force: true });
    if (o.meta) await db.query(`UPDATE study_refs SET meta=$3::jsonb, source_url=CASE WHEN $4 <> '' THEN $4 ELSE source_url END WHERE id=$1 AND org_id=$2`, [twin.rows[0].id, o.orgId, JSON.stringify(o.meta), o.sourceUrl ?? '']);
    return { id: twin.rows[0].id, duplicate: true };
  }
  const cuts = await findCuts(o.file);
  const name = o.name.replace(/[^\w.\- ]+/g, '_') || 'reference.mp4';
  const title = o.meta ? [o.meta.uploader, o.meta.caption.split('\n')[0]].filter(Boolean).join(': ').slice(0, 90) : '';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO study_refs (org_id, workspace_id, title, name, path, size_bytes, duration_sec, width, height, fingerprint, cuts, source_url, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb) RETURNING id`,
    [o.orgId, o.workspaceId, title || cleanTitle(name), name.slice(0, 200), o.file, stat.size, info.durationSec, info.width, info.height, print, JSON.stringify(cuts), o.sourceUrl ?? '', JSON.stringify(o.meta ?? {})],
  );
  const id = rows[0].id;
  try {
    await fs.mkdir(dir('posters'), { recursive: true });
    await fs.writeFile(dir('posters', `${id}.jpg`), await frameAt(o.file, info.durationSec, 0.15, 360));
  } catch (e) {
    logger.warn('study: poster failed', { id, error: (e as Error).message });
  }
  return { id, duplicate: false };
}

export async function saveStudyUpload(o: { orgId: string; workspaceId: string; body: Buffer; contentType: string; name: string }) {
  if (!Object.prototype.hasOwnProperty.call(STUDY_TYPES, o.contentType)) throw badRequest('Use an MP4, MOV or WebM video.');
  if (o.body.length === 0) throw badRequest('The file is empty');
  await fs.mkdir(dir('videos'), { recursive: true });
  const file = path.resolve(dir('videos', `${crypto.randomUUID()}${STUDY_TYPES[o.contentType]}`));
  await fs.writeFile(file, o.body);
  try {
    return await addReference({ orgId: o.orgId, workspaceId: o.workspaceId, file, name: o.name });
  } catch (e) {
    await fs.rm(file, { force: true });
    throw e;
  }
}

// ---- from a link (free: the video is downloaded to this computer by yt-dlp) -------------------------------------

/** Only the places reels are posted. The link is handed to yt-dlp, so this also keeps the server from being pointed at anything else. */
const LINK_HOSTS = /^(?:[a-z0-9-]+\.)*(instagram\.com|tiktok\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch)$/i;

export function checkLink(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest('That does not look like a link. Paste the full address, starting with https://');
  }
  if (u.protocol !== 'https:') throw badRequest('Use the full https:// address of the reel.');
  if (u.username || u.password || !LINK_HOSTS.test(u.hostname)) throw badRequest('Study Session can open links from Instagram, TikTok, YouTube and Facebook.');
  return u;
}

const ytdlp = () => process.env.YTDLP_PATH || 'yt-dlp';
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

export function metaFrom(j: Record<string, unknown>, now = new Date()): LinkMeta {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');
  const ts = typeof j.timestamp === 'number' && j.timestamp > 0 ? new Date(j.timestamp * 1000).toISOString() : null;
  return {
    platform: str(j.extractor_key ?? j.extractor, 40).toLowerCase(),
    uploader: str(j.channel ?? j.uploader ?? j.uploader_id, 80),
    caption: str(j.description ?? j.title, 2200),
    postedAt: ts,
    likes: count(j.like_count),
    comments: count(j.comment_count),
    views: count(j.view_count),
    fetchedAt: now.toISOString(),
  };
}

function ytdlpFailure(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOENT/.test(msg)) throw new HttpError(501, 'Opening links needs yt-dlp on this computer (it is not installed). Upload the video file instead.', 'ytdlp_missing');
  if (/login|log in|private|cookies|rate-limit|not available|unavailable/i.test(msg)) throw badRequest('That site would not share this one (it may be private, or want a login). Save the video and upload the file instead.');
  throw new HttpError(502, `Could not open that link: ${msg.slice(0, 200)}`, 'link_failed');
}

/** Downloads the reel behind a link, with its caption and public numbers, and files it like an upload. */
export async function addFromLink(o: { orgId: string; workspaceId: string; url: string }) {
  const u = checkLink(o.url);
  const tmp = dir('incoming', crypto.randomUUID());
  await fs.mkdir(tmp, { recursive: true });
  try {
    let stdout: Buffer;
    try {
      ({ stdout } = await run(
        ytdlp(),
        ['--no-playlist', '--no-warnings', '--no-simulate', '--dump-single-json', '--max-filesize', '500M', '--match-filter', `duration<=?${MAX_STUDY_SEC}`, '-f', 'mp4/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', path.join(tmp, '%(id)s.%(ext)s'), '--', u.href],
        { timeoutMs: 4 * 60_000 },
      ));
    } catch (e) {
      ytdlpFailure(e);
    }
    const files = (await fs.readdir(tmp)).filter((f) => /\.(mp4|mov|webm|m4v)$/i.test(f));
    if (files.length === 0) throw badRequest(`Nothing was downloaded. The reel may be longer than ${MAX_STUDY_SEC / 60} minutes, or it is not a video.`);
    let meta: LinkMeta;
    try {
      meta = metaFrom(JSON.parse(stdout.toString()) as Record<string, unknown>);
    } catch {
      meta = metaFrom({});
    }
    await fs.mkdir(dir('videos'), { recursive: true });
    const file = path.resolve(dir('videos', `${crypto.randomUUID()}${path.extname(files[0]).toLowerCase() || '.mp4'}`));
    await fs.rename(path.join(tmp, files[0]), file);
    try {
      return await addReference({ orgId: o.orgId, workspaceId: o.workspaceId, file, name: files[0], sourceUrl: u.href, meta });
    } catch (e) {
      await fs.rm(file, { force: true });
      throw e;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Re-reads the caption and numbers from the original link (no download), so the numbers are as they are today. */
export async function refreshMeta(orgId: string, id: string) {
  const r = await load(orgId, id);
  if (!r.source_url) throw badRequest('This reel was uploaded, so there is no link to read the numbers from.');
  const u = checkLink(r.source_url);
  let stdout: Buffer;
  try {
    ({ stdout } = await run(ytdlp(), ['--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json', '--', u.href], { timeoutMs: 90_000 }));
  } catch (e) {
    ytdlpFailure(e);
  }
  const meta = metaFrom(JSON.parse(stdout.toString()) as Record<string, unknown>);
  await getDb().query('UPDATE study_refs SET meta=$3::jsonb WHERE id=$1 AND org_id=$2', [id, orgId, JSON.stringify(meta)]);
  return getStudy(orgId, id);
}
// ---- listing --------------------------------------------------------------------------------------------------

async function posterOf(id: string): Promise<string> {
  try {
    return `data:image/jpeg;base64,${(await fs.readFile(dir('posters', `${id}.jpg`))).toString('base64')}`;
  } catch {
    return '';
  }
}

const present = async (r: Ref) => ({
  id: r.id,
  title: r.title,
  name: r.name,
  sourceUrl: r.source_url,
  note: r.note,
  sizeBytes: Number(r.size_bytes),
  durationSec: r.duration_sec,
  width: r.width,
  height: r.height,
  pacing: pacingOf(r.duration_sec, r.cuts),
  cuts: r.cuts,
  meta: r.meta ?? {},
  transcribed: r.transcript !== null,
  transcript: r.transcript ?? '',
  analysis: r.analysis,
  scripts: r.scripts,
  costUsd: r.cost_usd,
  createdAt: new Date(r.created_at).toISOString(),
  poster: await posterOf(r.id),
});

export async function listStudies(orgId: string, ws: Workspace) {
  const params: unknown[] = [orgId];
  const { rows } = await getDb().query<Ref>(`SELECT s.* FROM study_refs s WHERE s.org_id=$1 AND ${inWorkspace(ws, 's', params)} ORDER BY s.created_at DESC LIMIT 200`, params);
  return Promise.all(rows.map(present));
}

async function load(orgId: string, id: string): Promise<Ref> {
  const { rows } = await getDb().query<Ref>('SELECT * FROM study_refs WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Reference video not found');
  return rows[0];
}

export const getStudy = async (orgId: string, id: string) => present(await load(orgId, id));

export const studyPatch = z.object({ title: z.string().trim().min(1).max(120).optional(), note: z.string().max(600).optional(), sourceUrl: z.string().trim().max(500).optional() });

export async function updateStudy(orgId: string, id: string, p: z.infer<typeof studyPatch>) {
  const r = await load(orgId, id);
  await getDb().query('UPDATE study_refs SET title=$3, note=$4, source_url=$5 WHERE id=$1 AND org_id=$2', [id, orgId, p.title ?? r.title, p.note ?? r.note, p.sourceUrl ?? r.source_url]);
  return getStudy(orgId, id);
}

export async function deleteStudy(orgId: string, id: string) {
  const r = await load(orgId, id);
  await getDb().query('DELETE FROM study_refs WHERE id=$1 AND org_id=$2', [id, orgId]);
  await fs.rm(dir('posters', `${id}.jpg`), { force: true });
  await fs.rm(r.path, { force: true });
}

export async function studyFile(id: string): Promise<string> {
  const { rows } = await getDb().query<{ path: string }>('SELECT path FROM study_refs WHERE id=$1', [id]);
  if (!rows[0]) throw notFound('Reference video not found');
  try {
    await fs.access(rows[0].path);
  } catch {
    throw notFound('The file is no longer on this computer.');
  }
  return rows[0].path;
}

// ---- the spoken words (free, local, only if the transcriber is set up) ------------------------------------------

/** What is said in the video, from the effects skill's transcriber. Empty when it is not set up or nothing is said. */
async function transcribe(file: string): Promise<string> {
  const isWin = process.platform === 'win32';
  const python = path.join(config.effectsDir, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python');
  const script = path.join(config.effectsDir, 'scripts', 'words.py');
  const out = file.replace(/\.[^.]+$/, '.words.json');
  try {
    await Promise.all([fs.access(python), fs.access(script)]);
    await run(python, [script, file], { timeoutMs: 15 * 60_000 });
    const words = JSON.parse(await fs.readFile(out, 'utf8')) as { w: string }[];
    return words.map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
  } catch (e) {
    logger.info('study: no transcript', { reason: (e as Error).message.slice(0, 160) });
    return '';
  } finally {
    await fs.rm(out, { force: true });
  }
}

// ---- analysing a video ------------------------------------------------------------------------------------------

const STUDY_MODEL = 'claude-sonnet-5-5';
const STUDY_MAX_OUT = 1800;
/** About 220 tokens a picture at this size. */
const FRAME_TOKENS = 220;

const ANALYSIS_SYSTEM =
  "You take apart a short social video so a creator can learn why it works and build her own. You are shown frames from the video in order, with the second each one comes from, then facts worked out by software (length, cuts, pace) and the spoken words when there are any. " +
  'You may also be given the post\'s caption and its public numbers. Use the caption to see the call to action and how the caption works with the video; the numbers only tell you how it landed, so never explain them. ' +
  'Describe only what you can see or were told. If something is not visible (the music, text that appears between the frames), say so instead of guessing. ' +
  'Be specific and concrete: "opens on a close-up of a hand slamming a laptop shut while saying a bold claim" teaches something, "has a strong hook" does not. ' +
  'Answer with only a JSON object: {"summary": one plain sentence on what the video is, "format": how it is made (talking head, voiceover over b-roll, text on screen...), ' +
  '"hook": {"said": the first line spoken or "" if none, "shown": what the first 2 seconds look like, "technique": the named trick (bold claim, open loop, contrast, mistake warning, direct address...), "why": why it makes someone stay}, ' +
  '"structure": [{"at": second it starts, "label": 2 to 4 words, "what": what happens and what it does for the viewer}] with 4 to 8 beats, ' +
  '"pacing": how fast it moves and how that helps, "onScreenText": how text is used (placement, size, when it appears), "audio": what you can tell about voice, music and sound, "cta": the call to action and where it lands (or "none"), ' +
  '"steal": 3 to 6 specific techniques she could reuse, each one sentence, "avoid": 0 to 3 things that would not transfer or would hurt her, ' +
  '"template": a fill-in-the-blank skeleton of the reel using [brackets] for what changes, with the timing of each part}.';

const frameTimes = (durationSec: number) => FRAMES.map((f) => Math.round(Math.max(0, Math.min(durationSec - 0.05, durationSec * f)) * 10) / 10);

/** The caption and public numbers, when the reel came from a link. Claude is told these are what the post earned, not why. */
function postedNote(r: Ref): string {
  const m = r.meta ?? {};
  if (!m.caption && m.likes == null && m.comments == null && m.views == null) return '';
  const nums = [m.likes != null ? `${m.likes} likes` : '', m.comments != null ? `${m.comments} comments` : '', m.views != null ? `${m.views} views` : ''].filter(Boolean).join(', ');
  return (
    `\nPosted by: ${m.uploader || 'unknown'}${m.postedAt ? ` on ${m.postedAt.slice(0, 10)}` : ''}` +
    (nums ? `\nPublic numbers when fetched: ${nums} (the platform may hide views; do not guess a reach or say why it performed, only what the post itself does)` : '') +
    (m.caption ? `\nIts caption:\n${m.caption.slice(0, 2200)}` : '')
  );
}

const likedNote = (r: Ref) => (r.note ? `\nWhat she liked about it: ${r.note}` : '');

/** Free: what looking at this video would cost. Nothing is spent until `approved`. */
export async function analyseStudy(orgId: string, id: string, approved: boolean) {
  const r = await load(orgId, id);
  const dur = r.duration_sec ?? 0;
  const spokenGuess = r.transcript === null ? 400 : estimateTokens(r.transcript.slice(0, MAX_TRANSCRIPT_CHARS));
  const inputTokens = estimateTokens(ANALYSIS_SYSTEM) + FRAMES.length * FRAME_TOKENS + spokenGuess + estimateTokens(postedNote(r)) + 450;
  const estimateUsd = calcCostUsd(STUDY_MODEL, inputTokens, Math.round(STUDY_MAX_OUT * 0.6));
  const maxUsd = calcCostUsd(STUDY_MODEL, Math.round(inputTokens * 1.3), STUDY_MAX_OUT);
  const keyMissing = !(await getSecret(orgId, 'anthropic'));
  if (!approved) return { approved: false as const, model: STUDY_MODEL, frames: FRAMES.length, seconds: dur, again: !!r.analysis, estimateUsd, maxUsd, keyMissing };
  if (keyMissing) throw badRequest('Add your Anthropic key in Settings to study this video with Claude.');

  let spoken = r.transcript;
  if (spoken === null) {
    spoken = await transcribe(r.path);
    await getDb().query('UPDATE study_refs SET transcript=$3 WHERE id=$1 AND org_id=$2', [id, orgId, spoken]);
  }
  const times = frameTimes(dur);
  const images = await Promise.all(times.map(async (t) => ({ data: (await frameAt(r.path, dur, dur ? t / dur : 0, FRAME_BOX)).toString('base64') })));
  const pace = pacingOf(r.duration_sec, r.cuts);
  const user =
    `Video: ${r.title}\nLength: ${Math.round(dur * 10) / 10} seconds${r.width && r.height ? `, ${r.width}x${r.height}${r.height > r.width ? ' (vertical)' : ''}` : ''}\n` +
    `Frames shown, in order, from these seconds: ${times.join(', ')}\n` +
    `Found by software: ${pace.shots} shot${pace.shots === 1 ? '' : 's'}, average shot ${pace.averageShotSec ?? '?'} s, ${pace.cutsPer10s ?? '?'} cuts per 10 seconds, first cut at ${pace.firstCutSec ?? 'none'} s${r.cuts.length ? `; cuts at ${r.cuts.slice(0, 30).join(', ')} s` : ''}\n` +
    `Spoken words: ${spoken ? spoken.slice(0, MAX_TRANSCRIPT_CHARS) : '(none found, or the transcriber is not set up)'}` +
    likedNote(r) +
    postedNote(r);
  const res = await runPrompt(orgId, { model: STUDY_MODEL, system: ANALYSIS_SYSTEM, user, maxTokens: STUDY_MAX_OUT, images });
  await recordUsage({ orgId, provider: 'claude', model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, simulated: res.simulated });
  const analysis = parseAnalysis(res.text);
  await getDb().query('UPDATE study_refs SET analysis=$3::jsonb, cost_usd=cost_usd+$4 WHERE id=$1 AND org_id=$2', [id, orgId, JSON.stringify(analysis), res.costUsd]);
  return { approved: true as const, costUsd: res.costUsd, study: await getStudy(orgId, id) };
}

// ---- writing something new from a study --------------------------------------------------------------------------

/** The analysis as a few plain lines, for another prompt to build on. */
function playbookLines(r: Ref): string {
  const a = r.analysis;
  if (!a) return '';
  return [
    `Reel "${r.title}": ${a.summary}`,
    `  Format: ${a.format}`,
    `  Hook: ${a.hook.technique}${a.hook.said ? ` (said: "${a.hook.said}")` : ''}. ${a.hook.why}`,
    `  Structure: ${a.structure.map((s) => `${s.at}s ${s.label}`).join(' > ')}`,
    `  Pacing: ${a.pacing}`,
    `  Reuse: ${a.steal.join(' / ')}`,
    a.template ? `  Skeleton: ${a.template}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The studied reels as one block of notes, and their titles, for Vault reel planning. */
export async function playbookFor(orgId: string, ws: Workspace, ids: string[]): Promise<{ titles: string[]; text: string }> {
  const unique = [...new Set(ids)].slice(0, 3);
  const params: unknown[] = [orgId, unique];
  const { rows } = await getDb().query<Ref>(`SELECT s.* FROM study_refs s WHERE s.org_id=$1 AND s.id = ANY($2::uuid[]) AND ${inWorkspace(ws, 's', params)}`, params);
  const studied = unique.map((id) => rows.find((r) => r.id === id)).filter((r): r is Ref => !!r && !!r.analysis);
  if (studied.length === 0) throw badRequest('Study a reference video first (Study Session), then use it here.');
  return { titles: studied.map((r) => r.title), text: studied.map(playbookLines).join('\n\n') };
}

const SCRIPT_MODEL = 'claude-sonnet-5-5';
const SCRIPT_MAX_OUT = 1600;

const SCRIPT_TASK =
  'You write a new short-form video script for a creator, built on the structure of a reference reel she studied. Keep what made the reference work: its hook technique, its pacing, the order of its beats, how it uses on-screen text. ' +
  'Do not reuse its words, its examples or its subject. The topic is hers. Write it to be spoken: short sentences, how she actually talks, 5 to 8 beats, 20 to 45 seconds in all. ' +
  'The first line is the hook and must create personal stakes for the viewer within two seconds. Use only facts she gave you; never invent numbers, names, results or events. No placeholder brackets in the output. ' +
  'The caption complements the video and never retells it: the hook, 2 to 4 sentences of value, exactly one call to action, then at most 5 hashtags. ' +
  'The writing rules below are the ones she uses in Claude for this account. Follow them. ' +
  'Answer with only a JSON object {"title":"","hook":"","beats":[{"say":"what she says out loud","onScreen":"short text on screen or empty","shot":"what the camera shows","seconds":0}],"caption":"","notes":"one line on what you kept from the reference"}.';

const FALLBACK = 'Voice: bold, direct, warm, short punchy lines, one call to action, no em dashes.';
const LEGAL =
  'This is the law firm account. Its legal advertising rules win over everything else: never a dollar amount, never "best", "#1" or "highest", never a promise of a result. Anything acted or staged needs a DRAMATIZATION label on screen (say so in "notes"). End any caption about a result with "Prior results do not guarantee a similar outcome."';

const scriptSystem = (ws: Workspace) => [SCRIPT_TASK, voiceRules(ws.name) || FALLBACK, ws.voice.trim() ? `How this account sounds, in the owner's words (these win over the general rules above where they differ): ${ws.voice.trim()}` : '', isLegalWorkspace(ws.name) ? LEGAL : ''].filter(Boolean).join('\n\n');

/** Free: what a script would cost. Nothing is spent until `approved`. */
export async function scriptFromStudy(orgId: string, ws: Workspace, id: string, o: { topic: string; approved: boolean }) {
  const r = await load(orgId, id);
  if (!r.analysis) throw badRequest('Study this video first, then write from it.');
  const system = scriptSystem(ws);
  const user = `Account: ${ws.name}\nHer topic: ${o.topic}\n\nThe reference reel she studied:\n${playbookLines(r)}`;
  const inputTokens = estimateTokens(system + user);
  const estimateUsd = calcCostUsd(SCRIPT_MODEL, inputTokens, Math.round(SCRIPT_MAX_OUT * 0.6));
  const maxUsd = calcCostUsd(SCRIPT_MODEL, inputTokens, SCRIPT_MAX_OUT);
  const keyMissing = !(await getSecret(orgId, 'anthropic'));
  if (!o.approved) return { approved: false as const, model: SCRIPT_MODEL, estimateUsd, maxUsd, keyMissing };
  if (keyMissing) throw badRequest('Add your Anthropic key in Settings to write the script.');
  const res = await runPrompt(orgId, { model: SCRIPT_MODEL, system, user, maxTokens: SCRIPT_MAX_OUT });
  await recordUsage({ orgId, provider: 'claude', model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, simulated: res.simulated });
  const made = parseScript(res.text);
  const tells = findTells([made.hook, ...made.beats.map((b) => b.say), made.caption].join('\n')).map((t) => `${t.rule}: "${t.line}"`);
  const script: Script = { ...made, id: crypto.randomUUID(), topic: o.topic, tells, createdAt: new Date().toISOString() };
  const kept = [script, ...r.scripts].slice(0, 20);
  await getDb().query('UPDATE study_refs SET scripts=$3::jsonb, cost_usd=cost_usd+$4 WHERE id=$1 AND org_id=$2', [id, orgId, JSON.stringify(kept), res.costUsd]);
  return { approved: true as const, costUsd: res.costUsd, script };
}

export async function deleteScript(orgId: string, id: string, scriptId: string) {
  const r = await load(orgId, id);
  const kept = r.scripts.filter((s) => s.id !== scriptId);
  if (kept.length === r.scripts.length) throw notFound('Script not found');
  await getDb().query('UPDATE study_refs SET scripts=$3::jsonb WHERE id=$1 AND org_id=$2', [id, orgId, JSON.stringify(kept)]);
}

