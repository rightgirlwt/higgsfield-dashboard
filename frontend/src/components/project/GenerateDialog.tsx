import { AlertTriangle, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { usd } from '../../lib/format';
import type { BoardItem, EstimateResult } from '../../lib/types';
import { useToast } from '../../state/Toast';
import { Badge, Button, ErrorState, Modal, Skeleton } from '../ui';

/**
 * The approval gate. Nothing is generated until the person has seen the price of exactly this batch and pressed the button.
 * The server re-prices on submit and refuses if the cost has gone up since this screen was shown.
 */
export function GenerateDialog({
  projectId, items, pricesAsOf, onClose, onStarted,
}: { projectId: string; items: BoardItem[] | null; pricesAsOf?: string; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [est, setEst] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = items?.map((i) => i.id) ?? [];
  const key = ids.join(',');

  useEffect(() => {
    setEst(null);
    setError(null);
    if (!key) return;
    let live = true;
    api.post<EstimateResult>(`/projects/${projectId}/estimate`, { ids: key.split(',') }).then((r) => live && setEst(r)).catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [projectId, key]);

  const byId = new Map(est?.estimates.map((e) => [e.itemId, e]));
  const over = !!est && est.budgetLeftUsd !== null && est.totalUsd > est.budgetLeftUsd + 1e-9;
  const blocked = (est?.blocked.length ?? 0) > 0;

  const go = async () => {
    if (!est) return;
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/generate`, { ids, expectedTotalUsd: est.totalUsd });
      toast.success(`Started ${ids.length} generation${ids.length > 1 ? 's' : ''}`);
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={items !== null} onClose={onClose} title="Review the cost" wide>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {!est && !error && <Skeleton className="h-40" />}
      {est && items && (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">You’re about to generate <strong className="text-slate-100">{items.length}</strong> item{items.length > 1 ? 's' : ''}. This spends real Higgsfield credits.</p>
          <div className="max-h-72 overflow-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-900 text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="px-3 py-2 font-medium">Item</th><th className="px-3 py-2 font-medium">Model</th><th className="px-3 py-2 text-right font-medium">Cost</th></tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const e = byId.get(i.id);
                  return (
                    <tr key={i.id} className="border-t border-slate-800 align-top">
                      <td className="px-3 py-2"><div className="font-medium">{i.title}</div>{i.group && <div className="text-xs text-slate-500">{i.group}</div>}</td>
                      <td className="px-3 py-2 text-slate-400">
                        {e?.ok ? (
                          <>{e.model} · {e.mode}<div className="text-xs text-slate-500">{e.outputs} output{e.outputs > 1 ? 's' : ''}{e.seconds > 1 ? ` × ${e.seconds}s` : ''}{e.basis !== 'live' && e.precision === 'from' ? ' · low end of range' : ''}{e.basis === 'live' ? ' · Higgsfield’s quote' : ''}{e.promoEnds ? ` · promo until ${e.promoEnds}` : ''}</div></>
                        ) : (
                          <span className="text-rose-300">{e && !e.ok ? e.reason : '…'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{e?.ok ? (e.costUsd === null ? <Badge tone="amber">no price</Badge> : usd(e.costUsd)) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl bg-slate-950/60 p-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500">Total</div>
              <div className="text-3xl font-semibold tabular-nums">{usd(est.totalUsd)}</div>
            </div>
            {est.budgetUsd > 0 && (
              <div className="text-right text-sm text-slate-400">
                Project budget {usd(est.budgetUsd)}<br />
                <span className={over ? 'text-rose-300' : ''}>{usd(est.budgetLeftUsd ?? 0)} left before this batch</span>
              </div>
            )}
          </div>

          {est.unpriced.length > 0 && <p className="flex gap-2 text-xs text-amber-300"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {est.unpriced.length} item(s) have no known price, so they’re counted as $0. Set a price in Settings → Higgsfield to track them.</p>}
          {over && <p role="alert" className="flex gap-2 text-sm text-rose-300"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> This batch would go over the project budget. Raise the budget or choose fewer items.</p>}
          {blocked && <p role="alert" className="flex gap-2 text-sm text-rose-300"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> Some items can’t be generated yet. Open them and fix what’s listed above.</p>}
          <p className="text-xs text-slate-500">{est.estimates.length > 0 && est.estimates.every((e) => e.ok && e.basis === 'live') ? 'Prices are Higgsfield’s own quote for these exact settings.' : `Where Higgsfield doesn’t quote a single number, prices come from its list prices${pricesAsOf ? ` as of ${pricesAsOf}` : ''} (or your overrides).`} The final charge can differ slightly; Higgsfield’s billing page is the final word.</p>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Not yet</Button>
            <Button variant="primary" loading={busy} disabled={blocked || over} onClick={() => void go()}><Wand2 className="h-4 w-4" aria-hidden /> Generate for {usd(est.totalUsd)}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
