import { Router } from 'express';
import { getDb } from '../ctx';
import { wrap } from '../lib/errors';
import { monthToDateSpend } from '../services/alerts';
import { mapRun } from '../services/jobs';
import { parseRange } from './util';

export const dashboard = Router();

const delta = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / prev) * 1000) / 10);

dashboard.get(
  '/summary',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const { from, prevFrom, days } = parseRange(req.query.range);
    const db = getDb();
    const [spend, runs, wf, media, org_, sim] = await Promise.all([
      db.query<{ cur: number; prev: number; tokens: number }>(
        `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE ts >= $2),0)::float8 AS cur,
                COALESCE(SUM(cost_usd) FILTER (WHERE ts < $2),0)::float8 AS prev,
                COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE ts >= $2),0)::float8 AS tokens
         FROM usage_events WHERE org_id=$1 AND ts >= $3`,
        [org, from.toISOString(), prevFrom.toISOString()],
      ),
      db.query<{ cur: number; prev: number }>(
        `SELECT COUNT(*) FILTER (WHERE queued_at >= $2)::int AS cur, COUNT(*) FILTER (WHERE queued_at < $2)::int AS prev
         FROM job_runs WHERE org_id=$1 AND kind='prompt' AND queued_at >= $3`,
        [org, from.toISOString(), prevFrom.toISOString()],
      ),
      db.query<{ active: number; total: number }>(
        `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active, COUNT(*)::int AS total FROM workflows WHERE org_id=$1`,
        [org],
      ),
      db.query<{ cur: number; prev: number; total: number }>(
        `SELECT COUNT(*) FILTER (WHERE created_at >= $2)::int AS cur,
                COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $2)::int AS prev, COUNT(*)::int AS total
         FROM media_assets WHERE org_id=$1`,
        [org, from.toISOString(), prevFrom.toISOString()],
      ),
      db.query<{ monthly_budget_usd: number; alert_threshold_pct: number }>('SELECT monthly_budget_usd, alert_threshold_pct FROM organizations WHERE id=$1', [org]),
      db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM usage_events WHERE org_id=$1 AND simulated AND ts >= $2', [org, from.toISOString()]),
    ]);
    const mtd = await monthToDateSpend(org);
    const budget = org_.rows[0].monthly_budget_usd;
    res.json({
      rangeDays: days,
      spend: { value: spend.rows[0].cur, deltaPct: delta(spend.rows[0].cur, spend.rows[0].prev) },
      tokens: spend.rows[0].tokens,
      promptRuns: { value: runs.rows[0].cur, deltaPct: delta(runs.rows[0].cur, runs.rows[0].prev) },
      activeWorkflows: { value: wf.rows[0].active, total: wf.rows[0].total },
      mediaAssets: { value: media.rows[0].total, added: media.rows[0].cur, deltaPct: delta(media.rows[0].cur, media.rows[0].prev) },
      budget: { monthlyUsd: budget, monthToDateUsd: mtd, pct: budget > 0 ? Math.round((mtd / budget) * 1000) / 10 : null, alertThresholdPct: org_.rows[0].alert_threshold_pct },
      includesSimulatedData: sim.rows[0].n > 0,
    });
  }),
);

dashboard.get(
  '/spend',
  wrap(async (req, res) => {
    const { from, days } = parseRange(req.query.range);
    const { rows } = await getDb().query<{ d: string; provider: string; cost: number }>(
      `SELECT to_char(date_trunc('day', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d, provider, SUM(cost_usd)::float8 AS cost
       FROM usage_events WHERE org_id=$1 AND ts >= $2 GROUP BY 1,2 ORDER BY 1`,
      [req.user!.orgId, from.toISOString()],
    );
    const byDay = new Map<string, { claude: number; higgsfield: number }>();
    for (let i = 0; i <= days; i++) {
      const d = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(d, { claude: 0, higgsfield: 0 });
    }
    for (const r of rows) {
      const e = byDay.get(r.d);
      if (e) e[r.provider as 'claude' | 'higgsfield'] = r.cost;
    }
    res.json([...byDay].map(([date, v]) => ({ date, ...v, total: v.claude + v.higgsfield })));
  }),
);

dashboard.get(
  '/breakdown',
  wrap(async (req, res) => {
    const { from } = parseRange(req.query.range);
    const by = ['model', 'workflow', 'provider'].includes(String(req.query.by)) ? String(req.query.by) : 'model';
    const db = getDb();
    const args = [req.user!.orgId, from.toISOString()];
    const sql =
      by === 'workflow'
        ? `SELECT COALESCE(w.name, 'Ad-hoc prompts') AS label, COALESCE(w.id::text, 'adhoc') AS key, SUM(u.cost_usd)::float8 AS cost,
                  COUNT(*)::int AS events, COALESCE(SUM(u.input_tokens + u.output_tokens),0)::float8 AS tokens
           FROM usage_events u LEFT JOIN workflows w ON w.id = u.workflow_id WHERE u.org_id=$1 AND u.ts >= $2 GROUP BY 1,2 ORDER BY cost DESC`
        : `SELECT ${by === 'model' ? `CASE WHEN model = '' THEN provider ELSE model END` : 'provider'} AS label, ${by === 'model' ? `CASE WHEN model = '' THEN provider ELSE model END` : 'provider'} AS key,
                  SUM(cost_usd)::float8 AS cost, COUNT(*)::int AS events, COALESCE(SUM(input_tokens + output_tokens),0)::float8 AS tokens
           FROM usage_events WHERE org_id=$1 AND ts >= $2 GROUP BY 1,2 ORDER BY cost DESC`;
    const { rows } = await db.query<{ key: string; label: string; cost: number; events: number; tokens: number }>(sql, args);
    res.json(rows.map((r) => ({ key: r.key, label: r.label, costUsd: r.cost, events: r.events, tokens: r.tokens })));
  }),
);

dashboard.get(
  '/recent-runs',
  wrap(async (req, res) => {
    const { rows } = await getDb().query('SELECT * FROM job_runs WHERE org_id=$1 ORDER BY queued_at DESC LIMIT 6', [req.user!.orgId]);
    res.json(rows.map((r) => ({ ...mapRun(r), input: undefined, output: undefined })));
  }),
);
