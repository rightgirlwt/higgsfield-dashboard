import { badRequest } from '../lib/errors';

export type DraftStatus = 'draft' | 'in_review' | 'changes_needed' | 'approved';

/** The settings a draft was rendered with, kept so two drafts can be compared. Structural, so this file needs nothing from effects.ts. */
export interface DraftPlan {
  steps: { fx: string; start: number; end: number; text?: string; options?: Record<string, string | number> }[];
  label: { enabled: boolean; text: string };
  captions?: { enabled: boolean; wordsPerLine: number; style?: Record<string, unknown> };
}

/** One rendered version of an edit: v1, v2, ... */
export interface Draft {
  n: number;
  fileName: string;
  mediaId?: string;
  createdAt: string;
  createdBy: string;
  status: DraftStatus;
  /** The reviewer's note when changes were asked for. */
  note: string;
  plan: DraftPlan;
  /** What is different from the draft before it, in plain words. */
  changes: string[];
}

const stepKey = (s: DraftPlan['steps'][number]) => JSON.stringify([s.fx, s.start, s.end, s.text ?? '', s.options ?? {}]);

/** Plain-language list of what changed between two drafts' settings. The first draft has nothing to compare to. */
export function describeChanges(prev: DraftPlan | undefined, next: DraftPlan): string[] {
  if (!prev) return ['First draft'];
  const out: string[] = [];
  const before = new Map<string, number>();
  for (const s of prev.steps) before.set(stepKey(s), (before.get(stepKey(s)) ?? 0) + 1);
  const added: string[] = [];
  for (const s of next.steps) {
    const k = stepKey(s);
    const left = before.get(k) ?? 0;
    if (left > 0) before.set(k, left - 1);
    else added.push(s.fx);
  }
  const removed: string[] = [];
  for (const s of prev.steps) {
    const k = stepKey(s);
    const left = before.get(k) ?? 0;
    if (left > 0) {
      before.set(k, left - 1);
      removed.push(s.fx);
    }
  }
  if (added.length) out.push(`Added or changed: ${[...new Set(added)].join(', ')}`);
  if (removed.length) out.push(`Removed or replaced: ${[...new Set(removed)].join(', ')}`);

  const pc = prev.captions;
  const nc = next.captions;
  if (!pc?.enabled && nc?.enabled) out.push('Turned captions on');
  else if (pc?.enabled && !nc?.enabled) out.push('Turned captions off');
  else if (pc?.enabled && nc?.enabled && (pc.wordsPerLine !== nc.wordsPerLine || JSON.stringify(pc.style ?? {}) !== JSON.stringify(nc.style ?? {}))) out.push('Changed how the captions look');

  if (!prev.label.enabled && next.label.enabled) out.push('Added the dramatization label');
  else if (prev.label.enabled && !next.label.enabled) out.push('Removed the dramatization label');
  else if (prev.label.enabled && next.label.enabled && prev.label.text !== next.label.text) out.push('Changed the label text');

  return out.length ? out : ['Rendered again with the same settings'];
}

/** The next draft number for a video. */
export const nextNumber = (drafts: Draft[] | undefined) => (drafts?.length ? Math.max(...drafts.map((d) => d.n)) : 0) + 1;

function find(drafts: Draft[] | undefined, n: number): Draft {
  const d = drafts?.find((x) => x.n === n);
  if (!d) throw badRequest(`There is no draft v${n}`);
  return d;
}

/** Hand a draft over for review (the editor), or hand it back after changes. */
export function submitDraft(drafts: Draft[] | undefined, n: number): Draft {
  const d = find(drafts, n);
  if (d.status === 'approved') throw badRequest(`v${n} is already approved`);
  if (d.status === 'in_review') throw badRequest(`v${n} is already with the reviewer`);
  d.status = 'in_review';
  d.note = '';
  return d;
}

export function approveDraft(drafts: Draft[] | undefined, n: number): Draft {
  const d = find(drafts, n);
  if (d.status !== 'in_review') throw badRequest(`v${n} has to be submitted for review before it can be approved`);
  d.status = 'approved';
  d.note = '';
  return d;
}

export function requestDraftChanges(drafts: Draft[] | undefined, n: number, note: string): Draft {
  const d = find(drafts, n);
  if (d.status !== 'in_review') throw badRequest(`v${n} has to be submitted for review before changes can be asked for`);
  d.status = 'changes_needed';
  d.note = note;
  return d;
}
