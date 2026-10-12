import { ArrowLeft, Layers, MessageSquare, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCan } from '../auth/context';
import { AssetsPanel } from '../components/project/AssetsPanel';
import { Board } from '../components/project/Board';
import { BriefPanel } from '../components/project/BriefPanel';
import { ChatPanel } from '../components/project/ChatPanel';
import { GenerateDialog } from '../components/project/GenerateDialog';
import { ItemEditor } from '../components/project/ItemEditor';
import { VariantDialog } from '../components/project/VariantDialog';
import { Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, ProgressBar, Skeleton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import type { BoardItem, ChatChanged, ProjectSnapshot, StudioCatalog } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useToast } from '../state/Toast';

type Tab = 'board' | 'brief' | 'assets' | 'workflows' | 'chat';

export default function Project() {
  const { id = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const canWrite = useCan('user');
  const { runTick } = useRealtime();
  const snapApi = useApi<ProjectSnapshot>(`/projects/${id}`);
  const catalogApi = useApi<StudioCatalog>('/studio/models');
  const snap = snapApi.data;
  const catalog = catalogApi.data;
  useDocumentTitle(snap?.project.name ?? 'Project');

  const [tab, setTab] = useState<Tab>('board');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState<BoardItem[] | null>(null);
  const [variants, setVariants] = useState(false);

  const reload = snapApi.reload;
  // A generation finishing (or any run changing) updates card statuses and takes.
  useEffect(() => {
    if (runTick > 0) reload();
  }, [runTick, reload]);

  // Forget selections for cards that no longer exist.
  useEffect(() => {
    if (!snap) return;
    const ids = new Set(snap.items.map((i) => i.id));
    setSelected((s) => (s.size && [...s].some((x) => !ids.has(x)) ? new Set([...s].filter((x) => ids.has(x))) : s));
  }, [snap]);

  const onChat = useCallback(
    (c: ChatChanged) => {
      reload();
      if (c.workflows) toast.info('The Director saved a workflow. Open the Workflows tab to review it.');
    },
    [reload, toast],
  );
  const closeEditor = useCallback(() => setEditingId(null), []);
  const closeGenerate = useCallback(() => setGenerating(null), []);
  const closeVariants = useCallback(() => setVariants(false), []);
  const select = useCallback((ids: string[], on: boolean) => setSelected((s) => {
    const n = new Set(s);
    for (const i of ids) (on ? n.add(i) : n.delete(i));
    return n;
  }), []);

  const groups = useMemo(() => [...new Set(snap?.items.map((i) => i.group).filter(Boolean) ?? [])], [snap]);
  const editing = snap?.items.find((i) => i.id === editingId) ?? null;

  const addItem = async (group: string) => {
    if (!snap) return;
    try {
      const [created] = await api.post<BoardItem[]>(`/projects/${snap.project.id}/items`, { title: `New ${snap.type.itemLabel.toLowerCase()}`, group });
      reload();
      setEditingId(created.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const newWorkflow = async () => {
    if (!snap) return;
    try {
      const w = await api.post<{ id: string }>('/workflows', { name: `${snap.project.name} workflow`, projectId: snap.project.id });
      navigate(`/workflows/${w.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (snapApi.error) return <div className="mx-auto mt-16 max-w-md"><ErrorState message={snapApi.error} onRetry={reload} /></div>;
  if (!snap) return <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-96" /></div>;

  const { project, type, spend } = snap;
  const budget = project.budgetUsd;
  const pct = budget > 0 ? (spend.totalUsd / budget) * 100 : 0;
  const approved = snap.items.filter((i) => i.status === 'approved').length;
  const remaining = snap.items.filter((i) => i.status !== 'approved');
  const remainingCost = remaining.reduce((s, i) => s + (i.estimate.ok ? (i.estimate.costUsd ?? 0) : 0), 0);

  const tabs: { id: Tab; label: string; icon?: typeof Layers; mobileOnly?: boolean }[] = [
    { id: 'board', label: `${type.itemLabel} board (${snap.items.length})` },
    { id: 'brief', label: type.id === 'micro_drama' ? 'Story bible' : 'Brand kit' },
    { id: 'assets', label: `Assets (${snap.assets.length})` },
    { id: 'workflows', label: `Workflows (${snap.workflows.length})` },
    { id: 'chat', label: 'Chat', icon: MessageSquare, mobileOnly: true },
  ];

  return (
    <div>
      <Link to="/projects" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-300"><ArrowLeft className="h-4 w-4" aria-hidden /> All projects</Link>
      <PageHeader
        eyebrow={type.label}
        title={project.name}
        actions={
          <>
            {type.id === 'ad_campaign' && canWrite && <Button onClick={() => setVariants(true)}><Layers className="h-4 w-4" aria-hidden /> Variant matrix</Button>}
            {canWrite && <Button variant="primary" onClick={() => void addItem(groups[groups.length - 1] ?? '')}><Plus className="h-4 w-4" aria-hidden /> Add {type.itemLabel.toLowerCase()}</Button>}
          </>
        }
      />

      <Card className="mb-5 grid gap-4 p-4 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500">Spent</div>
          <div className="text-2xl font-semibold tabular-nums">{usd(spend.totalUsd)}</div>
          <div className="text-xs text-slate-500">generation {usd(spend.generationUsd + spend.inFlightUsd)} · chat {usd(spend.chatUsd)}</div>
          {budget > 0 && <div className="mt-2"><ProgressBar label="Budget used" value={pct} tone={pct >= 100 ? 'rose' : pct >= 80 ? 'amber' : 'cyan'} /><div className="mt-1 text-xs text-slate-500">{Math.round(pct)}% of {usd(budget)} budget</div></div>}
          {budget <= 0 && <div className="mt-2 text-xs text-slate-500">No budget cap set <button className="underline" onClick={() => setTab('brief')}>(set one)</button></div>}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500">Progress</div>
          <div className="text-2xl font-semibold tabular-nums">{approved}<span className="text-base font-normal text-slate-500"> / {snap.items.length} approved</span></div>
          <div className="mt-2"><ProgressBar label="Approved" value={snap.items.length ? (approved / snap.items.length) * 100 : 0} /></div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500">To finish</div>
          <div className="text-2xl font-semibold tabular-nums">{usd(remainingCost)}</div>
          <div className="text-xs text-slate-500">estimated for {remaining.length} unapproved {type.itemLabel.toLowerCase()}{remaining.length === 1 ? '' : 's'}</div>
        </div>
      </Card>

      <div role="tablist" aria-label="Project sections" className="mb-5 flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition', t.mobileOnly && 'lg:hidden', tab === t.id ? 'bg-slate-900 text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-100')}>
            {t.icon && <t.icon className="h-4 w-4" aria-hidden />}{t.label}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_25rem]">
        <div className={cx('min-w-0', tab === 'chat' && 'hidden lg:block')}>
          {tab === 'board' && (
            <Board snap={snap} catalog={catalog} selected={selected} onSelect={select} onOpen={(i) => setEditingId(i.id)} onGenerate={setGenerating} onAdd={(g) => void addItem(g)} canWrite={canWrite} />
          )}
          {tab === 'brief' && <BriefPanel snap={snap} onSaved={reload} />}
          {tab === 'assets' && <AssetsPanel projectId={project.id} assets={snap.assets} connected={!!catalog?.connected} onChanged={reload} />}
          {tab === 'workflows' && (
            <div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-2xl text-sm text-slate-400">Workflows run steps automatically: write with Claude, generate, save. Ask the Director to build one, or start a blank one.</p>
                {canWrite && <Button variant="primary" onClick={() => void newWorkflow()}><Plus className="h-4 w-4" aria-hidden /> New workflow</Button>}
              </div>
              {snap.workflows.length === 0 ? (
                <EmptyState title="No workflows in this project" hint="Try asking the Director: “Build a workflow that renders every approved shot in episode 1.”" />
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {snap.workflows.map((w) => (
                    <li key={w.id}>
                      <Link to={`/workflows/${w.id}`} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-card transition hover:border-slate-600">
                        <span className="flex min-w-0 items-center gap-2"><WorkflowIcon className="h-4 w-4 shrink-0 text-cyan-500" aria-hidden /><span className="truncate font-medium">{w.name}</span></span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500"><Badge tone={w.status === 'active' ? 'emerald' : 'slate'}>{w.status}</Badge>{timeAgo(w.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <aside className={cx('lg:sticky lg:top-4', tab === 'chat' ? 'block' : 'hidden lg:block')}>
          <ChatPanel projectId={project.id} type={type} onChanged={onChat} onProgress={reload} className="h-[min(40rem,calc(100vh-9rem))]" />
        </aside>
      </div>

      <ItemEditor projectId={project.id} item={editing} items={snap.items} assets={snap.assets} catalog={catalog} type={type} groups={groups} onClose={closeEditor} onSaved={reload} onGenerate={(i) => { setEditingId(null); setGenerating([i]); }} />
      <GenerateDialog projectId={project.id} items={generating} pricesAsOf={catalog?.pricesAsOf} onClose={closeGenerate} onStarted={() => { setGenerating(null); setSelected(new Set()); reload(); }} />
      <VariantDialog projectId={project.id} open={variants} items={snap.items} catalog={catalog} onClose={closeVariants} onCreated={() => { setVariants(false); reload(); }} />
    </div>
  );
}
