import { describe, expect, it } from 'vitest';
import { buildAss, captionsSchema, groupWords, styleSchema } from '../src/services/captions';

const words = [
  { w: 'Here', s: 0, e: 0.3 },
  { w: 'are', s: 0.3, e: 0.5 },
  { w: 'three', s: 0.5, e: 0.9 },
  { w: 'things', s: 0.9, e: 1.3 },
  { w: '{bad}', s: 3, e: 3.4 },
];
const events = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue'));
const gold = styleSchema.parse({ highlightColor: '#ebac65', textColor: '#fdf8f3', outlineColor: '#99577a' });

describe('captions', () => {
  it('groups words by the line limit and by pauses', () => {
    expect(groupWords(words, 3).map((g) => g.map((w) => w.w))).toEqual([['Here', 'are', 'three'], ['things'], ['{bad}']]);
    expect(groupWords(words, 6).map((g) => g.length)).toEqual([4, 1]);
  });

  it('makes one event per word with that word picked out, in capitals, with no stray ASS codes', () => {
    const ass = buildAss(words, 1080, 1920, 3, 0, gold);
    const ev = events(ass);
    expect(ev).toHaveLength(5);
    // #ebac65 is &H0065ACEB& (blue-green-red), the text #fdf8f3 is &H00F3F8FD&
    expect(ev[0]).toContain('{\\c&H0065ACEB&}HERE{\\c&H00F3F8FD&} ARE THREE');
    expect(ev[1]).toContain('HERE {\\c&H0065ACEB&}ARE{\\c&H00F3F8FD&} THREE');
    expect(ev[4]).toContain('BAD');
    expect(ev[4]).not.toContain('{bad}');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('&H007A5799&'); // the mauve outline
  });

  it('can italicise the whole caption or only the spoken word, enlarge the spoken word, and keep normal case', () => {
    const all = buildAss(words, 1080, 1920, 3, 0, styleSchema.parse({ italic: 'all' }));
    expect(all).toMatch(/Style: Cap,Archivo Black,\d+,[^,]+,[^,]+,[^,]+,[^,]+,0,-1,/);
    const spoken = events(buildAss(words, 1080, 1920, 3, 0, styleSchema.parse({ italic: 'spoken', emphasize: true, caps: false })))[0];
    expect(spoken).toContain('\\i1');
    expect(spoken).toContain('\\fscx118');
    expect(spoken).toContain('Here');
  });

  it('places the captions at the top, middle or bottom', () => {
    const align = (position: 'top' | 'middle' | 'bottom') => buildAss(words, 1080, 1920, 3, 0, styleSchema.parse({ position })).match(/,\d+,\d+,\d+,\d+,\d+,1\n/)?.[0];
    expect(align('top')).toContain(',8,');
    expect(align('middle')).toContain(',5,');
    expect(align('bottom')).toContain(',2,');
  });

  it('uses the chosen font and bold, and strips anything odd from the font name', () => {
    const ass = buildAss(words, 1080, 1920, 3, 0, styleSchema.parse({ font: 'Trirong Medium', bold: true }));
    expect(ass).toMatch(/Style: Cap,Trirong Medium,\d+,[^,]+,[^,]+,[^,]+,[^,]+,-1,0,/);
    expect(buildAss(words, 1080, 1920, 3, 0, styleSchema.parse({ font: 'Evil,Font{x}' }))).toContain('Style: Cap,EvilFontx,');
  });

  it('only accepts real colours', () => {
    expect(styleSchema.safeParse({ highlightColor: 'red; drawtext' }).success).toBe(false);
    expect(captionsSchema.parse({ enabled: true }).wordsPerLine).toBe(3);
  });

  it('shifts times for a single still so it shows what is said at that moment', () => {
    const ev = events(buildAss(words, 1080, 1920, 3, 0.6));
    expect(ev.some((l) => l.includes('HERE{'))).toBe(false);
    expect(ev.find((l) => l.includes('THREE{'))).toMatch(/Dialogue: 0,0:00:00\.00,/);
  });
});
