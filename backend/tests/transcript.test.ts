import { describe, expect, it } from 'vitest';
import { cleanWords, wordsSchema } from '../src/services/transcript';

describe('cleanWords', () => {
  it('trims words, drops empty ones and keeps the order', () => {
    expect(cleanWords([{ w: '  Greene ', s: 0, e: 0.4 }, { w: '   ', s: 0.4, e: 0.5 }, { w: 'Legal', s: 0.5, e: 0.9 }])).toEqual([
      { w: 'Greene', s: 0, e: 0.4 },
      { w: 'Legal', s: 0.5, e: 0.9 },
    ]);
  });

  it('never lets a word start before the one before it ends, or end before it starts', () => {
    const out = cleanWords([{ w: 'a', s: 0, e: 1 }, { w: 'b', s: 0.5, e: 0.6 }]);
    expect(out[1].s).toBe(1);
    expect(out[1].e).toBeGreaterThan(out[1].s);
  });

  it('refuses an empty transcript', () => {
    expect(() => cleanWords([{ w: ' ', s: 0, e: 1 }])).toThrow();
  });

  it('rejects words that are not numbers in range', () => {
    expect(wordsSchema.safeParse([{ w: 'x', s: -1, e: 1 }]).success).toBe(false);
    expect(wordsSchema.safeParse([{ w: 'x', s: 0, e: 1 }]).success).toBe(true);
  });
});
