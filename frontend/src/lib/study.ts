export interface Analysis {
  summary: string;
  format: string;
  hook: { said: string; shown: string; technique: string; why: string };
  structure: { at: number; label: string; what: string }[];
  pacing: string;
  onScreenText: string;
  audio: string;
  cta: string;
  steal: string[];
  avoid: string[];
  template: string;
}

export interface Script {
  id: string;
  topic: string;
  title: string;
  hook: string;
  beats: { say: string; onScreen: string; shot: string; seconds: number }[];
  caption: string;
  notes: string;
  tells: string[];
  createdAt: string;
}

export interface Study {
  id: string;
  title: string;
  name: string;
  sourceUrl: string;
  note: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  pacing: { shots: number; averageShotSec: number | null; cutsPer10s: number | null; firstCutSec: number | null };
  cuts: number[];
  /** Only reels opened from a link have these: the caption and the public numbers when it was fetched. */
  meta: { platform?: string; uploader?: string; caption?: string; postedAt?: string | null; likes?: number | null; comments?: number | null; views?: number | null; fetchedAt?: string };
  transcribed: boolean;
  transcript: string;
  analysis: Analysis | null;
  scripts: Script[];
  costUsd: number;
  createdAt: string;
  poster: string;
}

export interface Quote {
  approved: false;
  model: string;
  estimateUsd: number;
  maxUsd: number;
  keyMissing: boolean;
  frames?: number;
  seconds?: number;
  again?: boolean;
}

/** A script as plain text, for pasting into a notes app or a teleprompter. */
export function scriptText(s: Script): string {
  const beats = s.beats.map((b, i) => `${i + 1}. ${b.say}${b.onScreen ? `\n   On screen: ${b.onScreen}` : ''}${b.shot ? `\n   Shot: ${b.shot}` : ''}`).join('\n');
  return `${s.title}\n\nHOOK\n${s.hook}\n\nSCRIPT\n${beats}\n\nCAPTION\n${s.caption}`;
}
