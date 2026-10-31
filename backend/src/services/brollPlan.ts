import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound } from '../lib/errors';
import { calcCostUsd, estimateTokens } from '../lib/pricing';
import { type Cutaway, placeReelBroll } from './broll';
import { listBeats } from './beats';
import { runPrompt } from './claude';
import { DEFAULT_LABEL, getVideo, savePlan } from './effects';
import { getSecret } from './secrets';
import { recordUsage } from './usage';
import { catalogFor } from './vault';
import type { Workspace } from './workspaces';

const MODEL = 'claude-haiku-5-5';
const r2 = (n: number) => Math.round(n * 100) / 100;

interface BeatLite {
  startSec: number;
  endSec: number;
}
interface CatalogLite {
  key: string;
  id: string;
  durationSec: number | null;
}
export interface BrollPick {
  cutaway: Cutaway;
  beat: number;
  why: string;
}

/**
 * Keeps only picks that name a real beat and a real clip, use each clip once, and fit: a cutaway stays inside its beat,
 * is 1 to 4.5 seconds, and never runs longer than the clip it shows.
 */
export function parseBrollPicks(text: string, beats: BeatLite[], catalog: CatalogLite[]): BrollPick[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw badRequest('Claude did not return B-roll picks. Try again.');
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    throw badRequest('Claude did not return B-roll picks. Try again.');
  }
  const parsed = z.array(z.object({ beat: z.number(), clip: z.string(), at: z.number().default(0.4), seconds: z.number().default(3), why: z.string().default('') })).safeParse(raw);
  if (!parsed.success) throw badRequest('Claude did not return B-roll picks. Try again.');
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const used = new Set<string>();
  const out: BrollPick[] = [];
  for (const p of parsed.data) {
    const beat = beats[Math.round(p.beat) - 1];
    const clip = byKey.get(p.clip.trim().toLowerCase());
    if (!beat || !clip || used.has(clip.id)) continue;
    const start = Math.min(Math.max(beat.startSec + Math.max(0, p.at), beat.startSec), beat.endSec);
    const len = Math.min(4.5, Math.max(1, p.seconds), clip.durationSec ?? 4.5, beat.endSec - start);
    if (len < 1) continue;
    used.add(clip.id);
    out.push({ cutaway: { clipId: clip.id, start: r2(start), end: r2(start + len), from: 0 }, beat: Math.round(p.beat), why: p.why.trim().slice(0, 200) });
  }
  return out.sort((a, b) => a.cutaway.start - b.cutaway.start);
}

const SYSTEM =
  "You choose B-roll for a talking-head video from the creator's own footage. You get the video's beats (what is said, and when) and a list of her clips. " +
  'For each beat, pick a clip only if it genuinely lines up with what is being said or shown in that beat; skip the beat if nothing fits. Never use a clip twice. ' +
  'Prefer clips that are not in the "Talking head" folder, since that is more of the same. A cutaway is 2 to 4 seconds, never longer than its clip or its beat. ' +
  '"at" is how many seconds into the beat it starts (about 0.4 to 1.5). "why" is a few words. ' +
  'Answer with only a JSON array of {"beat":<number>,"clip":"<id>","at":<seconds>,"seconds":<seconds>,"why":"..."} and nothing else.';

/** One click: Haiku matches the video's beats to Vault clips. Cheap (text only), and the cost is returned so the page can show it. */
export async function suggestBroll(orgId: string, ws: Workspace, videoId: string) {
  const video = await getVideo(videoId);
  const beats = await listBeats(orgId, videoId);
  if (beats.length === 0) throw badRequest('Add beats to this video first, so the B-roll has places to go.');
  const { catalog, text } = await catalogFor(orgId, ws);
  if (catalog.length === 0) throw badRequest('Sort some clips in the Vault first.');
  if (!(await getSecret(orgId, 'anthropic'))) throw badRequest('Add your Anthropic key in Settings to get B-roll suggestions.');
  const beatLines = beats.map((b, i) => `${i + 1} | ${b.startSec.toFixed(1)}-${b.endSec.toFixed(1)}s | ${b.title || 'Untitled'} | says: ${b.youSay || '(nothing written)'}${b.visual ? ` | visual: ${b.visual}` : ''}`);
  const user = `Video: ${video.title || video.name}\n\nBeats (number | time | title | what is said):\n${beatLines.join('\n')}\n\nClips (id | time filmed | length | folder | tags | what happens):\n${text}`;
  const maxTokens = beats.length * 90 + 150;
  const res = await runPrompt(orgId, { model: MODEL, system: SYSTEM, user, maxTokens });
  await recordUsage({ orgId, provider: 'claude', model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, simulated: res.simulated });
  const picks = parseBrollPicks(res.text, beats, catalog);
  return { costUsd: res.costUsd, picks, estimateUsd: calcCostUsd(MODEL, estimateTokens(SYSTEM + user), maxTokens) };
}

/** Puts a Vault reel's clips onto an edit as B-roll, replacing what was there, and saves the edit's plan. */
export async function reelToEdit(orgId: string, reelId: string, videoId: string): Promise<{ placed: number; videoId: string }> {
  const { rows } = await getDb().query<{ beats: { clipId: string; seconds: number }[] }>(`SELECT beats FROM vault_reels r WHERE r.id=$1 AND r.org_id=$2`, [reelId, orgId]);
  if (!rows[0]) throw notFound('Reel not found');
  const video = await getVideo(videoId);
  const duration = video.durationSec ?? 0;
  if (duration <= 0) throw badRequest('This video has no known length, so B-roll cannot be placed on it.');
  // Only clips still in the Vault
  const have = new Set((await getDb().query<{ id: string }>(`SELECT id FROM vault_clips WHERE org_id=$1 AND id = ANY($2::uuid[])`, [orgId, rows[0].beats.map((b) => b.clipId)])).rows.map((r) => r.id));
  const reel = rows[0].beats.filter((b) => have.has(b.clipId));
  if (reel.length === 0) throw badRequest('None of this reel\'s clips are in the Vault any more.');
  const beats = await listBeats(orgId, videoId);
  const cutaways = placeReelBroll(reel, beats, duration);
  if (cutaways.length === 0) throw badRequest('There is no room on this video for that B-roll. Try a longer video or fewer beats.');
  await savePlan(videoId, { ...(video.plan ?? { steps: [], label: { enabled: false, text: DEFAULT_LABEL } }), broll: cutaways });
  return { placed: cutaways.length, videoId };
}
