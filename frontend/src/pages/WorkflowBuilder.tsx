import { AlertTriangle, ArrowLeft, Bell, Brain, CheckCircle2, CircleDot, Flag, Play, Save, Shuffle, Sparkles, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Link, useParams } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, cx, ErrorState, Field, Input, Modal, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { dateTime, ms, timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import type { ModelInfo, NodeType, Run, RunLog, StudioCatalog, ValidationIssue, Workflow, WorkflowDefinition } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useToast } from '../state/Toast';

type NodeStatus = 'idle' | 'running' | 'done' | 'failed';
interface NData {
  label?: string;
  __status?: NodeStatus;
  __issue?: 'error' | 'warning';
  [k: string]: any;
}

const META: Record<NodeType, { label: string; icon: typeof Zap; ring: string; chip: string; blurb: string }> = {
  trigger: { label: 'Trigger', icon: Zap, ring: 'border-emerald-500/60', chip: 'bg-emerald-500/15 text-emerald-300', blurb: 'Input source' },
  llm: { label: 'LLM', icon: Brain, ring: 'border-violet-500/60', chip: 'bg-violet-500/15 text-violet-300', blurb: 'Claude prompt' },
  generate: { label: 'Generate', icon: Sparkles, ring: 'border-pink-500/60', chip: 'bg-pink-500/15 text-pink-300', blurb: 'Higgsfield image/video' },
  transform: { label: 'Transform', icon: Shuffle, ring: 'border-cyan-500/60', chip: 'bg-cyan-500/15 text-cyan-300', blurb: 'Reshape data' },
  action: { label: 'Action', icon: Bell, ring: 'border-amber-500/60', chip: 'bg-amber-500/15 text-amber-300', blurb: 'Save / notify' },
  output: { label: 'Output', icon: Flag, ring: 'border-sky-500/60', chip: 'bg-sky-500/15 text-sky-300', blurb: 'Result' },
};

function summary(type: NodeType, d: NData): string {
  switch (type) {
    case 'trigger':
      return d.source === 'schedule' ? `Every ${d.intervalMinutes ?? 60} min` : d.source === 'higgsfield' ? 'Recent Studio results' : 'Manual';
    case 'llm':
      return d.model || 'default model';
    case 'generate':
      return d.model || 'pick a model';
    case 'transform':
      return d.mode || 'template';
    case 'action':
      return d.action || 'log';
    default:
      return 'Run result';
  }
}

function FlowNode({ type, data, selected }: NodeProps<NData>) {
  const t = type as NodeType;
  const m = META[t];
  const Icon = m.icon;
  const st = data.__status ?? 'idle';
  return (
    <div
      className={cx('w-52 rounded-xl border-2 bg-slate-900 p-3 shadow-lg transition', m.ring, selected && 'ring-2 ring-cyan-400', st === 'running' && 'animate-pulse shadow-cyan-500/30', st === 'done' && 'border-emerald-400', st === 'failed' && 'border-rose-500')}
      aria-label={`${m.label} node: ${data.label ?? m.label}`}
    >
      {t !== 'trigger' && <Handle type="target" position={Position.Left} />}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', m.chip)}>
          <Icon className="h-3 w-3" aria-hidden /> {m.label}
        </span>
        <span className="flex items-center gap-1">
          {data.__issue && <AlertTriangle className={cx('h-3.5 w-3.5', data.__issue === 'error' ? 'text-rose-400' : 'text-amber-300')} aria-label={`Has ${data.__issue}`} />}
          {st === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-label="Completed" />}
          {st === 'running' && <CircleDot className="h-3.5 w-3.5 text-cyan-300" aria-label="Running" />}
          {st === 'failed' && <AlertTriangle className="h-3.5 w-3.5 text-rose-400" aria-label="Failed" />}
        </span>
      </div>
      <div className="truncate text-sm font-medium text-slate-100">{data.label || m.label}</div>
      <div className="truncate text-xs text-slate-500">{summary(t, data)}</div>
      {t !== 'output' && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
const nodeTypes = { trigger: FlowNode, llm: FlowNode, generate: FlowNode, transform: FlowNode, action: FlowNode, output: FlowNode };

const DEFAULT_DATA: Record<NodeType, NData> = {
  trigger: { label: 'Trigger', source: 'manual' },
  llm: { label: 'Claude prompt', userPrompt: 'Summarize:\n\n{{input}}', maxTokens: 512 },
  generate: { label: 'Generate media', model: 'soul-2', prompt: '{{input}}', count: 1 },
  transform: { label: 'Transform', mode: 'template', template: '{{input}}' },
  action: { label: 'Action', action: 'log', message: '{{input}}' },
  output: { label: 'Output' },
};

const strip = (d: NData): NData => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('__')));

function toDefinition(nodes: Node<NData>[], edges: Edge[]): WorkflowDefinition {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type as NodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: strip(n.data) })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/** Would adding source→target create a cycle? (i.e. is `source` reachable from `target`.) */
function wouldCycle(edges: Edge[], source: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.source === cur) stack.push(e.target);
  }
  return false;
}

export default function WorkflowBuilder() {
  const { id } = useParams();
  const wf = useApi<Workflow>(id ? `/workflows/${id}` : null);
  if (wf.error) return <ErrorState message={wf.error} onRetry={wf.reload} />;
  if (!wf.data) return <Skeleton className="h-[70vh]" />;
  return (
    <ReactFlowProvider>
      <Builder key={wf.data.id} initial={wf.data} />
    </ReactFlowProvider>
  );
}

function Builder({ initial }: { initial: Workflow }) {
  const toast = useToast();
  const canWrite = useCan('user');
  const { jobs, logs: liveLogs } = useRealtime();
  const models = useApi<ModelInfo[]>('/models');
  const studioCatalog = useApi<StudioCatalog>('/studio/models');
  useDocumentTitle(initial.name);

  const [name, setName] = useState(initial.name);
  const [status, setStatus] = useState(initial.status);
  const [nodes, setNodes, onNodesChange] = useNodesState<NData>(initial.definition.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data: n.data })));
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.definition.edges.map((e) => ({ ...e })));
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>(initial.issues ?? []);
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState('');
  const [starting, setStarting] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [panel, setPanel] = useState<'run' | 'history'>('run');
  const counter = useRef(nodes.length);
  const history = useApi<Run[]>(`/workflows/${initial.id}/runs`);

  const markDirty = useCallback(() => setDirty(true), []);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => (e.preventDefault(), (e.returnValue = ''));
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Live validation (debounced) against the server's rules.
  useEffect(() => {
    const t = setTimeout(() => {
      api.post<{ issues: ValidationIssue[] }>('/workflows/validate', { definition: toDefinition(nodes, edges) }).then((r) => setIssues(r.issues)).catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const isValidConnection = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      const src = nodes.find((n) => n.id === c.source);
      const tgt = nodes.find((n) => n.id === c.target);
      if (!src || !tgt || tgt.type === 'trigger' || src.type === 'output') return false;
      if (edges.some((e) => e.source === c.source && e.target === c.target)) return false;
      return !wouldCycle(edges, c.source, c.target);
    },
    [nodes, edges],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      if (!isValidConnection(c)) return;
      setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.target}` }, es));
      markDirty();
    },
    [isValidConnection, setEdges, markDirty],
  );

  const addNode = (type: NodeType) => {
    if (type === 'trigger' && nodes.some((n) => n.type === 'trigger')) {
      toast.error('A workflow can only have one trigger');
      return;
    }
    counter.current += 1;
    const nid = `${type}-${Date.now().toString(36)}${counter.current}`;
    const k = nodes.length;
    setNodes((ns) => [...ns, { id: nid, type, position: { x: 60 + (k % 4) * 60, y: 60 + k * 70 }, data: { ...DEFAULT_DATA[type] } }]);
    setSelected(nid);
    markDirty();
  };

  const patchNode = (nid: string, patch: Partial<NData>) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  };
  const deleteNode = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSelected(null);
    markDirty();
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const w = await api.put<Workflow>(`/workflows/${initial.id}`, { name: name.trim() || 'Untitled workflow', status, definition: toDefinition(nodes, edges) });
      setIssues(w.issues ?? []);
      setDirty(false);
      toast.success(`Saved (v${w.version})`);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const startRun = async () => {
    setStarting(true);
    try {
      if (dirty && !(await save())) return;
      const r = await api.post<{ run: Run }>(`/workflows/${initial.id}/run`, { input: runInput.trim() ? { text: runInput } : {} });
      setActiveRun(r.run.id);
      setPanel('run');
      setRunOpen(false);
      history.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  // ---- run viewing: fetched detail merged with live socket logs ---------------------------
  const [fetched, setFetched] = useState<{ run: Run; logs: RunLog[] } | null>(null);
  const live = activeRun ? jobs[activeRun] : undefined;
  const liveStatus = live?.status;
  useEffect(() => {
    if (!activeRun) return;
    let ok = true;
    api.get<{ run: Run; logs: RunLog[] }>(`/runs/${activeRun}`).then((d) => ok && setFetched(d)).catch(() => undefined);
    return () => {
      ok = false;
    };
  }, [activeRun, liveStatus]);
  useEffect(() => {
    if (liveStatus === 'completed' || liveStatus === 'failed') history.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStatus]);

  const runLogs = useMemo(() => {
    if (!activeRun) return [];
    const byId = new Map<string, RunLog>();
    for (const l of fetched?.run.id === activeRun ? fetched.logs : []) byId.set(l.id, l);
    for (const l of liveLogs) if (l.runId === activeRun) byId.set(l.id, l);
    return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }, [activeRun, fetched, liveLogs]);
  const run = (fetched?.run.id === activeRun ? fetched.run : null) ?? (live as Run | undefined) ?? null;
  const runStatus = live?.status ?? run?.status;

  // Node highlight state derived from the run's log lines.
  const nodeStatus = useMemo(() => {
    const m: Record<string, NodeStatus> = {};
    for (const l of runLogs) {
      if (!l.nodeId) continue;
      if (l.message.startsWith('▶')) m[l.nodeId] = 'running';
      else if (l.message.startsWith('✓')) m[l.nodeId] = 'done';
    }
    if (runStatus === 'failed') for (const k of Object.keys(m)) if (m[k] === 'running') m[k] = 'failed';
    return m;
  }, [runLogs, runStatus]);

  const issueByNode = useMemo(() => {
    const m: Record<string, 'error' | 'warning'> = {};
    for (const i of issues) if (i.nodeId) m[i.nodeId] = i.level === 'error' || m[i.nodeId] === 'error' ? 'error' : 'warning';
    return m;
  }, [issues]);

  const display = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, __status: activeRun ? (nodeStatus[n.id] ?? 'idle') : 'idle', __issue: issueByNode[n.id] } })), [nodes, nodeStatus, issueByNode, activeRun]);
  const sel = nodes.find((n) => n.id === selected) ?? null;
  const errors = issues.filter((i) => i.level === 'error');

  const openHistoryRun = (r: Run) => {
    setFetched(null);
    setActiveRun(r.id);
    setPanel('run');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/workflows" aria-label="Back to workflows" onClick={(e) => dirty && !window.confirm('Discard unsaved changes?') && e.preventDefault()}>
          <Button size="sm" variant="ghost"><ArrowLeft className="h-4 w-4" aria-hidden /> Workflows</Button>
        </Link>
        <Input aria-label="Workflow name" className="max-w-xs text-base font-semibold" value={name} disabled={!canWrite} onChange={(e) => (setName(e.target.value), markDirty())} maxLength={120} />
        <Select aria-label="Workflow status" className="w-32" value={status} disabled={!canWrite} onChange={(e) => (setStatus(e.target.value as Workflow['status']), markDirty())}>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
        </Select>
        {dirty && <Badge tone="amber">unsaved</Badge>}
        <div className="ml-auto flex gap-2">
          {canWrite && (
            <>
              <Button loading={saving} onClick={() => void save()} disabled={!dirty}>
                <Save className="h-4 w-4" aria-hidden /> Save
              </Button>
              <Button variant="primary" disabled={errors.length > 0} title={errors.length ? 'Fix validation errors first' : undefined} onClick={() => setRunOpen(true)}>
                <Play className="h-4 w-4" aria-hidden /> Run
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3" role="toolbar" aria-label="Add node">
            <span className="mr-1 text-xs uppercase tracking-wider text-slate-500">Add</span>
            {(Object.keys(META) as NodeType[]).map((t) => {
              const Icon = META[t].icon;
              return (
                <Button key={t} size="sm" disabled={!canWrite} onClick={() => addNode(t)}>
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {META[t].label}
                </Button>
              );
            })}
            <span className="ml-auto text-xs text-slate-500">Drag from a node’s edge handle to connect · Backspace deletes</span>
          </div>
          <div className="h-[28rem] md:h-[34rem]" aria-label="Workflow canvas">
            <ReactFlow
              nodes={display}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(c) => (onNodesChange(c), c.some((x) => x.type === 'position' || x.type === 'remove') && canWrite && markDirty())}
              onEdgesChange={(c) => (onEdgesChange(c), c.some((x) => x.type === 'remove') && canWrite && markDirty())}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected(null)}
              nodesDraggable={canWrite}
              nodesConnectable={canWrite}
              elementsSelectable
              deleteKeyCode={canWrite ? ['Backspace', 'Delete'] : null}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#1e293b" gap={20} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable style={{ width: 120, height: 80 }} nodeColor="#475569" nodeStrokeWidth={0} maskColor="rgba(2,6,23,0.7)" />
            </ReactFlow>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <CardHeader eyebrow="Inspector" title={sel ? `${META[sel.type as NodeType].label} node` : 'Select a node'} />
            {sel ? (
              <Inspector node={sel} models={models.data ?? []} studioCatalog={studioCatalog.data} disabled={!canWrite} onChange={(p) => patchNode(sel.id, p)} onDelete={() => deleteNode(sel.id)} />
            ) : (
              <p className="text-sm text-slate-500">Click a node to configure it. Use <code>{'{{input}}'}</code> in prompts to reference the previous node’s output, or <code>{'{{nodes.<id>.output}}'}</code> for any earlier node.</p>
            )}
          </Card>
          <Card className="p-4">
            <CardHeader eyebrow="Validation" title={errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : 'Looks good'} />
            {issues.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" aria-hidden /> No issues found.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {issues.map((i, k) => (
                  <li key={k} className={cx('flex gap-2', i.level === 'error' ? 'text-rose-300' : 'text-amber-300')}>
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span><span className="sr-only">{i.level}: </span>{i.message}{i.nodeId && <button className="ml-1 underline" onClick={() => setSelected(i.nodeId!)}>show</button>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Tabs label="Run panel" value={panel} onChange={setPanel} tabs={[{ id: 'run', label: 'Execution' }, { id: 'history', label: `History (${history.data?.length ?? 0})` }]} />
          {run && panel === 'run' && (
            <div className="flex items-center gap-3 text-sm text-slate-400">
              {runStatus && <StatusBadge status={runStatus} />}
              <span>{usd(run.costUsd)}</span>
              <span>{ms(run.latencyMs)}</span>
              {run.simulated && <Badge tone="amber">simulated</Badge>}
            </div>
          )}
        </div>
        {panel === 'history' ? (
          history.error ? (
            <ErrorState message={history.error} onRetry={history.reload} />
          ) : !history.data?.length ? (
            <p className="p-2 text-sm text-slate-500">No runs yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {history.data.map((r) => (
                <li key={r.id}>
                  <button className="flex w-full flex-wrap items-center justify-between gap-2 px-2 py-2.5 text-left text-sm hover:bg-slate-800/50" onClick={() => openHistoryRun(r)}>
                    <span className="flex items-center gap-3"><StatusBadge status={r.status} /> <span className="text-slate-300">{dateTime(r.queuedAt)}</span> <span className="text-xs text-slate-500">{r.trigger} · {timeAgo(r.queuedAt)}</span></span>
                    <span className="tabular-nums text-slate-400">{usd(r.costUsd)} · {ms(r.latencyMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : !activeRun ? (
          <p className="p-2 text-sm text-slate-500">{canWrite ? 'Press Run to execute this workflow. Progress and logs stream here live.' : 'Open a run from History to inspect its logs.'}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-slate-400">Logs</h3>
              <ol role="log" aria-label="Run logs" className="max-h-64 space-y-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3 font-mono text-xs">
                {runLogs.length === 0 && <li className="text-slate-500">Waiting for output…</li>}
                {runLogs.map((l) => (
                  <li key={l.id} className={l.level === 'error' ? 'text-rose-300' : l.level === 'warn' ? 'text-amber-300' : 'text-slate-300'}>
                    <span className="text-slate-600">{new Date(l.ts).toLocaleTimeString()}</span> {l.message}
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-slate-400">Result</h3>
              {run?.error ? (
                <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-100">{run.error}</p>
              ) : run?.output ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-sm">{typeof run.output.result === 'string' ? run.output.result : JSON.stringify(run.output.result, null, 2)}</pre>
              ) : (
                <p className="text-sm text-slate-500">{runStatus === 'queued' || runStatus === 'running' ? 'Running…' : 'No result.'}</p>
              )}
            </div>
          </div>
        )}
      </Card>

      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run workflow">
        <Field label="Input text (optional)" htmlFor="wf-input" hint="Passed to the trigger node. Leave empty to use its sample input.">
          <Textarea id="wf-input" rows={5} value={runInput} onChange={(e) => setRunInput(e.target.value)} />
        </Field>
        <p className="mt-3 text-xs text-slate-500">LLM nodes make real, billable API calls when an Anthropic key is configured.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRunOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={starting} onClick={startRun}>
            <Play className="h-4 w-4" aria-hidden /> {dirty ? 'Save & run' : 'Run'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Inspector({ node, models, studioCatalog, disabled, onChange, onDelete }: { node: Node<NData>; models: ModelInfo[]; studioCatalog: StudioCatalog | null; disabled: boolean; onChange: (p: Partial<NData>) => void; onDelete: () => void }) {
  const d = node.data;
  const t = node.type as NodeType;
  const model = models.find((m) => m.id === d.model);
  return (
    <div className="space-y-3">
      <Field label="Label" htmlFor="i-label">
        <Input id="i-label" disabled={disabled} value={d.label ?? ''} maxLength={60} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>

      {t === 'trigger' && (
        <>
          <Field label="Source" htmlFor="i-src">
            <Select id="i-src" disabled={disabled} value={d.source ?? 'manual'} onChange={(e) => onChange({ source: e.target.value })}>
              <option value="manual">Manual / API input</option>
              <option value="schedule">Scheduled</option>
              <option value="higgsfield">Recent Studio generations</option>
            </Select>
          </Field>
          {d.source === 'schedule' && (
            <Field label="Every (minutes)" htmlFor="i-int" hint="Runs only while the workflow status is Active.">
              <Input id="i-int" type="number" min={1} disabled={disabled} value={d.intervalMinutes ?? 60} onChange={(e) => onChange({ intervalMinutes: Math.max(1, Number(e.target.value) || 1) })} />
            </Field>
          )}
          {d.source !== 'higgsfield' && (
            <Field label="Sample input" htmlFor="i-sample" hint="Used when a run is started without input.">
              <Textarea id="i-sample" rows={3} disabled={disabled} value={d.sampleInput ?? ''} onChange={(e) => onChange({ sampleInput: e.target.value })} />
            </Field>
          )}
        </>
      )}

      {t === 'llm' && (
        <>
          <Field label="Model" htmlFor="i-model">
            <Select id="i-model" disabled={disabled} value={d.model ?? ''} onChange={(e) => onChange({ model: e.target.value || undefined })}>
              <option value="">Org default</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
          </Field>
          <Field label="System prompt" htmlFor="i-sys">
            <Textarea id="i-sys" rows={2} disabled={disabled} value={d.systemPrompt ?? ''} onChange={(e) => onChange({ systemPrompt: e.target.value })} />
          </Field>
          <Field label="User prompt" htmlFor="i-user">
            <Textarea id="i-user" rows={6} disabled={disabled} value={d.userPrompt ?? ''} onChange={(e) => onChange({ userPrompt: e.target.value })} />
          </Field>
          <Field label="Max tokens" htmlFor="i-max">
            <Input id="i-max" type="number" min={1} disabled={disabled} value={d.maxTokens ?? 512} onChange={(e) => onChange({ maxTokens: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
          {model && !model.supportsTemperature && <p className="text-xs text-slate-500">{model.label} ignores temperature.</p>}
        </>
      )}

      {t === 'generate' && (
        <>
          <Field label="Model" htmlFor="i-gmodel" hint={studioCatalog && !studioCatalog.connected ? 'Studio isn’t connected to Higgsfield yet, so runs produce placeholders.' : undefined}>
            <Select id="i-gmodel" disabled={disabled} value={d.model ?? ''} onChange={(e) => onChange({ model: e.target.value, settings: {} })}>
              <option value="" disabled>Choose a model…</option>
              {studioCatalog?.models.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.surface})</option>)}
            </Select>
          </Field>
          <Field label="Prompt" htmlFor="i-gprompt" hint={<>Use <code>{'{{input}}'}</code> for the previous node’s output.</>}>
            <Textarea id="i-gprompt" rows={4} disabled={disabled} value={d.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} />
          </Field>
          {studioCatalog?.models.find((m) => m.id === d.model && m.modes.some((md) => md.media.some((i) => i.role === 'start'))) && (
            <Field label="Start frame URL (optional)" htmlFor="i-gstart" hint="With a start frame the node switches to image mode automatically."><Input id="i-gstart" disabled={disabled} value={d.startUrl ?? ''} placeholder="https://… or {{input}}" onChange={(e) => onChange({ startUrl: e.target.value })} /></Field>
          )}
          {studioCatalog?.models.find((m) => m.id === d.model && m.modes.some((md) => md.media.some((i) => i.role === 'end'))) && (
            <Field label="End frame URL (optional)" htmlFor="i-gend"><Input id="i-gend" disabled={disabled} value={d.endUrl ?? ''} onChange={(e) => onChange({ endUrl: e.target.value })} /></Field>
          )}
          {studioCatalog?.models.find((m) => m.id === d.model && !m.modes.some((md) => 'batch_size' in md.params)) && (
            <Field label="How many" htmlFor="i-gcount">
              <Select id="i-gcount" disabled={disabled} value={d.count ?? 1} onChange={(e) => onChange({ count: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            </Field>
          )}
          <p className="text-xs text-slate-500">Other settings use each model’s defaults. Results are saved to the media timeline and passed on as <code>{'{ assets: [{ url, type }] }'}</code>.</p>
        </>
      )}

      {t === 'transform' && (
        <>
          <Field label="Operation" htmlFor="i-mode">
            <Select id="i-mode" disabled={disabled} value={d.mode ?? 'template'} onChange={(e) => onChange({ mode: e.target.value })}>
              <option value="template">Template</option>
              <option value="json_parse">Parse JSON</option>
              <option value="pick">Pick field (path)</option>
              <option value="regex_extract">Regex extract</option>
              <option value="uppercase">Uppercase</option>
              <option value="lowercase">Lowercase</option>
              <option value="trim">Trim</option>
              <option value="split_lines">Split into lines</option>
              <option value="join">Join list</option>
            </Select>
          </Field>
          {(d.mode ?? 'template') === 'template' && (
            <Field label="Template" htmlFor="i-tpl"><Textarea id="i-tpl" rows={3} disabled={disabled} value={d.template ?? ''} onChange={(e) => onChange({ template: e.target.value })} /></Field>
          )}
          {d.mode === 'pick' && <Field label="Path" htmlFor="i-path" hint="e.g. items.0.title"><Input id="i-path" disabled={disabled} value={d.path ?? ''} onChange={(e) => onChange({ path: e.target.value })} /></Field>}
          {d.mode === 'regex_extract' && (
            <>
              <Field label="Pattern" htmlFor="i-pat"><Input id="i-pat" className="font-mono" disabled={disabled} value={d.pattern ?? ''} onChange={(e) => onChange({ pattern: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Flags" htmlFor="i-fl"><Input id="i-fl" disabled={disabled} value={d.flags ?? ''} onChange={(e) => onChange({ flags: e.target.value })} placeholder="gi" /></Field>
                <Field label="Group" htmlFor="i-gr"><Input id="i-gr" type="number" min={0} disabled={disabled} value={d.group ?? 0} onChange={(e) => onChange({ group: Number(e.target.value) || 0 })} /></Field>
              </div>
            </>
          )}
          {d.mode === 'join' && <Field label="Separator" htmlFor="i-sep"><Input id="i-sep" disabled={disabled} value={d.separator ?? '\n'} onChange={(e) => onChange({ separator: e.target.value })} /></Field>}
        </>
      )}

      {t === 'action' && (
        <>
          <Field label="Action" htmlFor="i-act">
            <Select id="i-act" disabled={disabled} value={d.action ?? 'log'} onChange={(e) => onChange({ action: e.target.value })}>
              <option value="log">Write to run log</option>
              <option value="notify">Notify team (alert)</option>
              <option value="save_media">Save to media timeline</option>
            </Select>
          </Field>
          {d.action === 'save_media' ? (
            <>
              <Field label="Title" htmlFor="i-mt"><Input id="i-mt" disabled={disabled} value={d.title ?? ''} onChange={(e) => onChange({ title: e.target.value })} /></Field>
              <Field label="Media type" htmlFor="i-mty">
                <Select id="i-mty" disabled={disabled} value={d.mediaType ?? 'photo'} onChange={(e) => onChange({ mediaType: e.target.value })}>
                  <option value="photo">Photo</option>
                  <option value="video">Video</option>
                </Select>
              </Field>
              <Field label="URL" htmlFor="i-mu" hint="http(s) URL. Leave empty to store a placeholder entry."><Input id="i-mu" disabled={disabled} value={d.url ?? ''} onChange={(e) => onChange({ url: e.target.value })} /></Field>
              <Field label="Tags" htmlFor="i-mtg" hint="Comma separated"><Input id="i-mtg" disabled={disabled} value={d.tags ?? ''} onChange={(e) => onChange({ tags: e.target.value })} /></Field>
            </>
          ) : (
            <Field label="Message" htmlFor="i-msg"><Textarea id="i-msg" rows={3} disabled={disabled} value={d.message ?? ''} onChange={(e) => onChange({ message: e.target.value })} /></Field>
          )}
        </>
      )}

      {t === 'output' && <p className="text-xs text-slate-500">The value reaching this node becomes the run’s result.</p>}

      {!disabled && (
        <Button variant="ghost" size="sm" className="text-rose-300" onClick={onDelete}>
          <Trash2 className="h-4 w-4" aria-hidden /> Delete node
        </Button>
      )}
    </div>
  );
}
