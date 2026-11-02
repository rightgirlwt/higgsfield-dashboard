import fs from 'node:fs/promises';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors';
import { calcCostUsd, estimateTokens } from '../lib/pricing';
import { listBeats } from './beats';
import { runPrompt } from './claude';
import type { Draft, PostPackage } from './drafts';import { getVideo, getWordsIfAny, resultPath, setDraftPackage } from './effects';
import { run } from './exec';
import { getSecret } from './secrets';
import { recordUsage } from './usage';
import { findTells, isLegalWorkspace, voiceRules } from './voices';
import type { Workspace } from './workspaces';

const MODEL = 'claude-sonnet-5-5';
const MAX_TRANSCRIPT_CHARS = 6000;

export const packageEdit = z.object({
  hook: z.string().max(300).default(''),
  caption: z.string().trim().max(2200),
  hashtags: z.array(z.string().max(60)).max(15).default([]),
  coverSec: z.number().min(0).max(36_000).default(0),
  firstComment: z.string().max(500).default(''),
});

export const cleanTag = (t: string) => `#${t.replace(/[^\p{L}\p{N}_]/gu, '')}`;

/** Hashtags as `#word`, no spaces or punctuation, each once. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const tag = cleanTag(t);
    if (tag.length < 2 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

const RESULT_WORDS = /\b(verdict|settle(?:d|ment)?|recovered|won|results?|awarded|payout|outcome)\b/i;
const MONEY = /\$\s?\d|\b\d[\d,.]*\s?(?:k|m|million|thousand|grand)\b/i;
const SUPERLATIVE = /\b(best|#\s?1|number one|top[- ]rated|highest|most successful|greatest)\b/i;
const GUARANTEE = /\b(guarantee[sd]?|you will win|always win|promise)\b/i;

export interface Check {
  id: string;
  /** must: the post should not go out until this is fixed. tip: worth a look. */
  level: 'must' | 'tip';
  ok: boolean;
  text: string;
}

/**
 * What to check before posting. Done in code, not by Claude, so the same words always get the same answer.
 * The legal-advertising rules (ABA Model Rule 7.1) apply to the law firm's workspace only.
 */
export function checkPackage(p: { caption: string; hashtags: string[]; firstComment?: string }, ctx: { workspaceName: string; labelOn: boolean; approved: boolean }): Check[] {
  const text = `${p.caption}\n${p.firstComment ?? ''}`;
  // The required disclaimer itself contains "guarantee"; it must not trip the rule it exists to satisfy
  const claims = text.replace(/prior results do not guarantee a similar outcome\.?/gi, '');
  const checks: Check[] = [];
  const firstLine = p.caption.split('\n').find((l) => l.trim())?.trim() ?? '';
  checks.push({ id: 'hook', level: 'tip', ok: firstLine.length > 0 && firstLine.length <= 125, text: 'The first line is a short hook (it is all that shows before "more")' });
  checks.push({ id: 'tags', level: 'tip', ok: p.hashtags.length >= 3 && p.hashtags.length <= 5, text: '3 to 5 hashtags' });
  checks.push({ id: 'approved', level: 'tip', ok: ctx.approved, text: 'This version has been approved' });
  const tell = findTells(p.caption)[0];
  checks.push({ id: 'aitells', level: 'tip', ok: !tell, text: tell ? `Reads machine-written: ${tell.rule} in "${tell.line.slice(0, 70)}"` : 'Reads like a person wrote it (no em dashes, banned words or "not X, it\'s Y")' });
  if (isLegalWorkspace(ctx.workspaceName)) {
    const hasResults = RESULT_WORDS.test(text);
    checks.push({ id: 'money', level: 'must', ok: !MONEY.test(claims), text: 'No dollar amounts in the caption (results are shown blurred, never as numbers)' });
    checks.push({ id: 'superlative', level: 'must', ok: !SUPERLATIVE.test(claims), text: 'No "best", "#1" or "highest" claims without a citation' });
    checks.push({ id: 'guarantee', level: 'must', ok: !GUARANTEE.test(claims), text: 'Nothing that sounds like a guaranteed result' });
    checks.push({ id: 'prior', level: 'must', ok: !hasResults || /prior results do not guarantee a similar outcome/i.test(text), text: hasResults ? 'Says "Prior results do not guarantee a similar outcome" (this post talks about results)' : 'Results disclaimer (not needed, the caption does not talk about results)' });
    checks.push({ id: 'label', level: 'must', ok: ctx.labelOn, text: 'The on-screen DRAMATIZATION / ACTOR PORTRAYAL label is on, if any scene is AI-made or acted' });
  }
  return checks;
}

export const blockers = (checks: Check[]) => checks.filter((c) => c.level === 'must' && !c.ok);

// ---- asking Claude ---------------------------------------------------------------------------------------

export interface Draftable {
  hook: string;
  caption: string;
  hashtags: string[];
  coverSec: number;
  firstComment: string;
}

/** Reads Claude's answer: one JSON object. The cover time is kept inside the video. */
export function parsePackage(text: string, durationSec: number | null): Draftable {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw badRequest('Claude did not return a caption. Try again.');
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    throw badRequest('Claude did not return a caption. Try again.');
  }
  const parsed = z.object({ hook: z.string().default(''), caption: z.string().min(1), hashtags: z.array(z.string()).default([]), coverSec: z.number().default(0), firstComment: z.string().default('') }).safeParse(raw);
  if (!parsed.success) throw badRequest('Claude did not return a caption. Try again.');
  const d = parsed.data;
  const max = durationSec && durationSec > 0 ? Math.max(0, durationSec - 0.2) : 0;
  return {
    hook: d.hook.trim().slice(0, 300),
    caption: d.caption.trim().slice(0, 2200),
    hashtags: cleanTags(d.hashtags).slice(0, 5),
    coverSec: Math.round(Math.min(Math.max(0, d.coverSec), max) * 10) / 10,
    firstComment: d.firstComment.trim().slice(0, 500),
  };
}

const TASK =
  'You write the post that goes with a finished short video (an Instagram Reel). You get what is said in the video and its beats. ' +
  'The writing rules below are the same ones used in Claude for this client: they decide the voice, the hook, the emoji, the CTA, the hashtags and the final anti-AI pass. Follow them. ' +
  'For a Reel caption that means the hook first, then the body, then ONE CTA, then 3 to 5 hashtags, about 50 to 100 words. ' +
  'The caption must complement the video, never retell it. Use only facts that are in what is said; never invent numbers, names or events. No placeholder brackets. ' +
  '"coverSec" is the second in the video that makes the best cover frame: a clear face or a strong moment, not a transition. ' +
  '"firstComment" is optional, a short line to pin as the first comment (or an empty string). ' +
  'Answer with only a JSON object {"hook":"","caption":"","hashtags":[],"coverSec":0,"firstComment":""}. "caption" already starts with the hook and does not contain the hashtags, which go in "hashtags" without the # sign.';

/** Used only when the copied skill files are missing (see scripts/sync-voices.cjs). */
const FALLBACK =
  'Voice: bold, direct, warm, short punchy lines, results-anchored. First line is the hook with no emoji, then 2 to 4 short lines, exactly one call to action, no em dashes, at most 2 emoji.';

const LEGAL_NOTE =
  'This is the law firm account. The legal advertising rules in the Greene Legal Group section are strict and win over anything else: never a dollar amount, never "best", "#1" or "highest", never a promise of a result, and if the video talks about a result end the caption with "Prior results do not guarantee a similar outcome."';

const systemFor = (workspaceName: string, voice = '') => [TASK, voiceRules(workspaceName) || FALLBACK, voice.trim() ? `How this account sounds, in the owner's words (these win over the general rules above where they differ): ${voice.trim()}` : '', isLegalWorkspace(workspaceName) ? LEGAL_NOTE : ''].filter(Boolean).join('\n\n');

/** One click: Sonnet writes the caption, hashtags, cover second and pinned comment for a rendered draft. Cost is returned afterwards. */
export async function makePackage(orgId: string, ws: Workspace, videoId: string, n: number, madeBy: string): Promise<{ package: PostPackage; costUsd: number; estimateUsd: number }> {
  const video = await getVideo(videoId);
  const draft = video.drafts?.find((d) => d.n === n);
  if (!draft) throw notFound('Draft not found');
  if (!(await getSecret(orgId, 'anthropic'))) throw badRequest('Add your Anthropic key in Settings to write the caption.');
  const words = await getWordsIfAny(videoId).catch(() => []);
  const spoken = words.map((w) => w.w).join(' ').trim().slice(0, MAX_TRANSCRIPT_CHARS);
  const beats = await listBeats(orgId, videoId);
  if (!spoken && beats.length === 0) throw badRequest('Transcribe the video or add beats first, so the caption has something to say.');
  const beatLines = beats.map((b, i) => `${i + 1} | ${b.startSec.toFixed(1)}-${b.endSec.toFixed(1)}s | ${b.title || 'Untitled'} | ${b.youSay || ''}`);
  const user =
    `Account: ${ws.name}\nVideo: ${video.title || video.name}\nLength: ${video.durationSec ?? 'unknown'} seconds\n` +
    `On-screen label: ${draft.plan.label.enabled ? draft.plan.label.text : 'none'}\n\n` +
    `What is said:\n${spoken || '(not transcribed)'}\n\nBeats (number | time | title | says):\n${beatLines.join('\n') || '(none)'}`;
  const system = systemFor(ws.name, ws.voice);
  const maxTokens = 900;
  const ask = async (prompt: string) => {
    const res = await runPrompt(orgId, { model: MODEL, system, user: prompt, maxTokens });
    await recordUsage({ orgId, provider: 'claude', model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd, simulated: res.simulated });
    return res;
  };
  const first = await ask(user);
  let costUsd = first.costUsd;
  let made = parsePackage(first.text, video.durationSec);
  // The anti-AI pass, once: if the draft still reads machine-written, hand the exact lines back to be fixed
  const tells = findTells(made.caption);
  if (tells.length > 0) {
    const list = tells.map((t) => `- ${t.rule}: "${t.line}"`).join('\n');
    const again = await ask(
      `${user}\n\nYou wrote this:\n${JSON.stringify({ hook: made.hook, caption: made.caption, hashtags: made.hashtags, coverSec: made.coverSec, firstComment: made.firstComment })}\n\n` +
        `These lines break the anti-AI rules:\n${list}\n\nRewrite only what is needed to fix them. Keep the voice, the facts, the hook idea and the single CTA. Answer with the same JSON object.`,
    );
    costUsd += again.costUsd;
    try {
      made = parsePackage(again.text, video.durationSec);
    } catch {
      /* keep the first draft; its remaining tells show in the checklist */
    }
  }
  const pkg = await savePackage(videoId, n, ws, made, madeBy);
  return { package: pkg, costUsd, estimateUsd: calcCostUsd(MODEL, estimateTokens(system + user), maxTokens) };
}

/** Stores the package on the draft with its checks worked out from the final words. */
export async function savePackage(videoId: string, n: number, ws: { name: string }, p: Draftable, by: string): Promise<PostPackage> {
  const hashtags = cleanTags(p.hashtags);
  return setDraftPackage(videoId, n, (draft) => {
    const checks = checkPackage({ caption: p.caption, hashtags, firstComment: p.firstComment }, { workspaceName: ws.name, labelOn: draft.plan.label.enabled, approved: draft.status === 'approved' });
    return { hook: p.hook, caption: p.caption, hashtags, coverSec: p.coverSec, firstComment: p.firstComment, checks, updatedAt: new Date().toISOString(), updatedBy: by.slice(0, 80) };
  });
}

/** The text to paste into the scheduler: caption, a blank line, the hashtags. */
export const postText = (p: { caption: string; hashtags: string[] }) => `${p.caption.trim()}\n\n${p.hashtags.join(' ')}`.trim();

// ---- the cover frame and the zip ----------------------------------------------------------------------------

async function draftOf(videoId: string, n: number): Promise<{ draft: Draft; file: string; title: string }> {
  const video = await getVideo(videoId);
  const draft = video.drafts?.find((d) => d.n === n);
  const file = draft ? resultPath(draft.fileName) : null;
  if (!draft || !file) throw notFound('Draft not found');
  try {
    await fs.access(file);
  } catch {
    throw notFound('That rendered file is gone from this computer.');
  }
  return { draft, file, title: (video.title || video.name).replace(/\.[^.]+$/, '') };
}

/** One frame of the draft as a JPEG, for the cover. */
export async function coverFrame(videoId: string, n: number, sec: number): Promise<Buffer> {
  const { file } = await draftOf(videoId, n);
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, sec)), '-i', file, '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { timeoutMs: 60_000 });
  const out = Buffer.from(stdout);
  if (out.length === 0) throw badRequest('There is no picture at that second.');
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'reel';

/** Everything for the scheduler in one file: the video, the cover, the caption and the checklist. */
export async function packageZip(videoId: string, n: number): Promise<{ name: string; data: Buffer }> {
  const { draft, file, title } = await draftOf(videoId, n);
  const p = draft.package;
  if (!p) throw badRequest('Write the caption for this draft first.');
  const base = `${slug(title)}-v${n}`;
  const cover = await coverFrame(videoId, n, p.coverSec);
  const checklist = [`Before you post: ${title} (v${n})`, '', ...p.checks.map((c) => `[${c.ok ? 'x' : ' '}] ${c.level === 'must' ? 'MUST: ' : ''}${c.text}`)].join('\n');
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    [`${base}.mp4`]: [new Uint8Array(await fs.readFile(file)), { level: 0 }], // already compressed: store it
    [`${base}-cover.jpg`]: [new Uint8Array(cover), { level: 0 }],
    'caption.txt': new TextEncoder().encode(postText(p)),
    'checklist.txt': new TextEncoder().encode(checklist),
  };
  if (p.firstComment.trim()) files['first-comment.txt'] = new TextEncoder().encode(p.firstComment.trim());
  return { name: `${base}.zip`, data: Buffer.from(zipSync(files)) };
}
