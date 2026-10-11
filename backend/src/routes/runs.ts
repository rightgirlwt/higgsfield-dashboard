import { Router } from 'express';
import { getDb } from '../ctx';
import { notFound, wrap } from '../lib/errors';
import { emitToOrg } from '../ctx';
import { getRun, mapRun } from '../services/jobs';
import { isUuid, uuidParam } from './util';

export const runs = Router();

runs.get(
  '/',
  wrap(async (req, res) => {
    const params: unknown[] = [req.user!.orgId];
    let where = 'org_id = $1';
    if (['prompt', 'workflow', 'generation'].includes(String(req.query.kind))) (params.push(req.query.kind), (where += ` AND kind = $${params.length}`));
    if (['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(req.query.status))) (params.push(req.query.status), (where += ` AND status = $${params.length}`));
    if (isUuid(req.query.workflowId)) (params.push(req.query.workflowId), (where += ` AND ref_id = $${params.length}`));
    params.push(Math.min(Number(req.query.limit) || 50, 200));
    const { rows } = await getDb().query(`SELECT * FROM job_runs WHERE ${where} ORDER BY queued_at DESC LIMIT $${params.length}`, params);
    res.json(rows.map((r) => ({ ...mapRun(r), input: undefined, output: undefined })));
  }),
);

runs.get(
  '/:id',
  wrap(async (req, res) => {
    const run = await getRun(req.user!.orgId, uuidParam(req));
    if (!run) throw notFound('Run not found');
    const logs = await getDb().query('SELECT id, level, message, node_id, ts FROM run_logs WHERE run_id=$1 ORDER BY id', [run.id]);
    res.json({
      run,
      logs: logs.rows.map((l) => ({ id: String(l.id), level: l.level, message: l.message, nodeId: l.node_id, ts: new Date(l.ts).toISOString() })),
    });
  }),
);

/** Only a still-queued run can be cancelled; a running run is not interruptible in this version. */
runs.post(
  '/:id/cancel',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const org = req.user!.orgId;
    const r = await getDb().query(`UPDATE job_runs SET status='cancelled', finished_at=now() WHERE id=$1 AND org_id=$2 AND status='queued'`, [id, org]);
    if (r.rowCount === 0) {
      const existing = await getRun(org, id);
      if (!existing) throw notFound('Run not found');
      res.status(409).json({ error: { code: 'conflict', message: `Run is ${existing.status} and can no longer be cancelled` } });
      return;
    }
    const run = (await getRun(org, id))!;
    emitToOrg(org, 'job:update', { ...run, input: undefined, output: undefined });
    res.json(run);
  }),
);
