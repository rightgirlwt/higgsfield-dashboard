import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../ctx';
import { badRequest, notFound } from '../lib/errors';
import { calcCostUsd, estimateTokens } from '../lib/pricing';
import { logger } from '../logger';
import { runPrompt } from './claude';
import { run } from './exec';
import { getSecret } from './secrets';
import { recordUsage } from './usage';
import { inWorkspace, type Workspace } from './workspaces';

/**
 * The Content Vault: raw footage from a folder on this computer or uploaded in the browser, found here for free
 * (length, size, the day it was filmed, whether it has sound, duplicates). Claude is only used to sort clips into folders
 * and to plan reels, and only after the price has been shown and approved.
 */

export const VAULT_FOLDERS = ['Talking head', 'Desk', 'Studio', 'Close-ups', 'On the go', 'Outdoors', 'Events', 'Food & drink', 'Screen recording', 'Other'] as const;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
export const UPLOAD_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
const MAX_SCAN_FILES = 5000;

const dir = (...p: string[]) => path.join(config.vaultDir, ...p);

// ---- pure helpers (tested) ------------------------------------------------------------------------------

/** The calendar day (YYYY-MM-DD) on this computer's clock. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * When a clip was filmed, from what ffprobe found in the file. iPhones write the local time with its offset
 * ("2026-10-28T18:22:14-0400"), so its day is the day as it was where the clip was filmed. Other cameras write UTC.
 */
export function shotTime(tags: Record<string, unknown> | undefined): { at: Date; day: string } | null {
  const apple = tags?.['com.apple.quicktime.creationdate'];
  if (typeof apple === 'string') {
    const m = apple.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/);
    const at = new Date(apple.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (m && !Number.isNaN(at.getTime()) && at.getFullYear() > 2000) return { at, day: m[1] };
  }
  const created = tags?.creation_time;
  if (typeof created === 'string') {
    const at = new Date(created);
    if (!Number.isNaN(at.getTime()) && at.getFullYear() > 2000) return { at, day: localDay(at) };
  }
  return null;
}

/** Clips of 90 degrees portrait are stored sideways with a rotation note; this returns the size as it plays. */
export function playedSize(w: number | null, h: number | null, rotation: number): { width: number | null; height: number | null } {
  return Math.abs(rotation) % 180 === 90 ? { width: h, height: w } : { width: w, height: h };
}

const folderOf = (v: string): string => VAULT_FOLDERS.find((f) => f.toLowerCase() === v.trim().toLowerCase()) ?? 'Other';

export interface SortResult {
  folder: string;
  tags: string[];
  description: string;
}

export function parseSort(text: string): SortResult | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const p = z.object({ folder: z.string(), tags: z.array(z.string()).default([]), description: z.string().default('') }).safeParse(raw);
  if (!p.success) return null;
  const tags = [...new Set(p.data.tags.map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 8);
  return { folder: folderOf(p.data.folder), tags, description: p.data.description.trim().slice(0, 200) };
}

export interface ReelBeat {
  clipId: string;
  line: string;
  seconds: number;
}
export interface ReelIdea {
  title: string;
  style: 'vlog' | 'topic';
  day: string | null;
  hook: string;
  beats: ReelBeat[];
  caption: string;
  why: string;
}
export interface CatalogClip {
  key: string; // the short id Claude sees: c1, c2, ...
  id: string;
  durationSec: number | null;
}

/** Keeps only what the footage supports: a beat must name a clip that was offered, and last no longer than that clip. */
export function parseReels(text: string, catalog: CatalogClip[]): ReelIdea[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw badRequest('Claude did not return reel ideas. Try again.');
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    throw badRequest('Claude did not return reel ideas. Try again.');
  }
  const parsed = z
    .array(
      z.object({
        title: z.string(),
        style: z.string().default('topic'),
        day: z.string().nullable().optional(),
        hook: z.string().default(''),
        beats: z.array(z.object({ clip: z.string(), line: z.string().default(''), seconds: z.number().default(3) })),
        caption: z.string().default(''),
        why: z.string().default(''),
      }),
    )
    .safeParse(raw);
  if (!parsed.success) throw badRequest('Claude did not return reel ideas. Try again.');
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const ideas: ReelIdea[] = [];
  for (const r of parsed.data) {
    const beats: ReelBeat[] = [];
    for (const b of r.beats) {
      const clip = byKey.get(b.clip.trim().toLowerCase());
      if (!clip) continue;
      const cap = Math.min(8, clip.durationSec ?? 8);
      beats.push({ clipId: clip.id, line: b.line.trim().slice(0, 140), seconds: Math.round(Math.max(1, Math.min(cap, b.seconds)) * 10) / 10 });
    }
    if (beats.length < 3) continue;
    const day = typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) ? r.day : null;
    const style = r.style === 'vlog' ? 'vlog' : 'topic';
    ideas.push({ title: r.title.trim().slice(0, 100) || 'Untitled reel', style, day: style === 'vlog' ? day : null, hook: r.hook.trim().slice(0, 200), beats: beats.slice(0, 10), caption: r.caption.trim().slice(0, 1500), why: r.why.trim().slice(0, 400) });
  }
  return ideas.slice(0, 8);
}

// ---- reading a clip (free, local) -----------------------------------------------------------------------

export interface Probe {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  shot: { at: Date; day: string } | null;
}

export async function probeFile(file: string): Promise<Probe> {
  return probe(file);
}

async function probe(file: string): Promise<Probe> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 30_000 });
    const j = JSON.parse(stdout.toString()) as { format?: { duration?: string; tags?: Record<string, unknown> }; streams?: { width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[] };
    const s = j.streams?.[0];
    const rotation = Number(s?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? s?.tags?.rotate ?? 0) || 0;
    const size = playedSize(s?.width ?? null, s?.height ?? null, rotation);
    const dur = Number.parseFloat(j.format?.duration ?? '');
    return { durationSec: Number.isFinite(dur) ? Math.round(dur * 100) / 100 : null, ...size, shot: shotTime(j.format?.tags) };
  } catch {
    return { durationSec: null, width: null, height: null, shot: null };
  }
}

/** The average loudness, or null when the clip has no sound. Anything above about -35 dB is something you can hear. */
async function loudness(file: string): Promise<number | null> {
  try {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-t', '120', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 90_000 });
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The same file found twice: its size plus its first and last 64 KB. */
async function fingerprint(file: string, size: number): Promise<string> {
  const h = crypto.createHash('sha1').update(String(size));
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(65_536);
    for (const pos of [0, Math.max(0, size - 65_536)]) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

/** A JPEG of the clip at a fraction of its length, no bigger than `box` pixels either way. */
async function frameAt(file: string, durationSec: number | null, fraction: number, box: number): Promise<Buffer> {
  const t = durationSec ? Math.max(0, durationSec * fraction) : 0;
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${box}:${box}:force_original_aspect_ratio=decrease`, '-q:v', '5', '-f', 'mjpeg', '-'], { timeoutMs: 60_000 });
  if (stdout.length === 0) throw new Error('No picture');
  return stdout;
}

// ---- adding clips ---------------------------------------------------------------------------------------

export interface ClipRow {
  id: string;
  name: string;
  path: string;
  source: 'folder' | 'upload';
  size_bytes: number | string;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  shot_at: string | Date;
  shot_date: string;
  audio_db: number | null;
  duplicate_of: string | null;
  folder: string;
  tags: string[];
  description: string;
  status: 'new' | 'sorted';
}

/** Reads one file and files it in the Vault. A copy of a clip already there is kept but marked as a duplicate. */
async function ingest(o: { orgId: string; workspaceId: string; file: string; name: string; source: 'folder' | 'upload'; shotHint?: Date }): Promise<{ id: string; duplicate: boolean }> {
  const stat = await fs.stat(o.file);
  const [info, audioDb, print] = await Promise.all([probe(o.file), loudness(o.file), fingerprint(o.file, stat.size)]);
  const hint = o.shotHint && !Number.isNaN(o.shotHint.getTime()) && o.shotHint.getFullYear() > 2000 ? o.shotHint : stat.mtime;
  const shot = info.shot ?? { at: hint, day: localDay(hint) };
  const db = getDb();
  const first = await db.query<{ id: string }>(`SELECT id FROM vault_clips WHERE org_id=$1 AND fingerprint=$2 AND duplicate_of IS NULL ORDER BY created_at LIMIT 1`, [o.orgId, print]);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO vault_clips (org_id, workspace_id, name, path, source, size_bytes, duration_sec, width, height, shot_at, shot_date, audio_db, fingerprint, duplicate_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [o.orgId, o.workspaceId, o.name.slice(0, 200), o.file, o.source, stat.size, info.durationSec, info.width, info.height, shot.at.toISOString(), shot.day, audioDb, print, first.rows[0]?.id ?? null],
  );
  const id = rows[0].id;
  try {
    await fs.mkdir(dir('thumbs'), { recursive: true });
    await fs.writeFile(dir('thumbs', `${id}.jpg`), await frameAt(o.file, info.durationSec, 0.3, 320));
  } catch (e) {
    logger.warn('vault thumbnail failed', { id, error: (e as Error).message });
  }
  return { id, duplicate: !!first.rows[0] };
}

const CONTENT_TYPE_OK = (t: string) => Object.prototype.hasOwnProperty.call(UPLOAD_TYPES, t);

export async function saveVaultUpload(o: { orgId: string; workspaceId: string; body: Buffer; contentType: string; name: string; shotHint?: Date }) {
  if (!CONTENT_TYPE_OK(o.contentType)) throw badRequest('Use an MP4, MOV or WebM video.');
  if (o.body.length === 0) throw badRequest('The file is empty');
  await fs.mkdir(dir('clips'), { recursive: true });
  const file = path.resolve(dir('clips', `${crypto.randomUUID()}${UPLOAD_TYPES[o.contentType]}`));
  await fs.writeFile(file, o.body);
  try {
    return await ingest({ orgId: o.orgId, workspaceId: o.workspaceId, file, name: o.name.replace(/[^\w.\- ]+/g, '_') || 'clip', source: 'upload', shotHint: o.shotHint });
  } catch (e) {
    await fs.rm(file, { force: true });
    throw e;
  }
}

// ---- jobs (in memory, polled by the page, like renders) -------------------------------------------------

export interface VaultJob {
  id: string;
  kind: 'scan' | 'sort';
  state: 'running' | 'done' | 'error';
  total: number;
  done: number;
  added: number;
  duplicates: number;
  failed: number;
  costUsd: number;
  note: string;
  error: string;
}
const jobs = new Map<string, VaultJob>();
export const getVaultJob = (id: string): VaultJob | undefined => jobs.get(id);

function newJob(kind: VaultJob['kind'], total: number): VaultJob {
  const job: VaultJob = { id: crypto.randomUUID(), kind, state: 'running', total, done: 0, added: 0, duplicates: 0, failed: 0, costUsd: 0, note: '', error: '' };
  jobs.set(job.id, job);
  if (jobs.size > 40) jobs.delete(jobs.keys().next().value as string);
  return job;
}

/** Runs `work` over `items`, `width` at a time. */
async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (d: string): Promise<void> => {
    if (found.length >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_SCAN_FILES) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) found.push(full);
    }
  };
  await visit(root);
  return found;
}

/** Starts reading every video in a folder (and the folders inside it). Clips already in the Vault are skipped. */
export async function scanFolder(orgId: string, ws: Workspace, folder: string): Promise<VaultJob> {
  if (!path.isAbsolute(folder)) throw badRequest('Give the full path of the folder, for example C:\\Users\\you\\Videos\\Camera Roll.');
  const root = path.resolve(folder);
  try {
    if (!(await fs.stat(root)).isDirectory()) throw new Error();
  } catch {
    throw badRequest('That folder was not found on this computer.');
  }
  const files = await walk(root);
  if (files.length === 0) throw badRequest('No MP4, MOV, M4V or WebM videos were found in that folder.');
  const known = new Set((await getDb().query<{ path: string }>(`SELECT path FROM vault_clips WHERE org_id=$1 AND source='folder'`, [orgId])).rows.map((r) => r.path));
  const fresh = files.filter((f) => !known.has(f));
  const job = newJob('scan', fresh.length);
  job.note = `${files.length} videos in the folder, ${files.length - fresh.length} already in the Vault.`;
  void (async () => {
    try {
      await pool(fresh, 3, async (file) => {
        try {
          const r = await ingest({ orgId, workspaceId: ws.id, file, name: path.basename(file), source: 'folder' });
          if (r.duplicate) job.duplicates++;
          else job.added++;
        } catch (e) {
          job.failed++;
          logger.warn('vault scan: clip skipped', { file, error: (e as Error).message });
        }
        job.done++;
      });
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = (e as Error).message;
    }
  })();
  return job;
}

// ---- sorting with Claude --------------------------------------------------------------------------------

const SORT_MODEL = 'claude-haiku-5-5';
const SORT_MAX_OUT = 220;
const SORT_FRAMES = [0.15, 0.5, 0.85];
const SORT_BOX = 512;
/** About 200 tokens a picture at this size, plus the instructions and the clip's details. */
const SORT_IN_TOKENS = SORT_FRAMES.length * 220 + 420;
/** One run sorts at most this many clips, so one click can only ever spend a small, known amount. */
const SORT_BATCH = 500;

const SORT_SYSTEM =
  "You file a creator's raw phone footage into folders so she can find it later. You are shown three frames from one clip (near the start, middle and end). " +
  `Choose exactly one folder from: ${VAULT_FOLDERS.join(', ')}. ` +
  '"Talking head" is a person speaking to the camera. "Desk" is a laptop, desk or home-office shot. "Studio" is a set or studio space with lights or a backdrop. ' +
  '"Close-ups" are tight shots of an object, hands, a screen or a detail. "On the go" is moving through places: walking, driving, travelling. "Outdoors" is scenery or being outside while staying put. ' +
  '"Events" is people gathered, a stage, a room being spoken to. "Food & drink" is eating, drinking, cooking. "Screen recording" is a phone or computer screen. Use "Other" when none fit. ' +
  'Give 3 to 6 short lowercase tags (what is in it, the setting, the mood) and one plain sentence of at most 20 words saying what happens. ' +
  'Answer with only JSON: {"folder":"","tags":[],"description":""}';

async function unsortedIds(orgId: string, ws: Workspace): Promise<string[]> {
  const params: unknown[] = [orgId];
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT c.id FROM vault_clips c WHERE c.org_id=$1 AND ${inWorkspace(ws, 'c', params)} AND c.status='new' AND c.duplicate_of IS NULL ORDER BY c.shot_at DESC LIMIT ${SORT_BATCH}`,
    params,
  );
  return rows.map((r) => r.id);
}

/** Free: how many clips are waiting and what sorting them would cost. Nothing is spent until `approved`. */
export async function sortClips(orgId: string, ws: Workspace, approved: boolean) {
  const ids = await unsortedIds(orgId, ws);
  const estimateUsd = ids.length * calcCostUsd(SORT_MODEL, SORT_IN_TOKENS, SORT_MAX_OUT / 2);
  const maxUsd = ids.length * calcCostUsd(SORT_MODEL, Math.round(SORT_IN_TOKENS * 1.4), SORT_MAX_OUT);
  const keyMissing = !(await getSecret(orgId, 'anthropic'));
  if (!approved) return { approved: false as const, model: SORT_MODEL, clips: ids.length, estimateUsd, maxUsd, keyMissing };
  if (ids.length === 0) throw badRequest('Every clip is already sorted.');
  if (keyMissing) throw badRequest('Add your Anthropic key in Settings to sort with Claude.');
  const job = newJob('sort', ids.length);
  void (async () => {
    try {
      await pool(ids, 4, async (id) => {
        if (job.costUsd >= maxUsd) {
          job.note = 'Stopped at the approved maximum.';
          job.done++;
          return;
        }
        try {
          const { rows } = await getDb().query<ClipRow>('SELECT * FROM vault_clips WHERE id=$1 AND org_id=$2', [id, orgId]);
          const c = rows[0];
          if (!c) throw new Error('gone');
          const images = await Promise.all(SORT_FRAMES.map(async (f) => ({ data: (await frameAt(c.path, c.duration_sec, f, SORT_BOX)).toString('base64') })));
          const when = new Date(c.shot_at).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
          const user = `File: ${c.name}\nLength: ${c.duration_sec ?? '?'} seconds\nFilmed: ${when}\nSound: ${c.audio_db !== null && c.audio_db > -35 ? 'audible' : 'almost silent'}`;
          const res = await runPrompt(orgId, { model: SORT_MODEL, system: SORT_SYSTEM, user, maxTokens: SORT_MAX_OUT, images });
          await recordUsage({ orgId, provider: 'claude', model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, simulated: res.simulated });
          job.costUsd += res.costUsd;
          const sorted = parseSort(res.text);
          if (!sorted) throw new Error('unreadable answer');
          await getDb().query(`UPDATE vault_clips SET folder=$3, tags=$4, description=$5, status='sorted' WHERE id=$1 AND org_id=$2`, [id, orgId, sorted.folder, sorted.tags, sorted.description]);
        } catch (e) {
          job.failed++;
          logger.warn('vault sort: clip skipped', { id, error: (e as Error).message });
        }
        job.done++;
      });
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = (e as Error).message;
    }
  })();
  return { approved: true as const, job };
}

// ---- browsing -------------------------------------------------------------------------------------------

async function thumbOf(id: string): Promise<string> {
  try {
    return `data:image/jpeg;base64,${(await fs.readFile(dir('thumbs', `${id}.jpg`))).toString('base64')}`;
  } catch {
    return '';
  }
}

const mapClip = (c: ClipRow, thumb: string) => ({
  id: c.id,
  name: c.name,
  source: c.source,
  sizeBytes: Number(c.size_bytes),
  durationSec: c.duration_sec,
  width: c.width,
  height: c.height,
  shotAt: new Date(c.shot_at).toISOString(),
  shotDate: typeof c.shot_date === 'string' ? c.shot_date.slice(0, 10) : localDay(new Date(c.shot_date)),
  hasSound: c.audio_db !== null && c.audio_db > -35,
  duplicateOf: c.duplicate_of,
  folder: c.folder,
  tags: c.tags,
  description: c.description,
  sorted: c.status === 'sorted',
  thumb,
});

export interface ClipFilter {
  /** Only these clips (used by the editor to show the B-roll it has placed). */
  ids?: string[];
  folder?: string;
  day?: string;
  q?: string;
  /** hide (default), only, or all */
  duplicates?: string;
  unsorted?: boolean;
  limit?: number;
  offset?: number;
}

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listClips(orgId: string, ws: Workspace, f: ClipFilter) {
  const params: unknown[] = [orgId];
  const where = ['c.org_id=$1', inWorkspace(ws, 'c', params)];
  const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replace('?', `$${params.length}`)));
  if (f.ids) add('c.id = ANY(?::uuid[])', f.ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)).slice(0, 100));
  if (f.folder) add('c.folder = ?', f.folder);
  if (f.day && /^\d{4}-\d{2}-\d{2}$/.test(f.day)) add('c.shot_date = ?::date', f.day);
  if (f.unsorted) where.push("c.status = 'new'");
  if (f.q?.trim()) {
    params.push(`%${esc(f.q.trim())}%`);
    const n = `$${params.length}`;
    where.push(`(c.name ILIKE ${n} OR c.description ILIKE ${n} OR array_to_string(c.tags, ' ') ILIKE ${n})`);
  }
  if (f.duplicates === 'only') where.push('c.duplicate_of IS NOT NULL');
  else if (f.duplicates !== 'all') where.push('c.duplicate_of IS NULL');
  const limit = Math.min(Math.max(f.limit ?? 36, 1), 100);
  const offset = Math.max(f.offset ?? 0, 0);
  const db = getDb();
  const [list, total] = await Promise.all([
    db.query<ClipRow>(`SELECT c.*, c.shot_date::text AS shot_date FROM vault_clips c WHERE ${where.join(' AND ')} ORDER BY c.shot_at DESC, c.id LIMIT ${limit} OFFSET ${offset}`, params),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM vault_clips c WHERE ${where.join(' AND ')}`, params),
  ]);
  const items = await Promise.all(list.rows.map(async (c) => mapClip(c, await thumbOf(c.id))));
  return { items, total: total.rows[0].n };
}

export async function vaultStats(orgId: string, ws: Workspace) {
  const params: unknown[] = [orgId];
  const scope = `c.org_id=$1 AND ${inWorkspace(ws, 'c', params)}`;
  const db = getDb();
  const [totals, folders] = await Promise.all([
    db.query<{ clips: number; duplicates: number; unsorted: number; days: number; seconds: number }>(
      `SELECT COUNT(*) FILTER (WHERE duplicate_of IS NULL)::int AS clips, COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS duplicates,
              COUNT(*) FILTER (WHERE duplicate_of IS NULL AND status='new')::int AS unsorted, COUNT(DISTINCT shot_date) FILTER (WHERE duplicate_of IS NULL)::int AS days,
              COALESCE(SUM(duration_sec) FILTER (WHERE duplicate_of IS NULL),0)::float AS seconds
       FROM vault_clips c WHERE ${scope}`,
      params,
    ),
    db.query<{ folder: string; n: number }>(`SELECT folder, COUNT(*)::int AS n FROM vault_clips c WHERE ${scope} AND duplicate_of IS NULL AND status='sorted' GROUP BY folder ORDER BY n DESC, folder`, params),
  ]);
  return { ...totals.rows[0], folders: folders.rows };
}

/** One row per day footage was filmed, newest first, with how many clips, how long, what kind, and a few thumbnails. */
export async function listDays(orgId: string, ws: Workspace, limit = 60, offset = 0) {
  const params: unknown[] = [orgId];
  const scope = `c.org_id=$1 AND ${inWorkspace(ws, 'c', params)} AND c.duplicate_of IS NULL`;
  const db = getDb();
  const { rows } = await db.query<{ day: string; clips: number; seconds: number; first: string | Date; last: string | Date; folders: string[] }>(
    `SELECT c.shot_date::text AS day, COUNT(*)::int AS clips, COALESCE(SUM(c.duration_sec),0)::float AS seconds, MIN(c.shot_at) AS first, MAX(c.shot_at) AS last,
            COALESCE(array_agg(DISTINCT c.folder) FILTER (WHERE c.folder <> ''), '{}') AS folders
     FROM vault_clips c WHERE ${scope} GROUP BY c.shot_date ORDER BY c.shot_date DESC LIMIT ${Math.min(limit, 200)} OFFSET ${Math.max(offset, 0)}`,
    params,
  );
  if (rows.length === 0) return [];
  const sample = await db.query<{ id: string; day: string }>(
    `SELECT id, day FROM (SELECT c.id, c.shot_date::text AS day, row_number() OVER (PARTITION BY c.shot_date ORDER BY c.shot_at) AS rn FROM vault_clips c WHERE ${scope} AND c.shot_date::text = ANY($${params.length + 1}::text[])) t WHERE rn <= 4 ORDER BY day, rn`,
    [...params, rows.map((r) => r.day)],
  );
  const thumbs = new Map<string, string[]>();
  for (const s of sample.rows) thumbs.set(s.day, [...(thumbs.get(s.day) ?? []), await thumbOf(s.id)]);
  return rows.map((r) => ({ day: r.day, clips: r.clips, seconds: r.seconds, first: new Date(r.first).toISOString(), last: new Date(r.last).toISOString(), folders: r.folders, thumbs: thumbs.get(r.day) ?? [] }));
}

async function loadClip(orgId: string, id: string): Promise<ClipRow> {
  const { rows } = await getDb().query<ClipRow>('SELECT *, shot_date::text AS shot_date FROM vault_clips WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Clip not found');
  return rows[0];
}

export const clipPatch = z.object({ folder: z.string().refine((f) => (VAULT_FOLDERS as readonly string[]).includes(f), 'Pick one of the Vault folders').optional(), tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(), description: z.string().max(200).optional() });

export async function updateClip(orgId: string, id: string, p: z.infer<typeof clipPatch>) {
  const cur = await loadClip(orgId, id);
  const folder = p.folder ?? cur.folder;
  const tags = p.tags ? [...new Set(p.tags.map((t) => t.toLowerCase()))] : cur.tags;
  // A clip you filed by hand counts as sorted, so Claude is not asked (and paid) to sort it again.
  await getDb().query(`UPDATE vault_clips SET folder=$3::text, tags=$4, description=$5, status=CASE WHEN $3::text <> '' THEN 'sorted' ELSE status END WHERE id=$1 AND org_id=$2`, [id, orgId, folder, tags, p.description ?? cur.description]);
  const c = await loadClip(orgId, id);
  return mapClip(c, await thumbOf(id));
}

/** Removes the clip from the Vault. A file you uploaded is deleted with it; a file in your own folder is never touched. */
export async function deleteClip(orgId: string, id: string): Promise<void> {
  const c = await loadClip(orgId, id);
  await getDb().query('DELETE FROM vault_clips WHERE id=$1 AND org_id=$2', [id, orgId]);
  await fs.rm(dir('thumbs', `${id}.jpg`), { force: true });
  if (c.source === 'upload') await fs.rm(c.path, { force: true });
}

export async function clipFile(id: string): Promise<string> {
  const { rows } = await getDb().query<{ path: string }>('SELECT path FROM vault_clips WHERE id=$1', [id]);
  if (!rows[0]) throw notFound('Clip not found');
  try {
    await fs.access(rows[0].path);
  } catch {
    throw notFound('The file is no longer where the Vault found it.');
  }
  return rows[0].path;
}

export const clipExists = (orgId: string, id: string) => loadClip(orgId, id).then(() => true);

// ---- reel ideas -----------------------------------------------------------------------------------------

const REEL_MODEL = 'claude-sonnet-5-5';
const REEL_MAX_CLIPS = 150;

const VOICES = {
  glg:
    'Greene Legal Group (@thesuperlawyer), for injured people in Atlanta who do not know their rights. Authoritative, warm, community presence, short declarative lines, hooks with personal stakes. ' +
    'Never show or mention case results or dollar amounts. Anything staged or acted must carry an on-screen DRAMATIZATION label. One call to action only.',
  rgm: 'Right Girl Media: bold, direct, expert and warm. Short punchy lines, results-anchored, no fluff. One call to action only.',
};

const REEL_SYSTEM = (voice: string, count: number) =>
  "You plan Instagram Reels for a creator from the footage she already has. There are two kinds. 'vlog' is a day-in-the-life reel built only from clips filmed the same day, in the order they were filmed. " +
  "'topic' is a reel with a clear hook built around one theme, using clips from any day that fit it. Mix both kinds unless told otherwise. " +
  'Use only the clip ids given and never invent footage; if the clips do not support a reel, return fewer. ' +
  'Each reel has 4 to 8 beats and runs 15 to 45 seconds. A beat names one clip, a short line to show on screen or say (at most 14 words), and how many seconds of that clip to use (1 to 6, never more than the clip length). ' +
  'The first line is a hook that creates stakes or curiosity, not "let me explain". A caption is 2 to 4 sentences ending with one call to action, then at most 5 hashtags. ' +
  `Voice: ${voice} ` +
  `Return ${count} reels at most. Answer with only a JSON array of {"title","style":"vlog"|"topic","day":"YYYY-MM-DD" for vlog or null,"hook","beats":[{"clip","line","seconds"}],"caption","why"}, where "why" is one sentence on why it should work.`;

const voiceFor = (ws: Workspace) => (/greene|glg/i.test(ws.name) ? VOICES.glg : VOICES.rgm);

/** The sorted clips as lines Claude can read (c1, c2, ...), grouped by the day they were filmed, newest first. */
export async function catalogFor(orgId: string, ws: Workspace, day?: string) {
  const params: unknown[] = [orgId];
  const where = ['c.org_id=$1', inWorkspace(ws, 'c', params), "c.status='sorted'", 'c.duplicate_of IS NULL'];
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    params.push(day);
    where.push(`c.shot_date = $${params.length}::date`);
  }
  const { rows } = await getDb().query<ClipRow>(`SELECT c.*, c.shot_date::text AS shot_date FROM vault_clips c WHERE ${where.join(' AND ')} ORDER BY c.shot_date DESC, c.shot_at LIMIT ${REEL_MAX_CLIPS}`, params);
  const catalog: (CatalogClip & { folder: string })[] = [];
  const lines: string[] = [];
  let currentDay = '';
  for (const c of rows) {
    const key = `c${catalog.length + 1}`;
    catalog.push({ key, id: c.id, durationSec: c.duration_sec, folder: c.folder });
    if (c.shot_date !== currentDay) {
      currentDay = c.shot_date;
      const count = rows.filter((r) => r.shot_date === currentDay).length;
      lines.push(`\n== ${currentDay} (${new Date(`${currentDay}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })}) · ${count} clips ==`);
    }
    const time = new Date(c.shot_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    lines.push(`${key} | ${time} | ${Math.round(c.duration_sec ?? 0)}s | ${c.folder} | ${c.tags.join(', ')} | ${c.description}`);
  }
  return { catalog, text: lines.join('\n').trim(), days: new Set(rows.map((r) => r.shot_date)).size };
}

export interface ReelRow {
  id: string;
  title: string;
  style: 'vlog' | 'topic';
  day: string | null;
  hook: string;
  beats: ReelBeat[];
  caption: string;
  why: string;
  status: 'idea' | 'saved' | 'used';
  created_at: string | Date;
}

/** Free to call: says how many clips Claude would look at and what planning the reels would cost. Nothing is spent until `approved`. */
export async function suggestReels(orgId: string, ws: Workspace, o: { approved: boolean; day?: string; count: number }) {
  const { catalog, text, days } = await catalogFor(orgId, ws, o.day);
  if (catalog.length < 3) throw badRequest(o.day ? 'That day has fewer than 3 sorted clips.' : 'Sort at least 3 clips first, so Claude has footage to plan from.');
  const system = REEL_SYSTEM(voiceFor(ws), o.count);
  const user = `Footage (id | time | length | folder | tags | what happens):\n\n${text}`;
  const inputTokens = estimateTokens(system + user);
  const maxOut = o.count * 450 + 200;
  const estimateUsd = calcCostUsd(REEL_MODEL, inputTokens, Math.round(maxOut * 0.6));
  const maxUsd = calcCostUsd(REEL_MODEL, inputTokens, maxOut);
  const keyMissing = !(await getSecret(orgId, 'anthropic'));
  if (!o.approved) return { approved: false as const, model: REEL_MODEL, clips: catalog.length, days, estimateUsd, maxUsd, keyMissing };
  if (keyMissing) throw badRequest('Add your Anthropic key in Settings to get reel ideas.');
  const res = await runPrompt(orgId, { model: REEL_MODEL, system, user, maxTokens: maxOut });
  await recordUsage({ orgId, provider: 'claude', model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, simulated: res.simulated });
  const ideas = parseReels(res.text, catalog);
  if (ideas.length === 0) throw badRequest('Claude could not build a reel from these clips. Sort more footage and try again.');
  const saved: ReelRow[] = [];
  for (const i of ideas) {
    const { rows } = await getDb().query<ReelRow>(
      `INSERT INTO vault_reels (org_id, workspace_id, title, style, day, hook, beats, caption, why) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *, day::text AS day`,
      [orgId, ws.id, i.title, i.style, i.day, i.hook, JSON.stringify(i.beats), i.caption, i.why],
    );
    saved.push(rows[0]);
  }
  return { approved: true as const, costUsd: res.costUsd, reels: await withClips(orgId, saved) };
}

/** Reels with each beat's clip filled in (name, length, folder, thumbnail), or null where the clip has since been removed. */
async function withClips(orgId: string, reels: ReelRow[]) {
  const ids = [...new Set(reels.flatMap((r) => r.beats.map((b) => b.clipId)))];
  const clips = new Map<string, ReturnType<typeof mapClip>>();
  if (ids.length) {
    const { rows } = await getDb().query<ClipRow>(`SELECT *, shot_date::text AS shot_date FROM vault_clips WHERE org_id=$1 AND id = ANY($2::uuid[])`, [orgId, ids]);
    for (const c of rows) clips.set(c.id, mapClip(c, await thumbOf(c.id)));
  }
  return reels.map((r) => ({
    id: r.id,
    title: r.title,
    style: r.style,
    day: r.day,
    hook: r.hook,
    caption: r.caption,
    why: r.why,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    beats: r.beats.map((b) => ({ ...b, clip: clips.get(b.clipId) ?? null })),
  }));
}

export async function listReels(orgId: string, ws: Workspace) {
  const params: unknown[] = [orgId];
  const { rows } = await getDb().query<ReelRow>(`SELECT r.*, r.day::text AS day FROM vault_reels r WHERE r.org_id=$1 AND ${inWorkspace(ws, 'r', params)} ORDER BY r.created_at DESC LIMIT 60`, params);
  return withClips(orgId, rows);
}

export async function setReelStatus(orgId: string, id: string, status: 'idea' | 'saved' | 'used') {
  const { rowCount } = await getDb().query('UPDATE vault_reels SET status=$3 WHERE id=$1 AND org_id=$2', [id, orgId, status]);
  if (rowCount === 0) throw notFound('Reel not found');
}

export async function deleteReel(orgId: string, id: string) {
  const { rowCount } = await getDb().query('DELETE FROM vault_reels WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (rowCount === 0) throw notFound('Reel not found');
}
