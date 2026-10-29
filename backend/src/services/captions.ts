import { z } from 'zod';
import type { Word } from './effects';

/** Words on screen as they are spoken, a few at a time, with the word being said picked out. Drawn with ffmpeg's ASS subtitles. */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #ebac65');

export const styleSchema = z.object({
  textColor: hex.default('#ffffff'),
  /** The word being said. */
  highlightColor: hex.default('#ffe600'),
  outlineColor: hex.default('#000000'),
  /** off, the whole caption, or only the word being said */
  italic: z.enum(['off', 'all', 'spoken']).default('off'),
  /** Makes the word being said a little bigger. */
  emphasize: z.boolean().default(false),
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  position: z.enum(['top', 'middle', 'bottom']).default('bottom'),
  caps: z.boolean().default(true),
  /** Family name of a font from the effects skill or the project's fonts folder. */
  font: z.string().max(80).default('Archivo Black'),
  /** For fonts that only come in a light weight. */
  bold: z.boolean().default(false),
});
export type CaptionStyle = z.infer<typeof styleSchema>;

export const DEFAULT_STYLE: CaptionStyle = styleSchema.parse({});

export const captionsSchema = z.object({
  enabled: z.boolean().default(false),
  wordsPerLine: z.number().int().min(1).max(6).default(3),
  style: styleSchema.optional(),
});
export type Captions = z.infer<typeof captionsSchema>;

export const DEFAULT_CAPTIONS: Captions = { enabled: false, wordsPerLine: 3 };

/** A blue-green-red ASS colour from #rrggbb. */
const ass = (c: string) => `&H00${c.slice(5, 7)}${c.slice(3, 5)}${c.slice(1, 3)}&`.toUpperCase();

/** Groups of words that fit one caption: a pause or the line limit starts a new group. */
export function groupWords(words: Word[], perLine: number): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (cur.length && (cur.length >= perLine || w.s - cur[cur.length - 1].e > 0.7)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const stamp = (sec: number) => {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** Spoken words can hold characters that mean something in ASS, so only letters, numbers and plain punctuation are kept. */
const cleanWord = (w: string, caps: boolean) => {
  const c = w.replace(/[^\p{L}\p{N}'’.,!?$%&-]/gu, '');
  return caps ? c.toUpperCase() : c;
};

const SIZE = { small: 0.04, medium: 0.05, large: 0.065 };

/**
 * The subtitle file. `offset` shifts every time back so a single still frame at that moment shows what the full video would.
 * Each word gets its own event in which that word is picked out, so the highlight moves as the person speaks.
 */
export function buildAss(words: Word[], width: number, height: number, perLine: number, offset = 0, style: CaptionStyle = DEFAULT_STYLE): string {
  const size = Math.round(height * SIZE[style.size]);
  // Bottom sits clear of the label bar; top and middle are free of it
  const align = style.position === 'top' ? 8 : style.position === 'middle' ? 5 : 2;
  const marginV = style.position === 'bottom' ? Math.round(height * 0.2) : style.position === 'top' ? Math.round(height * 0.12) : 0;
  const text = ass(style.textColor);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${style.font.replace(/[^\p{L}\p{N} -]/gu, '')},${size},${text},${text},${ass(style.outlineColor)},&H80000000&,${style.bold ? -1 : 0},${style.italic === 'all' ? -1 : 0},0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.12))},0,${align},${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const group of groupWords(words, perLine)) {
    group.forEach((w, i) => {
      const start = w.s;
      // The highlight stays until the next word starts; the last word holds for a moment after it is said
      const end = i + 1 < group.length ? group[i + 1].s : Math.max(w.e, w.s + 0.25) + 0.15;
      if (end - offset <= 0) return;
      const body = group
        .map((g, j) => {
          const c = cleanWord(g.w, style.caps);
          if (j !== i) return c;
          const on = `{\\c${ass(style.highlightColor)}${style.italic === 'spoken' ? '\\i1' : ''}${style.emphasize ? '\\fscx118\\fscy118' : ''}}`;
          const off = `{\\c${text}${style.italic === 'spoken' ? '\\i0' : ''}${style.emphasize ? '\\fscx100\\fscy100' : ''}}`;
          return `${on}${c}${off}`;
        })
        .join(' ');
      lines.push(`Dialogue: 0,${stamp(start - offset)},${stamp(end - offset)},Cap,,0,0,0,,${body}`);
    });
  }
  return lines.join('\n') + '\n';
}
