import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { PriceCheck, PriceRow } from '../lib/types';
import { useToast } from '../state/Toast';
import { Badge, Button, Card, CardHeader } from './ui';

const fmt = (n: number | null) => (n === null ? '—' : `$${n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2)}`);

/** Asks Higgsfield what each model costs right now and shows what differs from this app's saved prices. Free: nothing is generated. */
export function PriceCheckCard({ last, promoEnds, onChecked }: { last: PriceCheck | null; promoEnds: string | null; onChecked: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceCheck | null>(last);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<PriceCheck>('/settings/higgsfield/check-prices');
      setResult(r);
      onChecked();
      toast.success(r.counts.changed ? `${r.counts.changed} price${r.counts.changed > 1 ? 's' : ''} differ from the saved snapshot` : 'Prices checked');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const changed = result?.rows.filter((r) => r.status === 'changed') ?? [];
  const info = result?.rows.filter((r) => r.status === 'info') ?? [];
  const errors = result?.rows.filter((r) => r.status === 'error') ?? [];
  const promoOver = promoEnds ? new Date(`${promoEnds}T23:59:59Z`).getTime() < Date.now() : false;

  return (
    <Card className="p-5 xl:col-span-2">
      <CardHeader
        eyebrow="Higgsfield’s own prices"
        title="Check prices"
        action={<Button variant="primary" loading={busy} onClick={() => void run()}><RefreshCw className="h-4 w-4" aria-hidden /> Check prices now</Button>}
      />
      <div className="space-y-2 text-sm text-slate-400">
        <p>Asks Higgsfield what each model costs right now (at default settings) and compares it with this app’s saved prices. It’s a free lookup: nothing is generated or charged.</p>
        <p>Cost dialogs already use Higgsfield’s own quote for your exact settings whenever it gives a number, so this is for seeing what changed, not something you must do before generating.</p>
        {promoEnds && <p className={promoOver ? 'font-medium text-amber-600' : ''}>{promoOver ? `The launch promotion ended ${promoEnds}, so run a check.` : `Most video models are on a promotional rate until ${promoEnds}. You’ll get a reminder in the bell icon after that date.`}</p>}
      </div>

      {result && (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Checked {timeAgo(result.checkedAt)}</span>
            <Badge tone="emerald">{result.counts.match} match</Badge>
            {result.counts.changed > 0 && <Badge tone="amber">{result.counts.changed} differ</Badge>}
            {result.counts.info > 0 && <Badge>{result.counts.info} described in words</Badge>}
            {result.counts.error > 0 && <Badge tone="rose">{result.counts.error} couldn’t be checked</Badge>}
          </div>

          {changed.length > 0 && <Table title="Differs from the saved snapshot" rows={changed} />}
          {info.length > 0 && (
            <details className="mt-3 rounded-xl border border-slate-800 p-3">
              <summary className="cursor-pointer text-sm font-medium">Models Higgsfield prices in words ({info.length})</summary>
              <p className="mt-2 text-xs text-slate-500">These cost different amounts depending on length, resolution or input, so Higgsfield returns a description instead of one number. The cost dialogs use the saved estimate for them.</p>
              <ul className="mt-2 space-y-2">
                {uniqueByModel(info).map((r) => <li key={r.modelId} className="text-sm"><span className="font-medium">{r.model}</span><p className="text-xs text-slate-500">{r.description}</p></li>)}
              </ul>
            </details>
          )}
          {errors.length > 0 && (
            <details className="mt-3 rounded-xl border border-slate-800 p-3">
              <summary className="cursor-pointer text-sm font-medium">Couldn’t be checked ({errors.length})</summary>
              <ul className="mt-2 space-y-1 text-xs text-slate-500">{errors.map((r) => <li key={r.modelId + r.modeId}><strong>{r.model} · {r.mode}:</strong> {r.note}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

const uniqueByModel = (rows: PriceRow[]) => [...new Map(rows.map((r) => [r.modelId, r])).values()];

function Table({ title, rows }: { title: string; rows: PriceRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800">
      <div className="bg-slate-950/50 px-3 py-2 text-xs font-medium uppercase tracking-wider text-slate-500">{title}</div>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500"><tr><th className="px-3 py-1.5 font-medium">Model</th><th className="px-3 py-1.5 text-right font-medium">Saved</th><th className="px-3 py-1.5 text-right font-medium">Higgsfield</th><th className="px-3 py-1.5 text-right font-medium">Change</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.modelId + r.modeId} className="border-t border-slate-800">
              <td className="px-3 py-1.5">{r.model} <span className="text-xs text-slate-500">· {r.mode}</span></td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.snapshotUsd)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.liveUsd)}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${r.diffPct !== null && r.diffPct > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{r.diffPct === null ? '—' : `${r.diffPct > 0 ? '+' : ''}${r.diffPct}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-slate-500">Per request at each model’s default settings (e.g. one 5-second video, sound on).</p>
    </div>
  );
}
