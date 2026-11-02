import { Plug } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Card, CardHeader, Field, Input } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { num } from '../../lib/format';
import { cssColor } from '../../lib/theme';
import { useToast } from '../../state/Toast';

export const tooltipStyle = { background: cssColor('slate-900'), border: `1px solid ${cssColor('slate-700')}`, borderRadius: 12, color: cssColor('slate-100') } as const;
export const AXIS = cssColor('slate-400');
export const SORTS: [string, string][] = [['recent', 'Newest'], ['reach', 'Reach'], ['views', 'Views'], ['engagement', 'Engagement'], ['saved', 'Saves'], ['shares', 'Shares'], ['comments', 'Comments'], ['likes', 'Likes']];
export const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const n = (v: number | null | undefined) => (v == null ? '–' : num(v));
export const pct = (v: number | null | undefined) => (v == null ? '–' : `${v}%`);
export const money = (v: number | null | undefined, currency: string) => (v == null ? '–' : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v));

export function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </Card>
  );
}

/** Pick one of the channel's accounts. Shown only when there is more than one. */
export function AccountTabs({ label, items, current, onPick }: { label: string; items: { id: string; name: string }[]; current: string | undefined; onPick: (id: string) => void }) {
  if (items.length < 2) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label={label}>
      {items.map((a) => (
        <button key={a.id} role="tab" aria-selected={a.id === current} onClick={() => onPick(a.id)} className={`rounded-full border px-3 py-1.5 text-sm ${a.id === current ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}>
          {a.name}
        </button>
      ))}
    </div>
  );
}

/** The admin's box for pasting a token, with the steps and one optional account number. */
export function ConnectBox({ title, intro, steps, idLabel, idPlaceholder, connect }: { title: string; intro: ReactNode; steps: ReactNode; idLabel: string; idPlaceholder: string; connect: (token: string, id: string) => Promise<void> }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await connect(token.trim(), id.trim());
      setToken('');
      setId('');
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  return (
    <Card className="mt-4 p-4">
      <CardHeader eyebrow="Admin" title={title} />
      <p className="mt-2 text-sm text-slate-400">{intro}</p>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-300 hover:text-white">How to get the token</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-slate-400">{steps}</ol>
      </details>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), token.trim() && !busy && void go())}>
        <div className="min-w-60 flex-1">
          <Field label="Access token">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="IGAA… or EAA…" />
          </Field>
        </div>
        <div className="min-w-48">
          <Field label={idLabel} hint="Only if asked">
            <Input inputMode="text" autoComplete="off" value={id} onChange={(e) => setId(e.target.value)} placeholder={idPlaceholder} />
          </Field>
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}><Plug className="h-4 w-4" aria-hidden /> Connect and read</Button>
      </form>
    </Card>
  );
}
