import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCan } from '../auth/context';
import { api, errorMessage } from '../lib/api';
import { timeAgo, usd } from '../lib/format';
import type { CreditStatus } from '../lib/types';
import { useToast } from '../state/Toast';
import { Badge, Button, Card, Input, ProgressBar, Skeleton } from './ui';

const INFO = {
  claude: { title: 'Anthropic (Claude) credit', where: 'the Anthropic Console, under Billing' },
  higgsfield: { title: 'Higgsfield credit', where: 'the Higgsfield Console (open.higgsfield.ai), under Billing' },
} as const;

/**
 * What's left on each account. Neither service lets this app read a balance directly, so you enter the figure you see in the
 * console and the dashboard subtracts the spend it records afterwards (live).
 */
export function CreditsPanel({ credits, onChanged }: { credits: CreditStatus[] | null; onChanged: () => void }) {
  return (
    <section aria-label="Credit balances" className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Credit left</h2>
        <p className="text-xs text-slate-500">Estimated from the balance you enter, minus spend tracked here. Check the consoles for the exact figure.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {!credits ? <><Skeleton className="h-36" /><Skeleton className="h-36" /></> : credits.map((c) => <CreditCard key={c.provider} c={c} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function CreditCard({ c, onChanged }: { c: CreditStatus; onChanged: () => void }) {
  const toast = useToast();
  const isAdmin = useCan('admin');
  const info = INFO[c.provider];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setValue(c.remainingUsd !== null ? Math.max(0, c.remainingUsd).toFixed(2) : '');
  }, [editing, c.remainingUsd]);

  const save = async () => {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n) || n < 0) return toast.error('Enter the balance as a number, like 25.50');
    setBusy(true);
    try {
      await api.put(`/settings/credits/${c.provider}`, { balanceUsd: n });
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const usedPct = c.set && c.startingUsd ? Math.min(100, (c.usedSinceUsd / c.startingUsd) * 100) : 0;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm text-slate-400">{info.title}</div>
        {c.set && c.low && <Badge tone={c.remainingUsd !== null && c.remainingUsd <= 0 ? 'rose' : 'amber'}>{c.remainingUsd !== null && c.remainingUsd <= 0 ? 'Out?' : 'Running low'}</Badge>}
      </div>

      {editing ? (
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label htmlFor={`bal-${c.provider}`} className="block text-xs text-slate-500">Balance shown in {info.where} (USD)</label>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">$</span>
            <Input id={`bal-${c.provider}`} type="number" min={0} step="0.01" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="w-36" />
            <Button type="submit" variant="primary" loading={busy}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : c.set ? (
        <>
          <div className={`mt-1 text-3xl font-semibold tabular-nums ${c.low ? 'text-amber-600' : ''}`}>{usd(Math.max(0, c.remainingUsd ?? 0))}</div>
          <div className="mt-2"><ProgressBar label={`${info.title} used`} value={usedPct} tone={c.low ? 'amber' : 'cyan'} /></div>
          <p className="mt-2 text-xs text-slate-500">
            Used {usd(c.usedSinceUsd)} of the {usd(c.startingUsd ?? 0)} you entered {c.asOf ? timeAgo(c.asOf) : ''}. All-time tracked here: {usd(c.lifetimeUsedUsd)}.
          </p>
          {isAdmin && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" aria-hidden /> Update balance</Button>}
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-400">Enter the balance from {info.where} to see how much is left. {c.lifetimeUsedUsd > 0 && <>So far {usd(c.lifetimeUsedUsd)} has been tracked here.</>}</p>
          {isAdmin ? <Button className="mt-3" variant="primary" onClick={() => setEditing(true)}>Enter balance</Button> : <p className="mt-2 text-xs text-slate-500">An admin can enter it.</p>}
        </>
      )}
    </Card>
  );
}
