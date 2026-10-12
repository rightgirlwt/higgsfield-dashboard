import { ArrowDownRight, ArrowUpRight, Download, FileText, FlaskConical, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ms, num, pct, timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { cssColor } from '../lib/theme';
import type { BreakdownRow, Run, SpendPoint, Summary } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useToast } from '../state/Toast';

type Range = '7d' | '30d' | '90d';
type By = 'model' | 'workflow' | 'provider';

function Delta({ v, hero }: { v: number | null; hero?: boolean }) {
  if (v === null) return <Badge tone="slate" className={hero ? '!bg-white/20 !text-white' : undefined}>new</Badge>;
  const up = v >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${hero ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-200'}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {pct(v)}
      <span className="sr-only"> versus the previous period</span>
    </span>
  );
}

/** `hero` = the accent-coloured highlight card (like the "Quick access" hero in the design reference). */
function Kpi({ label, value, delta, sub, children, hero }: { label: string; value: string; delta?: number | null; sub?: string; children?: React.ReactNode; hero?: boolean }) {
  return (
    <Card className={hero ? '!border-transparent !bg-cyan-500 p-5 text-white' : 'p-5'}>
      <div className="mb-5 flex items-center justify-between gap-2">
        <h3 className={`text-sm ${hero ? 'text-white/85' : 'text-slate-400'}`}>{label}</h3>
        {delta !== undefined && <Delta v={delta} hero={hero} />}
      </div>
      <div className={`text-3xl font-semibold tracking-tight ${hero ? 'text-white' : 'text-slate-100'}`}>{value}</div>
      {sub && <p className={`mt-1 text-xs ${hero ? 'text-white/75' : 'text-slate-500'}`}>{sub}</p>}
      {children}
    </Card>
  );
}

const tooltipStyle = { background: cssColor('slate-900'), border: `1px solid ${cssColor('slate-700')}`, borderRadius: 12, color: cssColor('slate-100') } as const;
const AXIS = cssColor('slate-400');

export default function Overview() {
  useDocumentTitle('Overview');
  const toast = useToast();
  const { runTick, snapshot } = useRealtime();
  const [range, setRange] = useState<Range>('30d');
  const [by, setBy] = useState<By>('model');
  const summary = useApi<Summary>(`/dashboard/summary?range=${range}`);
  const spend = useApi<SpendPoint[]>(`/dashboard/spend?range=${range}`);
  const breakdown = useApi<BreakdownRow[]>(`/dashboard/breakdown?by=${by}&range=${range}`);
  const recent = useApi<Run[]>('/dashboard/recent-runs');
  const [busy, setBusy] = useState<string | null>(null);

  // Refresh headline numbers when runs complete in real time.
  const reloadAll = [summary.reload, spend.reload, breakdown.reload, recent.reload];
  useEffect(() => {
    if (runTick > 0) reloadAll.forEach((r) => r());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runTick]);

  const download = async (path: string, name: string, key: string) => {
    setBusy(key);
    try {
      await api.download(path, name);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const s = summary.data;
  const budget = s?.budget;
  const budgetTone = budget?.pct == null ? 'cyan' : budget.pct >= 100 ? 'rose' : budget.pct >= budget.alertThresholdPct ? 'amber' : 'cyan';
  const maxCost = Math.max(...(breakdown.data?.map((b) => b.costUsd) ?? [0]), 0.000001);
  const totalSpend = spend.data?.reduce((a, p) => a + p.total, 0) ?? 0;

  return (
    <div>
      <PageHeader
        eyebrow="Operations overview"
        title="Higgsfield Studio"
        actions={
          <>
            <Tabs label="Date range" value={range} onChange={setRange} tabs={[{ id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }]} />
            <Button loading={busy === 'csv'} onClick={() => download(`/export/usage.csv?range=${range}`, 'usage.csv', 'csv')}>
              <Download className="h-4 w-4" aria-hidden /> CSV
            </Button>
            <Button loading={busy === 'pdf'} onClick={() => download(`/export/report.pdf?range=${range}`, 'higgsfield-report.pdf', 'pdf')}>
              <FileText className="h-4 w-4" aria-hidden /> PDF report
            </Button>
          </>
        }
      />

      {s?.includesSimulatedData && (
        <div role="note" className="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Some usage in this range is <strong>simulated / demo data</strong>, not real spend. Add your Anthropic key in <Link className="underline" to="/settings">Settings → API keys</Link> to run prompts for real.
          </p>
        </div>
      )}

      {summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : (
        <section aria-label="Key metrics" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {!s ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36" />)
          ) : (
            <>
              <Kpi hero label={`Estimated spend (${s.rangeDays}d)`} value={usd(s.spend.value)} delta={s.spend.deltaPct}>
                {budget && budget.monthlyUsd > 0 ? (
                  <div className="mt-3 space-y-1">
                    <div role="progressbar" aria-label="Monthly budget used" aria-valuenow={Math.round(Math.min(100, budget.pct ?? 0))} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-white/25">
                      <div className={`h-full rounded-full ${budgetTone === 'rose' ? 'bg-rose-300' : budgetTone === 'amber' ? 'bg-amber-300' : 'bg-white'}`} style={{ width: `${Math.min(100, budget.pct ?? 0)}%` }} />
                    </div>
                    <p className="text-xs text-white/80">
                      {usd(budget.monthToDateUsd)} of {usd(budget.monthlyUsd)} monthly budget ({budget.pct?.toFixed(0)}%)
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-white/80">
                    No budget set · <Link className="underline" to="/settings">set one</Link>
                  </p>
                )}
              </Kpi>
              <Kpi label="Prompt runs" value={num(s.promptRuns.value)} delta={s.promptRuns.deltaPct} sub={`${num(s.tokens)} tokens`} />
              <Kpi label="Active workflows" value={String(s.activeWorkflows.value)} sub={`${s.activeWorkflows.total} total`} />
              <Kpi label="Media assets" value={num(s.mediaAssets.value)} delta={s.mediaAssets.deltaPct} sub={`${s.mediaAssets.added} added in range`} />
            </>
          )}
        </section>
      )}

      <section className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card className="p-5">
          <CardHeader eyebrow="Spend trend" title={`API cost · ${usd(totalSpend)}`} />
          {spend.error ? (
            <ErrorState message={spend.error} onRetry={spend.reload} />
          ) : !spend.data ? (
            <Skeleton className="h-64" />
          ) : (
            <div role="img" aria-label={`Daily spend over ${range}, total ${usd(totalSpend)}. Claude and Higgsfield stacked.`} className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={spend.data} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={cssColor('slate-800')} vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: AXIS, fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} axisLine={false} tickLine={false} width={48} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => usd(Number(v))} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="claude" name="Claude" stackId="a" fill={cssColor('violet-500')} />
                  <Bar dataKey="higgsfield" name="Higgsfield" stackId="a" fill={cssColor('cyan-500')} radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <CardHeader eyebrow="Live" title="System status" />
          <dl className="space-y-3 text-sm">
            {[
              ['API health', snapshot ? `${snapshot.apiHealthPct}%` : '—', 'text-emerald-300'],
              ['Avg latency', snapshot ? ms(snapshot.latencyMs) : '—', 'text-cyan-300'],
              ['p95 latency', snapshot ? ms(snapshot.latencyP95Ms) : '—', 'text-cyan-300'],
              ['Queue size', snapshot ? String(snapshot.queueSize) : '—', 'text-violet-300'],
              ['Active jobs', snapshot ? String(snapshot.activeJobs) : '—', 'text-violet-300'],
              ['Failures (1h)', snapshot ? String(snapshot.failuresLastHour) : '—', snapshot && snapshot.failuresLastHour > 0 ? 'text-rose-300' : 'text-slate-200'],
              ['Spend today', snapshot ? usd(snapshot.spendToday) : '—', 'text-slate-200'],
            ].map(([k, v, c]) => (
              <div key={k} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5">
                <dt className="text-slate-400">{k}</dt>
                <dd className={`font-medium ${c}`}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Badge tone={snapshot?.claudeConfigured ? 'emerald' : 'amber'}>Claude {snapshot?.claudeConfigured ? 'connected' : 'simulated'}</Badge>
            <Badge tone={snapshot?.higgsfieldConfigured ? 'emerald' : 'amber'}>Higgsfield {snapshot?.higgsfieldConfigured ? 'connected' : 'simulated'}</Badge>
          </div>
        </Card>
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_1.4fr]">
        <Card className="p-5">
          <CardHeader
            eyebrow="Usage breakdown"
            title="Where the money goes"
            action={<Tabs label="Group by" value={by} onChange={setBy} tabs={[{ id: 'model', label: 'Model' }, { id: 'workflow', label: 'Workflow' }, { id: 'provider', label: 'Provider' }]} />}
          />
          {breakdown.error ? (
            <ErrorState message={breakdown.error} onRetry={breakdown.reload} />
          ) : !breakdown.data ? (
            <Skeleton className="h-48" />
          ) : breakdown.data.length === 0 ? (
            <EmptyState title="No usage in this range" hint="Run a prompt or workflow to see spend here." />
          ) : (
            <ul className="space-y-3">
              {breakdown.data.slice(0, 8).map((b) => (
                <li key={b.key}>
                  <div className="mb-1 flex justify-between gap-2 text-sm">
                    <span className="truncate text-slate-200">{b.label}</span>
                    <span className="shrink-0 text-slate-300">{usd(b.costUsd)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-violet-500" style={{ width: `${(b.costUsd / maxCost) * 100}%` }} />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{b.events} events · {num(b.tokens)} tokens</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <CardHeader eyebrow="Prompt lab & workflows" title="Recent runs" action={<Link to="/prompts"><Button size="sm"><Play className="h-3.5 w-3.5" aria-hidden /> Open Prompt Studio</Button></Link>} />
          {recent.error ? (
            <ErrorState message={recent.error} onRetry={recent.reload} />
          ) : !recent.data ? (
            <Skeleton className="h-48" />
          ) : recent.data.length === 0 ? (
            <EmptyState title="No runs yet" hint="Runs from Prompt Studio and workflows show up here." />
          ) : (
            <ul className="space-y-2">
              {recent.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{r.refName}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {r.kind} · {r.model ?? '—'} · {timeAgo(r.queuedAt)}
                      {r.simulated && ' · simulated'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusBadge status={r.status} />
                    <span className="w-20 text-right text-sm tabular-nums text-slate-200">{usd(r.costUsd)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
