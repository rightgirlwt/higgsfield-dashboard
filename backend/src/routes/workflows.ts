import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound, wrap } from '../lib/errors';
import { createRun, mapRun, queue } from '../services/jobs';
import { WORKFLOW_TEMPLATES } from '../services/templates';
import { validateWorkflow, workflowWork, NODE_TYPES, type WorkflowDefinition } from '../services/workflowEngine';
import { likePattern, uuidParam } from './util';

export const workflows = Router();

const definitionSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.enum(NODE_TYPES),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        data: z.record(z.string(), z.any()).default({}),
      }),
    )
    .max(100),
  edges: z.array(z.object({ id: z.string().min(1).max(100), source: z.string(), target: z.string() })).max(300),
});

const mapWf = (w: any, extra: Record<string, unknown> = {}) => ({
  id: w.id, name: w.name, description: w.description, status: w.status, version: w.version,
  definition: w.definition, createdAt: new Date(w.created_at).toISOString(), updatedAt: new Date(w.updated_at).toISOString(), ...extra,
});

workflows.get('/templates', (_req, res) => {
  res.json(WORKFLOW_TEMPLATES.map((t) => ({ ...t, nodeCount: t.definition.nodes.length })));
});

workflows.get(
  '/',
  wrap(async (req, res) => {
    const params: unknown[] = [req.user!.orgId];
    let where = 'w.org_id = $1';
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      params.push(likePattern(req.query.q.trim()));
      where += ` AND (w.name ILIKE $2 OR w.description ILIKE $2)`;
    }
    const { rows } = await getDb().query(
      `SELECT w.id, w.name, w.description, w.status, w.version, w.created_at, w.updated_at,
              jsonb_array_length(w.definition->'nodes')::int AS node_count,
              (SELECT COUNT(*)::int FROM job_runs r WHERE r.ref_id = w.id) AS run_count,
              (SELECT r.status FROM job_runs r WHERE r.ref_id = w.id ORDER BY r.queued_at DESC LIMIT 1) AS last_status,
              (SELECT r.queued_at FROM job_runs r WHERE r.ref_id = w.id ORDER BY r.queued_at DESC LIMIT 1) AS last_run_at
       FROM workflows w WHERE ${where} ORDER BY w.updated_at DESC LIMIT 200`,
      params,
    );
    res.json(
      rows.map((w) => ({
        id: w.id, name: w.name, description: w.description, status: w.status, version: w.version, nodeCount: w.node_count, runCount: w.run_count,
        lastStatus: w.last_status, lastRunAt: w.last_run_at ? new Date(w.last_run_at).toISOString() : null, updatedAt: new Date(w.updated_at).toISOString(),
      })),
    );
  }),
);

const createBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  definition: definitionSchema.default({ nodes: [], edges: [] }),
});

workflows.post(
  '/',
  wrap(async (req, res) => {
    const b = createBody.parse(req.body);
    const { rows } = await getDb().query(
      `INSERT INTO workflows (org_id, name, description, definition, created_by) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [req.user!.orgId, b.name, b.description, JSON.stringify(b.definition), req.user!.id],
    );
    res.status(201).json(mapWf(rows[0]));
  }),
);

workflows.post(
  '/from-template',
  wrap(async (req, res) => {
    const b = z.object({ templateId: z.string(), name: z.string().min(1).max(120).optional() }).parse(req.body);
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === b.templateId);
    if (!t) throw notFound('Template not found');
    const { rows } = await getDb().query(
      `INSERT INTO workflows (org_id, name, description, definition, created_by) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [req.user!.orgId, b.name ?? t.name, t.description, JSON.stringify(t.definition), req.user!.id],
    );
    res.status(201).json(mapWf(rows[0]));
  }),
);

async function load(orgId: string, id: string) {
  const w = (await getDb().query('SELECT * FROM workflows WHERE id=$1 AND org_id=$2', [id, orgId])).rows[0];
  if (!w) throw notFound('Workflow not found');
  return w;
}

workflows.get(
  '/:id',
  wrap(async (req, res) => {
    const w = await load(req.user!.orgId, uuidParam(req));
    res.json({ ...mapWf(w), issues: validateWorkflow(w.definition) });
  }),
);

workflows.put(
  '/:id',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const b = z
      .object({ name: z.string().min(1).max(120), description: z.string().max(500), definition: definitionSchema, status: z.enum(['draft', 'active', 'paused']) })
      .partial()
      .parse(req.body);
    const current = await load(req.user!.orgId, id);
    const definition = (b.definition ?? current.definition) as WorkflowDefinition;
    const status = b.status ?? current.status;
    const issues = validateWorkflow(definition);
    if (status === 'active' && issues.some((i) => i.level === 'error')) {
      throw badRequest('Fix validation errors before activating this workflow', issues);
    }
    const changed = b.definition && JSON.stringify(b.definition) !== JSON.stringify(current.definition);
    const { rows } = await getDb().query(
      `UPDATE workflows SET name=$3, description=$4, definition=$5::jsonb, status=$6, version = version + $7, updated_at=now()
       WHERE id=$1 AND org_id=$2 RETURNING *`,
      [id, req.user!.orgId, b.name ?? current.name, b.description ?? current.description, JSON.stringify(definition), status, changed ? 1 : 0],
    );
    res.json({ ...mapWf(rows[0]), issues });
  }),
);

workflows.delete(
  '/:id',
  wrap(async (req, res) => {
    const r = await getDb().query('DELETE FROM workflows WHERE id=$1 AND org_id=$2', [uuidParam(req), req.user!.orgId]);
    if (r.rowCount === 0) throw notFound('Workflow not found');
    res.status(204).end();
  }),
);

workflows.post('/validate', (req, res) => {
  const def = definitionSchema.parse(req.body?.definition ?? req.body);
  res.json({ issues: validateWorkflow(def) });
});

workflows.post(
  '/:id/run',
  wrap(async (req, res) => {
    const u = req.user!;
    const w = await load(u.orgId, uuidParam(req));
    const input = z.object({ input: z.record(z.string(), z.any()).default({}) }).parse(req.body ?? {}).input;
    const errors = validateWorkflow(w.definition).filter((i) => i.level === 'error');
    if (errors.length) throw badRequest('Workflow has validation errors', errors);
    const run = await createRun({ orgId: u.orgId, kind: 'workflow', refId: w.id, refName: w.name, input, createdBy: u.id });
    // Fire and return: execution progress streams over Socket.IO; clients can also poll GET /runs/:id.
    void queue.enqueue(u.orgId, run.id, workflowWork(u.orgId, { id: w.id, name: w.name, definition: w.definition }, input));
    res.status(202).json({ run });
  }),
);

workflows.get(
  '/:id/runs',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    await load(req.user!.orgId, id);
    const { rows } = await getDb().query('SELECT * FROM job_runs WHERE org_id=$1 AND ref_id=$2 ORDER BY queued_at DESC LIMIT 50', [req.user!.orgId, id]);
    res.json(rows.map(mapRun));
  }),
);

