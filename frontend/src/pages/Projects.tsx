import { Clapperboard, Megaphone, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, ProgressBar, Skeleton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import type { Project, ProjectTypeDef, ProjectTypeId } from '../lib/types';
import { useToast } from '../state/Toast';

const ICON: Record<ProjectTypeId, typeof Clapperboard> = { micro_drama: Clapperboard, ad_campaign: Megaphone };

export default function Projects() {
  useDocumentTitle('Projects');
  const canWrite = useCan('user');
  const navigate = useNavigate();
  const toast = useToast();
  const list = useApi<Project[]>('/projects');
  const types = useApi<ProjectTypeDef[]>('/projects/types');
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ProjectTypeId>('micro_drama');
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const b = budget.trim() === '' ? 0 : Number(budget);
    if (!Number.isFinite(b) || b < 0) return setError('Budget must be a number, or empty for no cap');
    setBusy(true);
    setError(null);
    try {
      const p = await api.post<Project>('/projects', { name: name.trim(), type, budgetUsd: b });
      toast.success('Project created');
      navigate(`/projects/${p.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Create" title="Projects" actions={canWrite && <Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden /> New project</Button>} />
      <p className="mb-6 max-w-3xl text-sm text-slate-400">A project is one thing you’re making, such as a micro drama series or an ad campaign. It keeps the brief, the shots or ad units, the characters and products, the budget, and a chat with Claude that helps you plan it.</p>

      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : list.data.length === 0 ? (
        <EmptyState title="No projects yet" hint="Start one and the Director will help you build the brief, plan the shots or ads, and keep an eye on cost." action={canWrite ? <Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden /> New project</Button> : undefined} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((p) => {
            const Icon = ICON[p.type];
            const def = types.data?.find((t) => t.id === p.type);
            const pct = p.budgetUsd > 0 ? ((p.spentUsd ?? 0) / p.budgetUsd) * 100 : 0;
            return (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="block h-full">
                  <Card className="h-full p-5 transition hover:border-slate-600">
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-500/10 text-cyan-600"><Icon className="h-5 w-5" aria-hidden /></span>
                      <Badge>{def?.label ?? p.type}</Badge>
                    </div>
                    <h2 className="mt-3 text-lg font-semibold">{p.name}</h2>
                    {p.description && <p className="mt-0.5 line-clamp-2 text-sm text-slate-400">{p.description}</p>}
                    <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                      <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">{def?.itemLabel ?? 'Item'}s</dt><dd className="font-medium tabular-nums">{p.itemCount ?? 0}</dd></div>
                      <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">Approved</dt><dd className="font-medium tabular-nums">{p.approvedCount ?? 0}</dd></div>
                      <div><dt className="text-[11px] uppercase tracking-wider text-slate-500">Spent</dt><dd className="font-medium tabular-nums">{usd(p.spentUsd ?? 0)}</dd></div>
                    </dl>
                    {p.budgetUsd > 0 && <div className="mt-3"><ProgressBar label={`${p.name} budget used`} value={pct} tone={pct >= 100 ? 'rose' : pct >= 80 ? 'amber' : 'cyan'} /><div className="mt-1 text-[11px] text-slate-500">{Math.round(pct)}% of {usd(p.budgetUsd)}</div></div>}
                    <p className="mt-3 text-xs text-slate-500">Updated {timeAgo(p.updatedAt)}</p>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New project">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">What are you making?</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(types.data ?? []).map((t) => {
                const Icon = ICON[t.id];
                return (
                  <label key={t.id} className={`flex cursor-pointer gap-3 rounded-2xl border p-3 transition ${type === t.id ? 'border-cyan-500 bg-cyan-500/5 ring-2 ring-cyan-500/30' : 'border-slate-700 hover:border-slate-500'}`}>
                    <input type="radio" name="ptype" aria-label={t.label} className="sr-only" checked={type === t.id} onChange={() => setType(t.id)} />
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-cyan-600" aria-hidden />
                    <span><span className="block text-sm font-semibold">{t.label}</span><span className="mt-0.5 block text-xs text-slate-500">{t.description}</span></span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <Field label="Name" htmlFor="np-name"><Input id="np-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'micro_drama' ? 'The Last Train' : 'Spring launch'} /></Field>
          <Field label="Budget (USD, optional)" htmlFor="np-budget" hint="Generation stops short of this. You can change it any time.">
            <Input id="np-budget" type="number" min={0} step="0.01" inputMode="decimal" placeholder="No cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          {error && <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Create project</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
