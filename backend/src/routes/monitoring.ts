import { Router } from 'express';
import { getDb } from '../ctx';
import { notFound, wrap } from '../lib/errors';
import { mapRun } from '../services/jobs';
import { snapshot } from '../services/monitoring';
import { isUuid, likePattern, uuidParam } from './util';

export const monitoring = Router();

monitoring.get(
  '/',
  wrap(async (req, res) => {
    res.json(await snapshot(req.user!.orgId));
  }),
);

/** Log history for the live stream's initial page; filters: level, kind (type), status, workflowId, q. */
monitoring.get(
  '/logs',
  wrap(async (req, res) => {
    const params: unknown[] = [req.user!.orgId];
    const where = ['l.org_id = $1'];
    const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replace('?', `$${params.length}`)));
    if (['debug', 'info', 'warn', 'error'].includes(String(req.query.level))) add('l.level = ?', req.query.level);
    if (['prompt', 'workflow', 'generation'].includes(String(req.query.kind))) add('r.kind = ?', req.query.kind);
    if (['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(req.query.status))) add('r.status = ?', req.query.status);
    if (isUuid(req.query.workflowId)) add('r.ref_id = ?', req.query.workflowId);
    if (isUuid(req.query.runId)) add('l.run_id = ?', req.query.runId);
    if (typeof req.query.q === 'string' && req.query.q.trim()) add('l.message ILIKE ?', likePattern(req.query.q.trim()));
    params.push(Math.min(Number(req.query.limit) || 100, 500));
    const { rows } = await getDb().query(
      `SELECT l.id, l.run_id, l.level, l.message, l.node_id, l.ts, r.kind, r.status, r.ref_id, r.ref_name
       FROM run_logs l JOIN job_runs r ON r.id = l.run_id WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT $${params.length}`,
      params,
    );
    res.json(
      rows.map((l) => ({
        id: String(l.id), runId: l.run_id, level: l.level, message: l.message, nodeId: l.node_id, ts: new Date(l.ts).toISOString(),
        kind: l.kind, runStatus: l.status, refId: l.ref_id, refName: l.ref_name,
      })),
    );
  }),
);

monitoring.get(
  '/jobs',
  wrap(async (req, res) => {
    const { rows } = await getDb().query(
      `SELECT * FROM job_runs WHERE org_id=$1 AND (status IN ('queued','running') OR finished_at > now() - interval '15 minutes')
       ORDER BY queued_at DESC LIMIT 50`,
      [req.user!.orgId],
    );
    res.json(rows.map((r) => ({ ...mapRun(r), input: undefined, output: undefined })));
  }),
);

monitoring.get(
  '/alerts',
  wrap(async (req, res) => {
    const { rows } = await getDb().query(
      `SELECT id, kind, severity, message, acknowledged, created_at FROM alerts WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user!.orgId],
    );
    res.json(rows.map((a) => ({ ...a, createdAt: new Date(a.created_at).toISOString(), created_at: undefined })));
  }),
);

monitoring.post(
  '/alerts/ack-all',
  wrap(async (req, res) => {
    await getDb().query('UPDATE alerts SET acknowledged = true WHERE org_id=$1', [req.user!.orgId]);
    res.status(204).end();
  }),
);

monitoring.post(
  '/alerts/:id/ack',
  wrap(async (req, res) => {
    const r = await getDb().query('UPDATE alerts SET acknowledged = true WHERE id=$1 AND org_id=$2', [uuidParam(req), req.user!.orgId]);
    if (r.rowCount === 0) throw notFound('Alert not found');
    res.status(204).end();
  }),
);
