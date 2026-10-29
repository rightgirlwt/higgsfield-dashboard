import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound } from '../lib/errors';
import { getVideo } from './effects';

export const BEAT_STATUSES = ['draft', 'in_review', 'changes_needed', 'approved'] as const;
export type BeatStatus = (typeof BEAT_STATUSES)[number];

export interface Adjustment {
  id: string;
  text: string;
  done: boolean;
}

export interface Beat {
  id: string;
  videoId: string;
  position: number;
  title: string;
  startSec: number;
  endSec: number;
  youSay: string;
  onScreen: string;
  visual: string;
  animation: string;
  status: BeatStatus;
  changeRequest: string;
  adjustments: Adjustment[];
  updatedAt: string;
}

const mapBeat = (r: any): Beat => ({
  id: r.id, videoId: r.video_id, position: r.position, title: r.title, startSec: r.start_sec, endSec: r.end_sec, youSay: r.you_say, onScreen: r.on_screen,
  visual: r.visual, animation: r.animation, status: r.status, changeRequest: r.change_request, adjustments: r.adjustments ?? [], updatedAt: new Date(r.updated_at).toISOString(),
});

const text = (max: number) => z.string().max(max);
export const beatCreate = z.object({
  title: text(80).default(''), startSec: z.number().min(0).max(36_000), endSec: z.number().min(0).max(36_000),
  youSay: text(1000).default(''), onScreen: text(500).default(''), visual: text(500).default(''), animation: text(500).default(''),
});
export const beatPatch = beatCreate.partial();

function checkRange(start: number, end: number): void {
  if (end <= start) throw badRequest('A beat must end after it starts');
}

export async function listBeats(orgId: string, videoId: string): Promise<Beat[]> {
  await getVideo(videoId);
  const { rows } = await getDb().query('SELECT * FROM video_beats WHERE org_id=$1 AND video_id=$2 ORDER BY start_sec, position, created_at', [orgId, videoId]);
  return rows.map(mapBeat);
}

export async function createBeat(orgId: string, userId: string, videoId: string, b: z.infer<typeof beatCreate>): Promise<Beat> {
  const video = await getVideo(videoId);
  checkRange(b.startSec, b.endSec);
  if (video.durationSec && b.startSec >= video.durationSec) throw badRequest('That beat starts after the video ends');
  const pos = (await getDb().query<{ n: number }>('SELECT COUNT(*)::int AS n FROM video_beats WHERE org_id=$1 AND video_id=$2', [orgId, videoId])).rows[0].n;
  const { rows } = await getDb().query(
    `INSERT INTO video_beats (org_id, video_id, position, title, start_sec, end_sec, you_say, on_screen, visual, animation, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [orgId, videoId, pos, b.title, b.startSec, b.endSec, b.youSay, b.onScreen, b.visual, b.animation, userId],
  );
  return mapBeat(rows[0]);
}

async function load(orgId: string, id: string) {
  const { rows } = await getDb().query('SELECT * FROM video_beats WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Beat not found');
  return rows[0];
}

/** Editing a beat that was approved sends it back to draft: the approval was for what was there before. */
export async function updateBeat(orgId: string, userId: string, id: string, p: z.infer<typeof beatPatch>): Promise<Beat> {
  const cur = await load(orgId, id);
  const start = p.startSec ?? cur.start_sec;
  const end = p.endSec ?? cur.end_sec;
  checkRange(start, end);
  const next = {
    title: p.title ?? cur.title, you_say: p.youSay ?? cur.you_say, on_screen: p.onScreen ?? cur.on_screen, visual: p.visual ?? cur.visual, animation: p.animation ?? cur.animation,
  };
  const status = cur.status === 'approved' ? 'draft' : cur.status;
  const { rows } = await getDb().query(
    `UPDATE video_beats SET title=$3, start_sec=$4, end_sec=$5, you_say=$6, on_screen=$7, visual=$8, animation=$9, status=$10, updated_by=$11, updated_at=now()
     WHERE id=$1 AND org_id=$2 RETURNING *`,
    [id, orgId, next.title, start, end, next.you_say, next.on_screen, next.visual, next.animation, status, userId],
  );
  return mapBeat(rows[0]);
}

export async function deleteBeat(orgId: string, id: string): Promise<void> {
  const r = await getDb().query('DELETE FROM video_beats WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (r.rowCount === 0) throw notFound('Beat not found');
}

/** The editor hands the beat over for review. */
export async function submitBeat(orgId: string, userId: string, id: string): Promise<Beat> {
  const cur = await load(orgId, id);
  if (cur.status === 'approved') throw badRequest('This beat is already approved');
  // Unfinished checklist items do not block a submission: the reviewer sees what is still open.
  const { rows } = await getDb().query(`UPDATE video_beats SET status='in_review', updated_by=$3, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`, [id, orgId, userId]);
  return mapBeat(rows[0]);
}

export async function approveBeat(orgId: string, userId: string, id: string): Promise<Beat> {
  await load(orgId, id);
  const { rows } = await getDb().query(`UPDATE video_beats SET status='approved', change_request='', updated_by=$3, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`, [id, orgId, userId]);
  return mapBeat(rows[0]);
}

/** Each non-empty line of the request becomes an item on the editor's checklist. */
export function requestToAdjustments(request: string): Adjustment[] {
  return request
    .split(/\r?\n|;/)
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((t) => ({ id: crypto.randomUUID(), text: t.slice(0, 200), done: false }));
}

export async function requestChanges(orgId: string, userId: string, id: string, request: string): Promise<Beat> {
  const cur = await load(orgId, id);
  const items = requestToAdjustments(request);
  if (items.length === 0) throw badRequest('Write what needs to change');
  const keep = (cur.adjustments as Adjustment[]).filter((a) => !a.done);
  const { rows } = await getDb().query(
    `UPDATE video_beats SET status='changes_needed', change_request=$3, adjustments=$4::jsonb, updated_by=$5, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`,
    [id, orgId, request.trim(), JSON.stringify([...keep, ...items]), userId],
  );
  return mapBeat(rows[0]);
}

export async function setAdjustmentDone(orgId: string, userId: string, id: string, adjustmentId: string, done: boolean): Promise<Beat> {
  const cur = await load(orgId, id);
  const list = cur.adjustments as Adjustment[];
  if (!list.some((a) => a.id === adjustmentId)) throw notFound('That item is not on this beat');
  const next = list.map((a) => (a.id === adjustmentId ? { ...a, done } : a));
  const { rows } = await getDb().query(`UPDATE video_beats SET adjustments=$3::jsonb, updated_by=$4, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`, [id, orgId, JSON.stringify(next), userId]);
  return mapBeat(rows[0]);
}
