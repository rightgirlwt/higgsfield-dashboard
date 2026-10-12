import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { ProjectSnapshot } from '../../lib/types';
import { Button, cx } from '../ui';

type Tab = 'board' | 'brief' | 'assets' | 'workflows' | 'chat';

/** A plain, ordered path through a project, with the current step highlighted. Hidden once the person collapses it. */
export function StartHere({ snap, setTab, onAsk, onExport, canWrite }: { snap: ProjectSnapshot; setTab: (t: Tab) => void; onAsk: (text: string) => void; onExport: () => void; canWrite: boolean }) {
  const { project, type, items, assets } = snap;
  const drama = type.id === 'micro_drama';
  const noun = type.itemLabel.toLowerCase();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(`hf_starthere_${project.id}`) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try { localStorage.setItem(`hf_starthere_${project.id}`, o ? 'closed' : 'open'); } catch { /* storage unavailable */ }
      return !o;
    });
  };

  const hasBrief = Object.values(project.brief).some((v) => v?.trim());
  const generated = items.some((i) => i.takeCount > 0);
  const approved = items.some((i) => i.status === 'approved');
  const steps: { title: string; hint: string; done: boolean; optional?: boolean; action?: { label: string; run: () => void } }[] = [
    {
      title: drama ? 'Describe your story' : 'Describe the brand and product',
      hint: drama ? 'A logline is enough to start: who wants what, and what stands in the way.' : 'Who the brand is, what you’re selling, who it’s for.',
      done: hasBrief,
      action: { label: 'Fill in with the Director', run: () => onAsk(drama ? 'Ask me a few questions about my story, then fill in the whole story bible for me.' : 'Ask me a few questions about the brand and product, then fill in the whole brand kit for me.') },
    },
    {
      title: drama ? 'Add your characters' : 'Add the product and logo',
      hint: 'Optional. Photos keep them looking the same everywhere. A character can also have a trained Soul ID.',
      done: assets.length > 0,
      optional: true,
      action: { label: 'Open Assets', run: () => setTab('assets') },
    },
    {
      title: `Build the ${noun} board`,
      hint: `The Director drafts the ${noun}s with prompts and models, and tells you the cost. You can edit any card.`,
      done: items.length > 0,
      action: { label: 'Ask the Director to draft them', run: () => onAsk(drama ? 'Draft the shot list for episode 1 from my story bible, using inexpensive models, and tell me the cost.' : 'Draft three ad concepts with one ad unit each from my brand kit, using inexpensive models, and tell me the cost.') },
    },
    {
      title: 'Generate',
      hint: 'Select cards and press “Review cost and generate”. You see the price first and nothing starts until you confirm.',
      done: generated,
      action: { label: 'Go to the board', run: () => setTab('board') },
    },
    {
      title: 'Pick your favourite takes',
      hint: 'Open a card, go to Takes, and approve the one you like. Not happy? Reject and try again.',
      done: approved,
      action: { label: 'Go to the board', run: () => setTab('board') },
    },
    {
      title: 'Export',
      hint: 'Download the approved clips in order, plus the script and a shot list.',
      done: false,
      action: { label: 'Export', run: onExport },
    },
  ];
  const current = steps.findIndex((s) => !s.done && !s.optional);
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section aria-label="Start here" className="mb-5 rounded-3xl border border-slate-800 bg-slate-900 shadow-card">
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left">
        <span className="text-sm font-semibold">How this works <span className="font-normal text-slate-500">· {doneCount} of {steps.length} steps done</span></span>
        <ChevronDown className={cx('h-4 w-4 text-slate-500 transition', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ol className="grid gap-2 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className={cx('flex gap-3 rounded-2xl border p-3', i === current ? 'border-cyan-500 bg-cyan-500/5' : 'border-slate-800')}>
              <span className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold', s.done ? 'bg-emerald-500 text-white' : i === current ? 'bg-cyan-500 text-white' : 'bg-slate-800 text-slate-400')}>
                {s.done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.title}{s.optional && <span className="ml-1.5 text-xs font-normal text-slate-500">optional</span>}</div>
                <p className="mt-0.5 text-xs text-slate-500">{s.hint}</p>
                {s.action && canWrite && !s.done && <Button size="sm" variant={i === current ? 'primary' : 'secondary'} className="mt-2" onClick={s.action.run}>{s.action.label}</Button>}
                {s.action && s.done && i !== steps.length - 1 && <button className="mt-1.5 text-xs text-cyan-600 underline" onClick={s.action.run}>Open</button>}
                {s.action && i === steps.length - 1 && <Button size="sm" variant={i === current ? 'primary' : 'secondary'} className="mt-2" onClick={s.action.run}>{s.action.label}</Button>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
