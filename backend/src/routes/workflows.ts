import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, HttpError, notFound, wrap } from '../lib/errors';
import { createRun, mapRun, queue } from '../services/jobs';
import { WORKFLOW_TEMPLATES } from '../services/templates';
import { projectSpend } from '../services/projects';
import { definitionSchema, estimateWorkflow, validateWorkflow, workflowWork, type WorkflowDefinition } from '../services/workflowEngine';
import { likePattern, uuidParam } from './util';

export const workflows = Router();

const mapWf = (w: any, extra: Record<string, unknown> = {}) => ({
  id: w.id, name: w.name, description: w.description, status: w.status, version: w.version, projectId: w.project_id ?? null,
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
  projectId: z.string().uuid().optional(),
});

/** A workflow may belong to a project, but only one in the caller's own organisation. */
async function checkProject(orgId: string, projectId: string | undefined): Promise<string | null> {
  if (!projectId) return null;
  const ok = (await getDb().query('SELECT 1 FROM projects WHERE id=$1 AND org_id=$2', [projectId, orgId])).rows.length > 0;
  if (!ok) throw notFound('Project not found');
  return projectId;
}

workflows.post(
  '/',
  wrap(async (req, res) => {
    const b = createBody.parse(req.body);
    const projectId = await checkProject(req.user!.orgId, b.projectId);
    const { rows } = await getDb().query(
      `INSERT INTO workflows (org_id, project_id, name, description, definition, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [req.user!.orgId, projectId, b.name, b.description, JSON.stringify(b.definition), req.user!.id],
    );
    res.status(201).json(mapWf(rows[0]));
  }),
);

workflows.post(
  '/from-template',
  wrap(async (req, res) => {
    const b = z.object({ templateId: z.string(), name: z.string().min(1).max(120).optional(), projectId: z.string().uuid().optional() }).parse(req.body);
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === b.templateId);
    if (!t) throw notFound('Template not found');
    const projectId = await checkProject(req.user!.orgId, b.projectId);
    const { rows } = await getDb().query(
      `INSERT INTO workflows (org_id, project_id, name, description, definition, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [req.user!.orgId, projectId, b.name ?? t.name, t.description, JSON.stringify(t.definition), req.user!.id],
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

const record = (w: any) => ({ id: w.id, name: w.name, definition: w.definition as WorkflowDefinition, projectId: w.project_id as string | null });

/** What a run would cost, plus the project budget it would draw on (if the workflow belongs to a project). */
async function costPreview(orgId: string, w: any) {
  const est = await estimateWorkflow(orgId, record(w));
  let budget: { budgetUsd: number; spentUsd: number; leftUsd: number | null } | null = null;
  if (w.project_id) {
    const p = (await getDb().query<{ budget_usd: number }>('SELECT budget_usd FROM projects WHERE id=$1 AND org_id=$2', [w.project_id, orgId])).rows[0];
    if (p) {
      const spend = await projectSpend(orgId, w.project_id);
      budget = { budgetUsd: p.budget_usd, spentUsd: spend.totalUsd, leftUsd: p.budget_usd > 0 ? Math.max(0, p.budget_usd - spend.totalUsd) : null };
    }
  }
  return { ...est, budget };
}

workflows.post(
  '/:id/estimate',
  wrap(async (req, res) => {
    res.json(await costPreview(req.user!.orgId, await load(req.user!.orgId, uuidParam(req))));
  }),
);

workflows.post(
  '/:id/run',
  wrap(async (req, res) => {
    const u = req.user!;
    const w = await load(u.orgId, uuidParam(req));
    const body = z.object({ input: z.record(z.string(), z.any()).default({}), expectedTotalUsd: z.number().min(0).max(1_000_000).optional() }).parse(req.body ?? {});
    const errors = validateWorkflow(w.definition).filter((i) => i.level === 'error');
    if (errors.length) throw badRequest('Workflow has validation errors', errors);

    // A workflow that generates media spends real money: the caller must send the total they were shown, and it must still hold.
    const preview = await costPreview(u.orgId, w);
    if (preview.problems.length) throw badRequest(`This workflow can't run yet: ${preview.problems[0]}`, preview.problems);
    if (preview.steps.length > 0) {
      const ceiling = preview.upTo ? ' (at most)' : '';
      if (body.expectedTotalUsd === undefined) {
        throw new HttpError(409, `This workflow spends about $${preview.totalUsd.toFixed(2)}${ceiling}. Review the cost and confirm to run it.`, 'cost_confirmation_required', { estimate: preview });
      }
      if (preview.totalUsd > body.expectedTotalUsd + 1e-6) {
        throw new HttpError(409, `The cost is now $${preview.totalUsd.toFixed(2)}${ceiling}, more than the $${body.expectedTotalUsd.toFixed(2)} you approved. Review it and confirm again.`, 'cost_confirmation_required', { estimate: preview });
      }
      if (preview.budget && preview.budget.budgetUsd > 0 && preview.budget.spentUsd + preview.totalUsd > preview.budget.budgetUsd + 1e-9) {
        throw new HttpError(402, `This run would take the project over its $${preview.budget.budgetUsd.toFixed(2)} budget ($${(preview.budget.leftUsd ?? 0).toFixed(2)} left). Raise the budget or trim the workflow.`, 'over_budget');
      }
    }

    const run = await createRun({ orgId: u.orgId, kind: 'workflow', refId: w.id, refName: w.name, input: body.input, createdBy: u.id });
    // Fire and return: execution progress streams over Socket.IO; clients can also poll GET /runs/:id.
    void queue.enqueue(u.orgId, run.id, workflowWork(u.orgId, record(w), body.input));
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

