import { z } from 'zod';
import { badRequest } from '../lib/errors';

export const wordSchema = z.object({
  w: z.string().max(80),
  s: z.number().finite().min(0).max(36_000),
  e: z.number().finite().min(0).max(36_000),
});
export const wordsSchema = z.array(wordSchema).max(20_000);
export type EditedWord = z.infer<typeof wordSchema>;

/**
 * The transcript as the team edited it, made safe to caption from: spaces trimmed, empty words dropped,
 * every word ends after it starts, and words stay in time order (a later word never starts before the one before ends).
 */
export function cleanWords(input: EditedWord[]): EditedWord[] {
  const out: EditedWord[] = [];
  for (const raw of input) {
    const w = raw.w.replace(/\s+/g, ' ').trim();
    if (!w) continue;
    const prev = out[out.length - 1];
    const s = prev ? Math.max(raw.s, prev.e) : raw.s;
    const e = Math.max(raw.e, s + 0.05);
    out.push({ w, s: Math.round(s * 100) / 100, e: Math.round(e * 100) / 100 });
  }
  if (out.length === 0) throw badRequest('The transcript cannot be empty. Use "Back to the original" to restore it.');
  return out;
}
