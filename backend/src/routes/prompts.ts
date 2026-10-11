import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound, wrap } from '../lib/errors';
import { getModel } from '../lib/pricing';
import { extractVariables, render } from '../lib/template';
import { runPrompt } from '../services/claude';
import { createRun, mapRun, queue, type Work } from '../services/jobs';
import { recordUsage } from '../services/usage';
import { isUuid, likePattern, uuidParam } from './util';

export const prompts = Router();

const modelId = z.string().refine((m) => !!getModel(m), 'Unknown model');
const content = {
  system: z.string().max(100_000).default(''),
  user: z.string().max(200_000),
  model: modelId,
  temperature: z.number().min(0).max(1).nullable().optional(),
  maxTokens: z.number().int().min(1).max(128_000).default(1024),
  variables: z.record(z.string(), z.string().max(100_000)).default({}),
};

const runBody = z.object({ ...content, user: content.user.min(1), promptId: z.string().optional(), version: z.number().int().optional() });

/** Build the queue work for one prompt execution, plus metadata the response needs. */
function promptWork(orgId: string, p: z.infer<typeof runBody>) {
  const user = render(p.user, p.variables);
  const system = render(p.system, p.variables);
  const model = getModel(p.model)!;
  const missing = [...new Set([...user.missing, ...system.missing])];
  const temperatureIgnored = !model.supportsTemperature && typeof p.temperature === 'number';
  const work: Work = async ({ runId, log }) => {
    await log('info', `Running ${model.id} (max_tokens ${p.maxTokens})`);
    if (missing.length) await log('warn', `Unresolved variables: ${missing.join(', ')}`);
    if (temperatureIgnored) await log('warn', `${model.label} does not accept a temperature setting — ignored`);
    const r = await runPrompt(orgId, { model: p.model, system: system.text, user: user.text, temperature: p.temperature, maxTokens: p.maxTokens });
    await recordUsage({ orgId, runId, provider: 'claude', model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, simulated: r.simulated });
    if (r.simulated) await log('warn', 'No Anthropic API key configured — simulated response');
    await log('info', `Finished: ${r.inputTokens} in / ${r.outputTokens} out · $${r.costUsd.toFixed(5)} · ${r.latencyMs}ms`);
    return { output: { text: r.text, stopReason: r.stopReason }, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, simulated: r.simulated };
  };
  return { work, missing, temperatureIgnored };
}

async function promptName(orgId: string, id?: string): Promise<{ id: string | null; name: string }> {
  if (!id || !isUuid(id)) return { id: null, name: 'Ad-hoc prompt' };
  const { rows } = await getDb().query<{ name: string }>('SELECT name FROM prompts WHERE id=$1 AND org_id=$2', [id, orgId]);
  return rows[0] ? { id, name: rows[0].name } : { id: null, name: 'Ad-hoc prompt' };
}

prompts.post(
  '/run',
  wrap(async (req, res) => {
    const body = runBody.parse(req.body);
    const u = req.user!;
    const ref = await promptName(u.orgId, body.promptId);
    const { work, missing, temperatureIgnored } = promptWork(u.orgId, body);
    const run = await createRun({
      orgId: u.orgId, kind: 'prompt', refId: ref.id, refName: ref.name, model: body.model, createdBy: u.id,
      input: { system: body.system, user: body.user, variables: body.variables, temperature: body.temperature, maxTokens: body.maxTokens },
    });
    const done = await queue.enqueue(u.orgId, run.id, work);
    res.status(done.status === 'failed' ? 502 : 200).json({ run: done, missingVariables: missing, temperatureIgnored });
  }),
);

const compareBody = z.object({
  promptId: z.string().optional(),
  system: z.string().max(100_000).default(''),
  user: z.string().min(1).max(200_000),
  variables: z.record(z.string(), z.string().max(100_000)).default({}),
  maxTokens: z.number().int().min(1).max(128_000).default(1024),
  temperature: z.number().min(0).max(1).nullable().optional(),
  variants: z
    .array(z.object({ label: z.string().max(60).optional(), model: modelId, system: z.string().max(100_000).optional(), user: z.string().min(1).max(200_000).optional() }))
    .min(2)
    .max(4),
});

/** Run the same prompt against several models / prompt texts in parallel and return them side by side. */
prompts.post(
  '/compare',
  wrap(async (req, res) => {
    const body = compareBody.parse(req.body);
    const u = req.user!;
    const ref = await promptName(u.orgId, body.promptId);
    const results = await Promise.all(
      body.variants.map(async (v, i) => {
        const p = runBody.parse({ ...body, model: v.model, system: v.system ?? body.system, user: v.user ?? body.user });
        const { work, missing } = promptWork(u.orgId, p);
        const run = await createRun({
          orgId: u.orgId, kind: 'prompt', refId: ref.id, refName: `${ref.name} (compare)`, model: v.model, createdBy: u.id,
          input: { system: p.system, user: p.user, variables: p.variables, maxTokens: p.maxTokens },
        });
        const done = await queue.enqueue(u.orgId, run.id, work);
        return { label: v.label ?? `Variant ${i + 1}`, run: done, missingVariables: missing };
      }),
    );
    res.json({ results });
  }),
);

prompts.get(
  '/runs',
  wrap(async (req, res) => {
    const { rows } = await getDb().query(
      `SELECT * FROM job_runs WHERE org_id=$1 AND kind='prompt' ORDER BY queued_at DESC LIMIT $2`,
      [req.user!.orgId, Math.min(Number(req.query.limit) || 25, 100)],
    );
    res.json(rows.map(mapRun));
  }),
);

const mapVersion = (v: any) => ({
  id: v.id, version: v.version, systemPrompt: v.system_prompt, userPrompt: v.user_prompt, model: v.model,
  temperature: v.temperature, maxTokens: v.max_tokens, variables: v.variables, note: v.note,
  createdBy: v.created_by, createdAt: new Date(v.created_at).toISOString(),
});
const mapPrompt = (p: any) => ({
  id: p.id, name: p.name, description: p.description, isTemplate: p.is_template, tags: p.tags,
  currentVersion: p.current_version, updatedAt: new Date(p.updated_at).toISOString(), createdAt: new Date(p.created_at).toISOString(),
});

prompts.get(
  '/',
  wrap(async (req, res) => {
    const params: unknown[] = [req.user!.orgId];
    let where = 'p.org_id = $1';
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      params.push(likePattern(req.query.q.trim()));
      where += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR v.user_prompt ILIKE $${params.length})`;
    }
    if (req.query.template === 'true') where += ' AND p.is_template';
    const { rows } = await getDb().query(
      `SELECT p.*, v.model, v.user_prompt FROM prompts p JOIN prompt_versions v ON v.prompt_id = p.id AND v.version = p.current_version
       WHERE ${where} ORDER BY p.updated_at DESC LIMIT 200`,
      params,
    );
    res.json(rows.map((r) => ({ ...mapPrompt(r), model: r.model, preview: String(r.user_prompt).slice(0, 140) })));
  }),
);

const createBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  isTemplate: z.boolean().default(false),
  tags: z.array(z.string().max(30)).max(10).default([]),
  ...content,
  note: z.string().max(200).default(''),
});

prompts.post(
  '/',
  wrap(async (req, res) => {
    const b = createBody.parse(req.body);
    const u = req.user!;
    const out = await getDb().tx(async (t) => {
      const p = (await t.query(
        `INSERT INTO prompts (org_id, name, description, is_template, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [u.orgId, b.name, b.description, b.isTemplate, b.tags, u.id],
      )).rows[0];
      const v = (await t.query(
        `INSERT INTO prompt_versions (prompt_id, version, system_prompt, user_prompt, model, temperature, max_tokens, variables, note, created_by)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
        [p.id, b.system, b.user, b.model, b.temperature ?? null, b.maxTokens, JSON.stringify(b.variables), b.note, u.id],
      )).rows[0];
      return { prompt: mapPrompt(p), versions: [mapVersion(v)] };
    });
    res.status(201).json(out);
  }),
);

prompts.get(
  '/:id',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const db = getDb();
    const p = (await db.query('SELECT * FROM prompts WHERE id=$1 AND org_id=$2', [id, req.user!.orgId])).rows[0];
    if (!p) throw notFound('Prompt not found');
    const versions = (await db.query('SELECT * FROM prompt_versions WHERE prompt_id=$1 ORDER BY version DESC', [id])).rows;
    res.json({ prompt: mapPrompt(p), versions: versions.map(mapVersion), variableNames: extractVariables(versions[0]?.system_prompt ?? '', versions[0]?.user_prompt ?? '') });
  }),
);

prompts.post(
  '/:id/versions',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const b = z.object({ ...content, note: z.string().max(200).default('') }).parse(req.body);
    const u = req.user!;
    const out = await getDb().tx(async (t) => {
      const p = (await t.query('SELECT * FROM prompts WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, u.orgId])).rows[0];
      if (!p) throw notFound('Prompt not found');
      const next = (await t.query<{ n: number }>('SELECT COALESCE(MAX(version),0)::int + 1 AS n FROM prompt_versions WHERE prompt_id=$1', [id])).rows[0].n;
      const v = (await t.query(
        `INSERT INTO prompt_versions (prompt_id, version, system_prompt, user_prompt, model, temperature, max_tokens, variables, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
        [id, next, b.system, b.user, b.model, b.temperature ?? null, b.maxTokens, JSON.stringify(b.variables), b.note, u.id],
      )).rows[0];
      await t.query('UPDATE prompts SET current_version=$2, updated_at=now() WHERE id=$1', [id, next]);
      return mapVersion(v);
    });
    res.status(201).json(out);
  }),
);

prompts.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const b = z
      .object({ name: z.string().min(1).max(120), description: z.string().max(500), isTemplate: z.boolean(), tags: z.array(z.string().max(30)).max(10) })
      .partial()
      .parse(req.body);
    if (Object.keys(b).length === 0) throw badRequest('Nothing to update');
    const { rows } = await getDb().query(
      `UPDATE prompts SET name=COALESCE($3,name), description=COALESCE($4,description), is_template=COALESCE($5,is_template),
         tags=COALESCE($6,tags), updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`,
      [id, req.user!.orgId, b.name ?? null, b.description ?? null, b.isTemplate ?? null, b.tags ?? null],
    );
    if (!rows[0]) throw notFound('Prompt not found');
    res.json(mapPrompt(rows[0]));
  }),
);

prompts.delete(
  '/:id',
  wrap(async (req, res) => {
    const r = await getDb().query('DELETE FROM prompts WHERE id=$1 AND org_id=$2', [uuidParam(req), req.user!.orgId]);
    if (r.rowCount === 0) throw notFound('Prompt not found');
    res.status(204).end();
  }),
);

