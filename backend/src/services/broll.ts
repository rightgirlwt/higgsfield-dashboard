import path from 'node:path';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { run } from './exec';
import { clipFile, probeFile } from './vault';

/**
 * B-roll: a clip from the Content Vault shown over a stretch of the video while the video's own sound carries on.
 * Cutaways are laid in first, so effects, captions and the label go on top of the finished picture.
 */

export const MAX_CUTAWAYS = 40;

export const brollSchema = z.object({
  clipId: z.string().uuid(),
  /** Where it shows on the video, in seconds. */
  start: z.number().min(0).max(36_000),
  end: z.number().min(0).max(36_000),
  /** Where in the clip it starts playing. */
  from: z.number().min(0).max(36_000).default(0),
});
export type Cutaway = z.infer<typeof brollSchema>;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Puts the cutaways in time order, trims them to the video, and refuses one that ends before it starts. */
export function checkCutaways(list: Cutaway[], durationSec: number | null): Cutaway[] {
  const out: Cutaway[] = [];
  for (const c of list) {
    if (c.end <= c.start) throw badRequest('B-roll: the end time must be after the start time');
    if (durationSec !== null && c.start >= durationSec) continue; // starts after the video ends: nothing to show
    out.push({ ...c, end: durationSec !== null ? Math.min(c.end, durationSec) : c.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The ffmpeg filter graph: input 0 is the video, inputs 1.. are the clips (already cut to length). Each clip is filled to the
 * video's size (cropping the sides or top if its shape differs), timed to start where its cutaway starts, and laid over the
 * picture only between its start and end.
 */
export function cutawayFilter(list: { start: number; end: number }[], w: number, h: number): string {
  const parts: string[] = [];
  list.forEach((c, i) => {
    parts.push(`[${i + 1}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,setpts=PTS-STARTPTS+${r2(c.start)}/TB[b${i}]`);
  });
  let prev = '0:v';
  list.forEach((c, i) => {
    const out = i === list.length - 1 ? 'vout' : `v${i}`;
    parts.push(`[${prev}][b${i}]overlay=enable='between(t,${r2(c.start)},${r2(c.end)})':eof_action=pass[${out}]`);
    prev = out;
  });
  return parts.join(';');
}

/** Renders the video with the cutaways laid in. Throws a plain message if a clip has left the Vault. */
export async function composeBroll(o: { base: string; out: string; cutaways: Cutaway[] }): Promise<void> {
  if (o.cutaways.length === 0) throw new Error('No cutaways to lay in');
  const files: string[] = [];
  for (const c of o.cutaways) {
    try {
      files.push(path.resolve(await clipFile(c.clipId)));
    } catch {
      throw badRequest('A B-roll clip is no longer in the Vault (or its file has moved). Remove it from the list and try again.');
    }
  }
  const size = await probeFile(o.base);
  if (!size.width || !size.height) throw badRequest('Could not read the size of this video');
  const args = ['-v', 'error', '-y', '-i', path.resolve(o.base)];
  o.cutaways.forEach((c, i) => {
    // Looped, so a clip shorter than its cutaway repeats instead of leaving a gap
    args.push('-stream_loop', '-1', '-ss', r2(c.from).toFixed(2), '-t', r2(c.end - c.start).toFixed(2), '-i', files[i]);
  });
  args.push(
    '-filter_complex', cutawayFilter(o.cutaways, size.width, size.height),
    '-map', '[vout]', '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', path.resolve(o.out),
  );
  await run('ffmpeg', args, { timeoutMs: 60 * 60_000 });
}

/**
 * Lays a reel's clips over an edit: one cutaway per reel beat, spread across the video's beats (or evenly across its length when it
 * has none). Each starts a moment into its slot so the speaker is seen first, and none runs longer than its slot or its reel beat.
 */
export function placeReelBroll(reel: { clipId: string; seconds: number }[], slots: { startSec: number; endSec: number }[], durationSec: number): Cutaway[] {
  const n = reel.length;
  if (n === 0 || durationSec <= 0) return [];
  const lead = 0.3;
  const places = slots.length > 0 ? slots : Array.from({ length: n }, (_, i) => ({ startSec: (i * durationSec) / n, endSec: ((i + 1) * durationSec) / n }));
  const groups = new Map<number, typeof reel>();
  reel.forEach((b, j) => {
    const idx = slots.length > 0 ? Math.min(places.length - 1, Math.floor(((j + 0.5) * places.length) / n)) : j;
    groups.set(idx, [...(groups.get(idx) ?? []), b]);
  });
  const out: Cutaway[] = [];
  for (const [idx, clips] of groups) {
    const slot = places[idx];
    const room = Math.min(slot.endSec, durationSec) - slot.startSec - lead;
    if (room < 0.8) continue;
    let cursor = slot.startSec + lead;
    const each = room / clips.length;
    for (const b of clips) {
      const len = Math.min(b.seconds, each);
      if (len < 0.8) continue;
      out.push({ clipId: b.clipId, start: r2(cursor), end: r2(cursor + len), from: 0 });
      cursor += len;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
