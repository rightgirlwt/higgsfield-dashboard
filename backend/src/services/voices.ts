import fs from 'node:fs';
import path from 'node:path';

/** Where the copied skills live (see scripts/sync-voices.cjs). Works from src (tsx, tests) and from dist. */
const DIR = path.resolve(__dirname, '..', '..', 'voices');

const read = (name: string): string => {
  try {
    return fs.readFileSync(path.join(DIR, name), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  } catch {
    return '';
  }
};

export const isLegalWorkspace = (name: string) => /greene|legal|glg/i.test(name);

/**
 * The writing rules for a workspace, taken from the same skills used in Claude. Read on every call, so a re-sync
 * takes effect without a restart. Empty when the files are missing (the caller then falls back to a short summary).
 */
export function voiceRules(workspaceName: string): string {
  const parts = [
    ['RGM CONTENT WRITER: caption, hook and voice rules', read('rgm-content-writer.md')],
    ...(isLegalWorkspace(workspaceName) ? [['GREENE LEGAL GROUP: content system and legal advertising rules', read('glg-content-system.md')]] : []),
    ['ANTI-AI WRITING: the final filter on every caption', read('anti-ai-writing.md')],
  ].filter(([, text]) => text);
  return parts.map(([title, text]) => `===== ${title} =====\n${text}`).join('\n\n');
}

// ---- spotting machine-sounding lines, in code, so the same words always give the same answer ---------------

const VOCAB =
  /\b(delve|realm|harness|unlock|tapestry|leverage|synergy|seamless|robust|elevate|streamline|supercharge|game[- ]changer|cutting[- ]edge|revolutionize|transformative|intricate|crucial|pivotal|testament|foster|empower|holistic|frictionless|unparalleled|groundbreaking|data[- ]driven)\b/i;
const OPENINGS = /(^|\n)\s*(in today'?s|it'?s important to note|let'?s (?:dive|explore|unpack)|at the end of the day|nobody is talking about|most people don'?t realize|in this post)/i;
const BAIT = /\b(let that sink in|read that again|this changes everything|what'?s your [^?\n]{1,40}\?\s*👇)/i;
const PARALLEL = [
  /\b(?:it'?s|it is|this is|that'?s|they'?re|you'?re|we'?re) not (?:about |just |a |an |the )?[^.!?\n]{1,50}[.,;]\s*(?:it'?s|it is|this is|that'?s|they'?re|you'?re|we'?re|but)\b/i,
  /\b(?:isn'?t|aren'?t|wasn'?t) (?:about )?[^.!?\n]{1,50}[.,]\s*(?:it'?s|it is|they'?re|that'?s)\b/i,
  /\bless [^.\n]{1,30}, more\b/i,
  /\bstop [^.\n]{1,40}, start\b/i,
];

export interface Tell {
  rule: string;
  /** The offending line, exactly as written. */
  line: string;
}

/** Lines in a caption that read as AI-written, by the anti-AI skill's own rules (em dashes, banned words, dead openings, "not X, it's Y"). */
export function findTells(text: string): Tell[] {
  const tells: Tell[] = [];
  const add = (rule: string, line: string) => tells.push({ rule, line: line.trim() });
  for (const line of text.split('\n')) {
    if (!line.trim() || /^(#\S+\s*)+$/.test(line.trim())) continue; // blank lines and hashtag rows
    if (line.includes('—')) add('em dash: use a period, comma, colon or two sentences', line);
    if (VOCAB.test(line)) add(`banned word "${VOCAB.exec(line)![0]}"`, line);
    if (BAIT.test(line)) add('engagement bait', line);
    if (PARALLEL.some((re) => re.test(line))) add('"not X, it\'s Y" reframe: state the real point directly (allowed only if the second half is concrete)', line);
  }
  if (OPENINGS.test(text)) add('dead opening', text.split('\n').find((l) => OPENINGS.test(`\n${l}`)) ?? text.slice(0, 80));
  return tells;
}
