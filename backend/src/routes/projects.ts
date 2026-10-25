import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound, wrap } from '../lib/errors';
import { clearChat, directorTurn, loadMessages, toDtos } from '../services/director';
import { manifestCsv, scriptMarkdown, streamClipsZip } from '../services/projectExport';
import { PROJECT_TYPE_IDS, PROJECT_TYPES } from '../services/projectTypes';
import {
  addItems, ASSET_KINDS, cleanBrief, emptyBrief, estimateItems, expandVariants, itemCreate, itemUpdate, loadItem, loadItems, loadProject, loadTakes,
  mapAsset, mapItem, mapProject, projectSpend, startGeneration, touchProject, updateItem,
} from '../services/projects';
import { likePattern, uuidParam } from './util';

export const projects = Router();

projects.get('/types', (_req, res) => {
  res.json(Object.values(PROJECT_TYPES));
});

projects.get(
  '/',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const params: unknown[] = [org];
    let where = `p.org_id=$1 AND p.status='active'`;
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      params.push(likePattern(req.query.q.trim()));
      where += ' AND (p.name ILIKE $2 OR p.description ILIKE $2)';
    }
    const { rows } = await getDb().query<any>(
      `SELECT p.*,
         (SELECT COUNT(*)::int FROM project_items i WHERE i.project_id=p.id) AS item_count,
         (SELECT COUNT(*)::int FROM project_items i WHERE i.project_id=p.id AND i.status='approved') AS approved_count,
         (SELECT COALESCE(SUM(r.cost_usd),0)::float8 FROM job_runs r WHERE r.org_id=p.org_id AND r.kind='generation' AND r.status='completed' AND r.input->>'projectId'=p.id::text) AS spent_usd
       FROM projects p WHERE ${where} ORDER BY p.updated_at DESC LIMIT 200`,
      params,
    );
    res.json(rows.map((r) => ({ ...mapProject(r), itemCount: r.item_count, approvedCount: r.approved_count, spentUsd: r.spent_usd })));
  }),
);

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(PROJECT_TYPE_IDS),
  description: z.string().max(500).default(''),
  aspect: z.string().max(10).optional(),
  budgetUsd: z.number().min(0).max(1_000_000).default(0),
});

projects.post(
  '/',
  wrap(async (req, res) => {
    const b = createBody.parse(req.body);
    const u = req.user!;
    const { rows } = await getDb().query(
      `INSERT INTO projects (org_id, name, type, description, brief, budget_usd, aspect, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
      [u.orgId, b.name, b.type, b.description, JSON.stringify(emptyBrief(b.type)), b.budgetUsd, b.aspect ?? PROJECT_TYPES[b.type].defaultAspect, u.id],
    );
    res.status(201).json(mapProject(rows[0]));
  }),
);

/** Everything the project page needs in one call. */
async function snapshot(orgId: string, id: string) {
  const project = await loadProject(orgId, id);
  const [items, takes, assets] = await Promise.all([
    loadItems(orgId, id),
    loadTakes(orgId, id),
    getDb().query('SELECT * FROM project_assets WHERE project_id=$1 AND org_id=$2 ORDER BY created_at', [id, orgId]),
  ]);
  const est = await estimateItems(orgId, items);
  const byId = new Map(est.estimates.map((e) => [e.itemId, e]));
  const spend = await projectSpend(orgId, id, items);
  const workflows = (await getDb().query('SELECT id, name, status, updated_at FROM workflows WHERE org_id=$1 AND project_id=$2 ORDER BY updated_at DESC', [orgId, id])).rows;
  return {
    project: mapProject(project),
    type: PROJECT_TYPES[project.type],
    items: items.map((i) => ({ ...mapItem(i), estimate: byId.get(i.id), takes: (takes.get(i.id) ?? []).slice(0, 8), takeCount: takes.get(i.id)?.length ?? 0 })),
    assets: assets.rows.map(mapAsset),
    workflows: workflows.map((w: any) => ({ id: w.id, name: w.name, status: w.status, updatedAt: new Date(w.updated_at).toISOString() })),
    spend,
    totalEstimateUsd: est.totalUsd,
  };
}

projects.get('/:id', wrap(async (req, res) => void res.json(await snapshot(req.user!.orgId, uuidParam(req)))));

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500),
    aspect: z.string().max(10),
    budgetUsd: z.number().min(0).max(1_000_000),
    brief: z.record(z.string(), z.any()),
    status: z.enum(['active', 'archived']),
  })
  .partial();

projects.put(
  '/:id',
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const org = req.user!.orgId;
    const b = updateBody.parse(req.body);
    const cur = await loadProject(org, id);
    const brief = b.brief ? { ...cur.brief, ...cleanBrief(cur.type, b.brief) } : cur.brief;
    const { rows } = await getDb().query(
      `UPDATE projects SET name=$3, description=$4, aspect=$5, budget_usd=$6, brief=$7::jsonb, status=$8, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`,
      [id, org, b.name ?? cur.name, b.description ?? cur.description, b.aspect ?? cur.aspect, b.budgetUsd ?? cur.budget_usd, JSON.stringify(brief), b.status ?? cur.status],
    );
    res.json(mapProject(rows[0]));
  }),
);

projects.delete(
  '/:id',
  wrap(async (req, res) => {
    const r = await getDb().query('DELETE FROM projects WHERE id=$1 AND org_id=$2', [uuidParam(req), req.user!.orgId]);
    if (r.rowCount === 0) throw notFound('Project not found');
    res.status(204).end();
  }),
);

// ---- board items ---------------------------------------------------------------------------------------
projects.post(
  '/:id/items',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const b = z.union([z.object({ items: z.array(itemCreate).min(1).max(100) }), itemCreate.transform((i) => ({ items: [i] }))]).parse(req.body);
    const rows = await addItems(org, project.id, b.items, PROJECT_TYPES[project.type].itemKind);
    res.status(201).json(rows.map(mapItem));
  }),
);

projects.put(
  '/:id/items/reorder',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body);
    await getDb().tx(async (t) => {
      for (const [pos, id] of ids.entries()) await t.query('UPDATE project_items SET position=$3 WHERE id=$1 AND project_id=$2', [id, project.id, pos]);
    });
    await touchProject(project.id);
    res.json({ ok: true });
  }),
);

projects.put(
  '/:id/items/:itemId',
  wrap(async (req, res) => {
    const row = await updateItem(req.user!.orgId, uuidParam(req), uuidParam(req, 'itemId'), itemUpdate.parse(req.body));
    res.json(mapItem(row));
  }),
);

projects.post(
  '/:id/items/:itemId/duplicate',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const src = await loadItem(org, project.id, uuidParam(req, 'itemId'));
    const [row] = await addItems(
      org, project.id,
      [{ group: src.group_name, title: `${src.title} (copy)`.slice(0, 160), prompt: src.prompt, notes: src.notes, modelId: src.model_id, mode: src.mode, settings: src.settings, media: src.media, meta: { ...src.meta, startFromItemId: src.meta?.startFromItemId } }],
      src.kind,
    );
    res.status(201).json(mapItem(row));
  }),
);

projects.delete(
  '/:id/items/:itemId',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const item = await loadItem(org, project.id, uuidParam(req, 'itemId'));
    if (item.status === 'generating') throw badRequest('This item is generating right now. Wait for it to finish.');
    await getDb().query('DELETE FROM project_items WHERE id=$1', [item.id]);
    await touchProject(project.id);
    res.status(204).end();
  }),
);

// ---- cost, variants, generation ----------------------------------------------------------------------
projects.post(
  '/:id/estimate',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(500).optional() }).parse(req.body ?? {});
    const all = await loadItems(org, project.id);
    const chosen = ids ? all.filter((i) => ids.includes(i.id)) : all.filter((i) => i.status !== 'approved' && i.model_id);
    const est = await estimateItems(org, chosen, { live: true });
    const spend = await projectSpend(org, project.id, all);
    res.json({ ...est, budgetUsd: project.budget_usd, spend, budgetLeftUsd: project.budget_usd > 0 ? Math.max(0, project.budget_usd - spend.totalUsd) : null });
  }),
);

projects.post(
  '/:id/variants',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const b = z
      .object({
        baseItemId: z.string().uuid(),
        hooks: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
        aspects: z.array(z.string().max(10)).max(6).default([]),
        create: z.boolean().default(false),
      })
      .parse(req.body);
    res.json(await expandVariants(org, project, b.baseItemId, b.hooks, b.aspects, { create: b.create }));
  }),
);

projects.post(
  '/:id/generate',
  wrap(async (req, res) => {
    const u = req.user!;
    const project = await loadProject(u.orgId, uuidParam(req));
    // The caller must send the total they were shown; the server re-prices and refuses if it went up.
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(60), expectedTotalUsd: z.number().min(0).max(1_000_000) }).parse(req.body);
    const r = await startGeneration(u.orgId, u.id, project, b.ids, { expectedTotalUsd: b.expectedTotalUsd });
    res.status(202).json(r);
  }),
);

// ---- export ---------------------------------------------------------------------------------------------
const fileName = (name: string) => name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 50) || 'project';

projects.get(
  '/:id/export/script.md',
  wrap(async (req, res) => {
    const project = await loadProject(req.user!.orgId, uuidParam(req));
    res.type('text/markdown; charset=utf-8').attachment(`${fileName(project.name)}-script.md`).send(await scriptMarkdown(req.user!.orgId, project.id));
  }),
);

projects.get(
  '/:id/export/shot-list.csv',
  wrap(async (req, res) => {
    const project = await loadProject(req.user!.orgId, uuidParam(req));
    res.type('text/csv; charset=utf-8').attachment(`${fileName(project.name)}-shot-list.csv`).send(await manifestCsv(req.user!.orgId, project.id));
  }),
);

projects.get(
  '/:id/export/clips.zip',
  wrap(async (req, res) => {
    const project = await loadProject(req.user!.orgId, uuidParam(req));
    await streamClipsZip(req.user!.orgId, project.id, res);
  }),
);

// ---- reference assets -----------------------------------------------------------------------------------
const assetBody = z.object({
  kind: z.enum(ASSET_KINDS),
  name: z.string().trim().min(1).max(80),
  url: z.string().max(2100).regex(/^(https?:\/\/\S+)?$/i, 'Must be a public http(s) URL').default(''),
  notes: z.string().max(1000).default(''),
  characterId: z.string().regex(/^([0-9a-f-]{36})?$/i, 'Not a valid Soul ID').default(''),
  mediaId: z.string().uuid().optional(),
});

projects.post(
  '/:id/assets',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const b = assetBody.parse(req.body);
    let url = b.url;
    if (b.mediaId) {
      const m = (await getDb().query<{ url: string }>('SELECT url FROM media_assets WHERE id=$1 AND org_id=$2', [b.mediaId, org])).rows[0];
      if (!m) throw notFound('Media item not found');
      if (m.url.startsWith('data:')) throw badRequest('That library item is a placeholder with no public URL.');
      url = m.url;
    }
    const { rows } = await getDb().query(
      `INSERT INTO project_assets (org_id, project_id, kind, name, url, notes, character_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [org, project.id, b.kind, b.name, url, b.notes, b.characterId],
    );
    await touchProject(project.id);
    res.status(201).json(mapAsset(rows[0]));
  }),
);

projects.put(
  '/:id/assets/:assetId',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const b = assetBody.omit({ mediaId: true }).partial().parse(req.body);
    const cur = (await getDb().query('SELECT * FROM project_assets WHERE id=$1 AND project_id=$2 AND org_id=$3', [uuidParam(req, 'assetId'), project.id, org])).rows[0];
    if (!cur) throw notFound('Asset not found');
    const { rows } = await getDb().query(
      `UPDATE project_assets SET kind=$2, name=$3, url=$4, notes=$5, character_id=$6 WHERE id=$1 RETURNING *`,
      [cur.id, b.kind ?? cur.kind, b.name ?? cur.name, b.url ?? cur.url, b.notes ?? cur.notes, b.characterId ?? cur.character_id],
    );
    // A replaced image (for example one re-uploaded after Higgsfield deleted the old file) must also replace the old link
    // on the shots that already use it, or those shots keep pointing at the dead file.
    if (b.url && cur.url && b.url !== cur.url) {
      const items = (await getDb().query('SELECT id, media FROM project_items WHERE project_id=$1 AND org_id=$2', [project.id, org])).rows;
      for (const it of items) {
        const media = it.media ?? {};
        if (!Object.values(media).some((l) => Array.isArray(l) && l.includes(cur.url))) continue;
        const next = Object.fromEntries(Object.entries(media).map(([role, l]) => [role, Array.isArray(l) ? l.map((u) => (u === cur.url ? b.url : u)) : l]));
        await getDb().query('UPDATE project_items SET media=$2::jsonb WHERE id=$1', [it.id, JSON.stringify(next)]);
      }
    }
    res.json(mapAsset(rows[0]));
  }),
);

projects.delete(
  '/:id/assets/:assetId',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    const r = await getDb().query('DELETE FROM project_assets WHERE id=$1 AND project_id=$2 AND org_id=$3', [uuidParam(req, 'assetId'), project.id, org]);
    if (r.rowCount === 0) throw notFound('Asset not found');
    res.status(204).end();
  }),
);

// ---- chat with the director ----------------------------------------------------------------------------
projects.get(
  '/:id/chat',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const project = await loadProject(org, uuidParam(req));
    res.json({ messages: toDtos(await loadMessages(org, project.id)) });
  }),
);

projects.post(
  '/:id/chat',
  wrap(async (req, res) => {
    const u = req.user!;
    const project = await loadProject(u.orgId, uuidParam(req));
    const b = z.object({ message: z.string().trim().min(1).max(6000), model: z.string().max(60).optional() }).parse(req.body);
    res.json(await directorTurn(u.orgId, u.id, project.id, b.message, b.model));
  }),
);

projects.delete(
  '/:id/chat',
  wrap(async (req, res) => {
    const project = await loadProject(req.user!.orgId, uuidParam(req));
    await clearChat(req.user!.orgId, project.id);
    res.status(204).end();
  }),
);
