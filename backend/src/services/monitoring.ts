import { connectedOrgIds, emitToOrg, getDb } from '../ctx';
import { logger } from '../logger';
import { getHfConfig } from './higgsfield';
import { getSecret } from './secrets';

export interface MonitoringSnapshot {
  apiHealthPct: number;
  latencyMs: number;
  latencyP95Ms: number;
  queueSize: number;
  activeJobs: number;
  runsLastHour: number;
  failuresLastHour: number;
  tokensLastHour: number;
  spendToday: number;
  claudeConfigured: boolean;
  higgsfieldConfigured: boolean;
  lastUpdated: string;
}

/** All figures are computed from persisted runs — nothing here is mocked. */
export async function snapshot(orgId: string): Promise<MonitoringSnapshot> {
  const db = getDb();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const [runs, lat, q, spend] = await Promise.all([
    db.query<{ total: number; failed: number; tokens: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              COALESCE(SUM(input_tokens + output_tokens),0)::int AS tokens
       FROM job_runs WHERE org_id=$1 AND finished_at >= $2 AND status IN ('completed','failed')`,
      [orgId, hourAgo],
    ),
    db.query<{ avg: number | null; p95: number | null }>(
      `SELECT AVG(latency_ms)::float8 AS avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95
       FROM job_runs WHERE org_id=$1 AND status='completed' AND finished_at >= $2 AND latency_ms IS NOT NULL`,
      [orgId, hourAgo],
    ),
    db.query<{ queued: number; running: number }>(
      `SELECT COUNT(*) FILTER (WHERE status='queued')::int AS queued, COUNT(*) FILTER (WHERE status='running')::int AS running
       FROM job_runs WHERE org_id=$1 AND status IN ('queued','running')`,
      [orgId],
    ),
    db.query<{ s: number }>(`SELECT COALESCE(SUM(cost_usd),0)::float8 AS s FROM usage_events WHERE org_id=$1 AND ts >= $2`, [orgId, dayStart.toISOString()]),
  ]);

  const total = runs.rows[0].total;
  const failed = runs.rows[0].failed;
  return {
    apiHealthPct: total === 0 ? 100 : Math.round(((total - failed) / total) * 1000) / 10,
    latencyMs: Math.round(lat.rows[0].avg ?? 0),
    latencyP95Ms: Math.round(lat.rows[0].p95 ?? 0),
    queueSize: q.rows[0].queued,
    activeJobs: q.rows[0].running,
    runsLastHour: total,
    failuresLastHour: failed,
    tokensLastHour: runs.rows[0].tokens,
    spendToday: spend.rows[0].s,
    claudeConfigured: !!(await getSecret(orgId, 'anthropic')),
    higgsfieldConfigured: (await getHfConfig(orgId)) !== null,
    lastUpdated: new Date().toISOString(),
  };
}

let timer: NodeJS.Timeout | null = null;

/** Push a fresh snapshot to every organisation that currently has a connected socket. */
export function startMonitoringBroadcast(intervalMs = 5000): void {
  if (timer) return;
  timer = setInterval(async () => {
    for (const orgId of connectedOrgIds()) {
      try {
        emitToOrg(orgId, 'monitoring:update', await snapshot(orgId));
      } catch (err) {
        logger.warn('monitoring broadcast failed', { orgId, err: String(err) });
      }
    }
  }, intervalMs);
  timer.unref();
}

export function stopMonitoringBroadcast(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
