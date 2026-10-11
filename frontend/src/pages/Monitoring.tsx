import { Pause, Play, Trash2, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Card, CardHeader, cx, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { ms, num, timeAgo, usd } from '../lib/format';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import { qs } from '../lib/api';
import type { Alert, Run, RunLog, WorkflowListItem } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useCan } from '../auth/context';

const levelStyle: Record<string, string> = {
  error: 'text-rose-300',
  warn: 'text-amber-300',
  info: 'text-slate-300',
  debug: 'text-slate-500',
};
const levelBadge = { error: 'rose', warn: 'amber', info: 'cyan', debug: 'slate' } as const;
const tooltipStyle = { background: '#0f172a', border: '1px solid #334155', borderRadius: 12, color: '#e2e8f0' } as const;

function Tile({ label, value, tone = 'text-slate-100', hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tabular-nums', tone)}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export default function Monitoring() {
  useDocumentTitle('Monitoring');
  const { connected, snapshot, history, logs: liveLogs, jobs, runTick, alertTick, clearLogs } = useRealtime();
  const canAck = useCan('user');

  // ---- filters -----------------------------------------------------------------------------
  const [level, setLevel] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [text, setText] = useState('');
  const dtext = useDebounced(text);
  const [paused, setPaused] = useState(false);
  const workflows = useApi<WorkflowListItem[]>('/workflows');
  const stored = useApi<RunLog[]>(`/monitoring/logs${qs({ level, kind, status, workflowId, q: dtext, limit: 200 })}`);
  const activeJobs = useApi<Run[]>('/monitoring/jobs');
  const alerts = useApi<Alert[]>('/monitoring/alerts');

  const jobsReload = activeJobs.reload;
  useEffect(() => {
    if (runTick > 0) jobsReload();
  }, [runTick, jobsReload]);
  const alertsReload = alerts.reload;
  useEffect(() => {
    if (alertTick > 0) alertsReload();
  }, [alertTick, alertsReload]);

  const matches = (l: RunLog) => {
    if (level && l.level !== level) return false;
    if (kind && l.kind && l.kind !== kind) return false;
    if (workflowId && l.refId !== workflowId) return false;
    if (status && jobs[l.runId]?.status !== status) return false;
    if (dtext && !l.message.toLowerCase().includes(dtext.toLowerCase())) return false;
    return true;
  };

  const merged = useMemo(() => {
    const byId = new Map<string, RunLog>();
    for (const l of stored.data ?? []) byId.set(l.id, l);
    for (const l of liveLogs) if (matches(l)) byId.set(l.id, l);
    return [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored.data, liveLogs, level, kind, status, workflowId, dtext, jobs]);

  // Pausing freezes what's on screen while events keep arriving underneath.
  const frozen = useRef<RunLog[]>([]);
  if (!paused) frozen.current = merged;
  const shown = paused ? frozen.current : merged;
  const newWhilePaused = paused ? Math.max(0, merged.length && frozen.current.length ? Number(merged[0].id) - Number(frozen.current[0]?.id ?? 0) : 0) : 0;

  const jobList = useMemo(() => {
    const m = new Map<string, Run>();
    for (const r of activeJobs.data ?? []) m.set(r.id, r);
    for (const r of Object.values(jobs)) {
      const prev = m.get(r.id);
      if (prev || r.status === 'queued' || r.status === 'running' || (r.finishedAt && Date.now() - new Date(r.finishedAt).getTime() < 15 * 60_000)) m.set(r.id, { ...prev, ...r });
    }
    return [...m.values()].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, 25);
  }, [activeJobs.data, jobs]);

  const health = snapshot?.apiHealthPct;
  const healthTone = health === undefined ? '' : health >= 99 ? 'text-emerald-300' : health >= 90 ? 'text-amber-300' : 'text-rose-300';
  const chartData = history.map((h) => ({ ...h, time: new Date(h.t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }) }));

  const ack = async (id: string) => {
    await api.post(`/monitoring/alerts/${id}/ack`);
    alerts.reload();
  };

  return (
    <div>
      <PageHeader
        eyebrow="Live operations"
        title="Monitoring"
        actions={
          <span role="status" className={cx('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm', connected ? 'border-emerald-500/30 text-emerald-300' : 'border-rose-500/30 text-rose-300')}>
            {connected ? <Wifi className="h-4 w-4" aria-hidden /> : <WifiOff className="h-4 w-4" aria-hidden />}
            {connected ? 'Live stream connected' : 'Disconnected — retrying'}
          </span>
        }
      />

      <section aria-label="Current status" className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {snapshot ? (
          <>
            <Tile label="API health (1h)" value={`${snapshot.apiHealthPct}%`} tone={healthTone} hint={`${snapshot.runsLastHour} runs`} />
            <Tile label="Avg latency" value={ms(snapshot.latencyMs)} tone="text-cyan-300" hint={`p95 ${ms(snapshot.latencyP95Ms)}`} />
            <Tile label="Queue" value={String(snapshot.queueSize)} tone="text-violet-300" hint="waiting" />
            <Tile label="Active jobs" value={String(snapshot.activeJobs)} tone="text-violet-300" hint="running now" />
            <Tile label="Failures (1h)" value={String(snapshot.failuresLastHour)} tone={snapshot.failuresLastHour ? 'text-rose-300' : 'text-slate-100'} />
            <Tile label="Tokens (1h)" value={num(snapshot.tokensLastHour)} hint={`${usd(snapshot.spendToday)} today`} />
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24" />)
        )}
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card className="p-5">
          <CardHeader eyebrow="Performance" title="Latency & queue (last 5 min)" />
          {chartData.length < 2 ? (
            <p className="py-10 text-center text-sm text-slate-500">Collecting data… updates arrive every few seconds.</p>
          ) : (
            <div role="img" aria-label="Line chart of average latency and queue size over the last few minutes" className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 11 }} minTickGap={32} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="l" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={(v: number) => `${v}ms`} axisLine={false} tickLine={false} width={52} />
                  <YAxis yAxisId="q" orientation="right" allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line yAxisId="l" type="monotone" dataKey="latencyMs" name="Latency (ms)" stroke="#22d3ee" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line yAxisId="q" type="stepAfter" dataKey="queueSize" name="Queue" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <CardHeader eyebrow="Needs attention" title="Alerts" />
          {alerts.error ? (
            <ErrorState message={alerts.error} onRetry={alerts.reload} />
          ) : !alerts.data ? (
            <Skeleton className="h-32" />
          ) : alerts.data.length === 0 ? (
            <EmptyState title="All clear" hint="Budget and workflow notices appear here." />
          ) : (
            <ul className="max-h-60 space-y-2 overflow-auto">
              {alerts.data.slice(0, 12).map((a) => (
                <li key={a.id} className={cx('flex items-start justify-between gap-2 rounded-xl border border-slate-800 p-3 text-sm', a.acknowledged ? 'opacity-50' : 'bg-slate-950/60')}>
                  <div>
                    <div className="mb-1 flex items-center gap-2"><Badge tone={a.severity === 'critical' ? 'rose' : a.severity === 'warning' ? 'amber' : 'cyan'}>{a.severity}</Badge><span className="text-xs text-slate-500">{timeAgo(a.createdAt)}</span></div>
                    {a.message}
                  </div>
                  {!a.acknowledged && canAck && <Button size="sm" variant="ghost" onClick={() => ack(a.id)}>Ack</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="mt-6">
        <Card className="p-5">
          <CardHeader eyebrow="Queue" title="Active & recent jobs" />
          {!activeJobs.data && !activeJobs.error ? (
            <Skeleton className="h-24" />
          ) : jobList.length === 0 ? (
            <p className="text-sm text-slate-500">No jobs queued, running, or finished in the last 15 minutes.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Active and recently finished jobs</caption>
                <thead className="text-xs uppercase tracking-wider text-slate-500">
                  <tr><th scope="col" className="pb-2 pr-3">Job</th><th scope="col" className="pb-2 pr-3">Type</th><th scope="col" className="pb-2 pr-3">Status</th><th scope="col" className="pb-2 pr-3">Model</th><th scope="col" className="pb-2 pr-3 text-right">Cost</th><th scope="col" className="pb-2 text-right">Started</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {jobList.map((j) => (
                    <tr key={j.id}>
                      <td className="max-w-[16rem] truncate py-2 pr-3 font-medium">{j.refName}</td>
                      <td className="py-2 pr-3 text-slate-400">{j.kind}</td>
                      <td className="py-2 pr-3"><StatusBadge status={j.status} /></td>
                      <td className="py-2 pr-3 text-slate-400">{j.model ?? '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{usd(j.costUsd)}</td>
                      <td className="py-2 text-right text-slate-500">{timeAgo(j.startedAt ?? j.queuedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <section className="mt-6">
        <Card className="p-5">
          <CardHeader
            eyebrow="Live"
            title="Log stream"
            action={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
                  {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
                  {paused ? `Resume${newWhilePaused > 0 ? ` (${newWhilePaused} new)` : ''}` : 'Pause'}
                </Button>
                <Button size="sm" variant="ghost" onClick={clearLogs}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Clear live buffer</Button>
              </div>
            }
          />
          <form role="search" aria-label="Filter logs" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => e.preventDefault()}>
            <Select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">All levels</option><option value="error">Errors</option><option value="warn">Warnings</option><option value="info">Info</option><option value="debug">Debug</option>
            </Select>
            <Select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All types</option><option value="prompt">Prompts</option><option value="workflow">Workflows</option>
            </Select>
            <Select aria-label="Run status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="queued">Queued</option>
            </Select>
            <Select aria-label="Workflow" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
              <option value="">Any workflow</option>
              {workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
            <Input aria-label="Search log text" placeholder="Search messages…" value={text} onChange={(e) => setText(e.target.value)} />
          </form>

          {stored.error ? (
            <ErrorState message={stored.error} onRetry={stored.reload} />
          ) : !stored.data ? (
            <Skeleton className="h-48" />
          ) : shown.length === 0 ? (
            <EmptyState title="No log lines match" hint="Run a prompt or workflow and lines will stream in here." />
          ) : (
            <ol role="log" aria-label="Live log stream" aria-live="off" className="max-h-[28rem] space-y-0.5 overflow-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3 font-mono text-xs">
              {shown.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-x-2 py-0.5">
                  <span className="text-slate-600">{new Date(l.ts).toLocaleTimeString()}</span>
                  <Badge tone={levelBadge[l.level]} className="!px-1.5 !py-0 text-[9px]">{l.level}</Badge>
                  {l.refName && <span className="text-slate-500">[{l.refName}]</span>}
                  <span className={levelStyle[l.level]}>{l.message}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>
    </div>
  );
}
