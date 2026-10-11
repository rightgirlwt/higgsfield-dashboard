import { LayoutTemplate, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Modal, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import type { Workflow, WorkflowListItem, WorkflowTemplate } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useToast } from '../state/Toast';

export default function Workflows() {
  useDocumentTitle('Workflows');
  const nav = useNavigate();
  const toast = useToast();
  const canWrite = useCan('user');
  const { runTick } = useRealtime();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useApi<WorkflowListItem[]>(`/workflows${qs({ q: dq })}`);
  const templates = useApi<WorkflowTemplate[]>('/workflows/templates');
  const [tplOpen, setTplOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = list.reload;
  useEffect(() => {
    if (runTick > 0) reload();
  }, [runTick, reload]);

  const create = async () => {
    setBusy('new');
    try {
      const w = await api.post<Workflow>('/workflows', {
        name: 'Untitled workflow',
        definition: { nodes: [{ id: 'trigger-1', type: 'trigger', position: { x: 40, y: 120 }, data: { label: 'Manual trigger', source: 'manual' } }], edges: [] },
      });
      nav(`/workflows/${w.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  const fromTemplate = async (t: WorkflowTemplate) => {
    setBusy(t.id);
    try {
      const w = await api.post<Workflow>('/workflows/from-template', { templateId: t.id });
      nav(`/workflows/${w.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  const remove = async (w: WorkflowListItem) => {
    if (!window.confirm(`Delete "${w.name}"? Its run history is kept in totals but the workflow is removed.`)) return;
    try {
      await api.del(`/workflows/${w.id}`);
      toast.success('Workflow deleted');
      list.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Automation"
        title="Workflows"
        actions={
          canWrite && (
            <>
              <Button onClick={() => setTplOpen(true)}>
                <LayoutTemplate className="h-4 w-4" aria-hidden /> Template library
              </Button>
              <Button variant="primary" loading={busy === 'new'} onClick={create}>
                <Plus className="h-4 w-4" aria-hidden /> New workflow
              </Button>
            </>
          )
        }
      />

      <div className="relative mb-5 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
        <Input aria-label="Search workflows" className="pl-9" placeholder="Search workflows…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : list.data.length === 0 ? (
        <EmptyState
          title={dq ? 'No workflows match your search' : 'No workflows yet'}
          hint={dq ? undefined : 'Start from a template or build one from scratch.'}
          action={canWrite && !dq ? <Button variant="primary" onClick={() => setTplOpen(true)}>Browse templates</Button> : undefined}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((w) => (
            <li key={w.id}>
              <Card className="flex h-full flex-col p-5 transition hover:border-slate-700">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <Link to={`/workflows/${w.id}`} className="text-base font-semibold hover:text-cyan-300">{w.name}</Link>
                  <StatusBadge status={w.status} />
                </div>
                <p className="mb-4 line-clamp-2 flex-1 text-sm text-slate-400">{w.description || 'No description'}</p>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>{w.nodeCount} nodes · v{w.version} · {w.runCount} runs</span>
                  <span className="flex items-center gap-2">
                    {w.lastStatus && <StatusBadge status={w.lastStatus} />}
                    {timeAgo(w.lastRunAt ?? w.updatedAt)}
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Link to={`/workflows/${w.id}`} className="flex-1">
                    <Button className="w-full">{canWrite ? 'Open builder' : 'View'}</Button>
                  </Link>
                  {canWrite && (
                    <Button variant="ghost" aria-label={`Delete ${w.name}`} onClick={() => remove(w)}>
                      <Trash2 className="h-4 w-4 text-rose-300" aria-hidden />
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Modal open={tplOpen} onClose={() => setTplOpen(false)} title="Workflow template library" wide>
        {!templates.data ? (
          <Skeleton className="h-40" />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {templates.data.map((t) => (
              <li key={t.id} className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{t.name}</span>
                  <Badge tone="violet">{t.category}</Badge>
                </div>
                <p className="mb-3 flex-1 text-sm text-slate-400">{t.description}</p>
                <Button size="sm" variant="primary" loading={busy === t.id} onClick={() => fromTemplate(t)}>
                  Use template · {t.nodeCount} nodes
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
