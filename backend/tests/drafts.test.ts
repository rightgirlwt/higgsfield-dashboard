import { describe, expect, it } from 'vitest';
import { approveDraft, describeChanges, type Draft, type DraftPlan, nextNumber, requestDraftChanges, submitDraft } from '../src/services/drafts';

const base: DraftPlan = { steps: [], label: { enabled: false, text: 'DRAMATIZATION' }, captions: { enabled: false, wordsPerLine: 3 } };
const draft = (n: number, status: Draft['status'] = 'draft'): Draft => ({ n, fileName: `${n}.mp4`, createdAt: '2026-10-29T00:00:00Z', createdBy: 'Milo', status, note: '', plan: base, changes: [] });

describe('describeChanges', () => {
  it('calls the first render the first draft', () => {
    expect(describeChanges(undefined, base)).toEqual(['First draft']);
  });

  it('lists effects added and removed, captions and label changes', () => {
    const next: DraftPlan = {
      steps: [{ fx: 'spotlight', start: 1, end: 3 }],
      label: { enabled: true, text: 'DRAMATIZATION' },
      captions: { enabled: true, wordsPerLine: 3 },
    };
    expect(describeChanges(base, next)).toEqual(['Added or changed: spotlight', 'Turned captions on', 'Added the dramatization label']);
    expect(describeChanges(next, base)).toEqual(['Removed or replaced: spotlight', 'Turned captions off', 'Removed the dramatization label']);
  });

  it('notices a moved effect and a new caption look', () => {
    const a: DraftPlan = { ...base, steps: [{ fx: 'lean-in', start: 1, end: 3 }], captions: { enabled: true, wordsPerLine: 3, style: { textColor: '#fff' } } };
    const b: DraftPlan = { ...a, steps: [{ fx: 'lean-in', start: 2, end: 4 }], captions: { enabled: true, wordsPerLine: 3, style: { textColor: '#000' } } };
    expect(describeChanges(a, b)).toEqual(['Added or changed: lean-in', 'Removed or replaced: lean-in', 'Changed how the captions look']);
  });

  it('says so when nothing changed', () => {
    expect(describeChanges(base, base)).toEqual(['Rendered again with the same settings']);
  });
});

describe('draft numbers and review', () => {
  it('counts on from the highest number', () => {
    expect(nextNumber(undefined)).toBe(1);
    expect(nextNumber([draft(1), draft(2)])).toBe(3);
  });

  it('goes draft, submitted, approved, and only a reviewed draft can be approved', () => {
    const list = [draft(1), draft(2)];
    expect(() => approveDraft(list, 1)).toThrow();
    expect(submitDraft(list, 1).status).toBe('in_review');
    expect(() => submitDraft(list, 1)).toThrow();
    expect(approveDraft(list, 1).status).toBe('approved');
    expect(() => submitDraft(list, 1)).toThrow();
    expect(list[1].status).toBe('draft');
  });

  it('keeps the reviewer note on changes needed and clears it when resubmitted', () => {
    const list = [draft(1)];
    submitDraft(list, 1);
    expect(requestDraftChanges(list, 1, 'Hook is too slow')).toMatchObject({ status: 'changes_needed', note: 'Hook is too slow' });
    expect(submitDraft(list, 1)).toMatchObject({ status: 'in_review', note: '' });
  });

  it('refuses a draft that does not exist', () => {
    expect(() => submitDraft([draft(1)], 5)).toThrow();
  });
});
