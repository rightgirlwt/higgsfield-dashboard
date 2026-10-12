import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { createRun, generationQueue, type RunDto, type Work } from './jobs';
import { getPrices, prepareGeneration, runStudioGeneration, type GenerateParams } from './studio';
import { billedSeconds, getStudioModel, LIST_PRICES, outputsPerRequest, unitPrice, type MediaRole } from './studioCatalog';
import { PROJECT_TYPES, type ProjectType } from './projectTypes';

export const ROLES = ['start', 'end', 'reference', 'video', 'audio'] as const;
export const ITEM_STATUSES = ['draft', 'ready', 'generating', 'review', 'approved', 'rejected'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ASSET_KINDS = ['character', 'product', 'logo', 'location', 'style', 'reference'] as const;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

// ---- DTOs --------------------------------------------------------------------------------------------
export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  type: ProjectType;
  brief: Record<string, string>;
  budget_usd: number;
  aspect: string;
  status: 'active' | 'archived';
  created_at: Date;
  updated_at: Date;
}

export const mapProject = (p: ProjectRow) => ({
  id: p.id, name: p.name, description: p.description, type: p.type, brief: p.brief ?? {}, budgetUsd: p.budget_usd, aspect: p.aspect,
  status: p.status, createdAt: iso(p.created_at)!, updatedAt: iso(p.updated_at)!,
});

export interface ItemRow {
  id: string;
  project_id: string;
  kind: 'shot' | 'ad_unit';
  group_name: string;
  position: number;
  title: string;
  prompt: string;
  notes: string;
  model_id: string;
  mode: string;
  settings: Record<string, any>;
  media: Partial<Record<MediaRole, string[]>>;
  meta: Record<string, any>;
  status: ItemStatus;
  last_error: string | null;
  approved_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const mapItem = (r: ItemRow) => ({
  id: r.id, projectId: r.project_id, kind: r.kind, group: r.group_name, position: r.position, title: r.title, prompt: r.prompt, notes: r.notes,
  modelId: r.model_id, mode: r.mode, settings: r.settings ?? {}, media: r.media ?? {}, meta: r.meta ?? {}, status: r.status, lastError: r.last_error,
  approvedAssetId: r.approved_asset_id, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});
export type ItemDto = ReturnType<typeof mapItem>;

export const mapAsset = (r: any) => ({
  id: r.id, kind: r.kind, name: r.name, url: r.url, notes: r.notes, characterId: r.character_id, createdAt: iso(r.created_at)!,
});

// ---- loading -----------------------------------------------------------------------------------------
export async function loadProject(orgId: string, id: string): Promise<ProjectRow> {
  const { rows } = await getDb().query<ProjectRow>('SELECT * FROM projects WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Project not found');
  return rows[0];
}

export async function loadItems(orgId: string, projectId: string): Promise<ItemRow[]> {
  const { rows } = await getDb().query<ItemRow>('SELECT * FROM project_items WHERE org_id=$1 AND project_id=$2 ORDER BY position, created_at', [orgId, projectId]);
  return rows;
}

export async function loadItem(orgId: string, projectId: string, itemId: string): Promise<ItemRow> {
  const { rows } = await getDb().query<ItemRow>('SELECT * FROM project_items WHERE id=$1 AND org_id=$2 AND project_id=$3', [itemId, orgId, projectId]);
  if (!rows[0]) throw notFound('Item not found');
  return rows[0];
}

export const touchProject = (projectId: string) => getDb().query('UPDATE projects SET updated_at=now() WHERE id=$1', [projectId]);

export interface Take {
  id: string;
  itemId: string;
  type: 'photo' | 'video';
  url: string;
  thumbUrl: string;
  title: string;
  createdAt: string;
}

/** Everything generated for a project's items, newest first, grouped by item id. */
export async function loadTakes(orgId: string, projectId: string): Promise<Map<string, Take[]>> {
  const { rows } = await getDb().query<any>(
    `SELECT id, type, url, thumb_url, title, created_at, metadata->>'itemId' AS item_id
     FROM media_assets WHERE org_id=$1 AND metadata->>'projectId'=$2 AND metadata->>'itemId' IS NOT NULL ORDER BY created_at DESC, id DESC`,
    [orgId, projectId],
  );
  const out = new Map<string, Take[]>();
  for (const r of rows) {
    const t: Take = { id: r.id, itemId: r.item_id, type: r.type, url: r.url, thumbUrl: r.thumb_url, title: r.title, createdAt: iso(r.created_at)! };
    (out.get(t.itemId) ?? out.set(t.itemId, []).get(t.itemId)!).push(t);
  }
  return out;
}

// ---- item validation ---------------------------------------------------------------------------------
export const itemFields = {
  group: z.string().trim().max(120),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().max(5000),
  notes: z.string().max(4000),
  modelId: z.string().max(60),
  mode: z.string().max(40),
  settings: z.record(z.string(), z.any()),
  media: z.partialRecord(z.enum(ROLES), z.array(z.string().max(2100)).max(9)),
  meta: z.record(z.string(), z.any()),
};
export const itemCreate = z.object({
  group: itemFields.group.default(''),
  title: itemFields.title,
  prompt: itemFields.prompt.default(''),
  notes: itemFields.notes.default(''),
  modelId: itemFields.modelId.default(''),
  mode: itemFields.mode.default(''),
  settings: itemFields.settings.default({}),
  media: itemFields.media.default({}),
  meta: itemFields.meta.default({}),
});
export const itemUpdate = z
  .object({ ...itemFields, status: z.enum(ITEM_STATUSES), approvedAssetId: z.string().uuid().nullable() })
  .partial();
export type ItemCreate = z.infer<typeof itemCreate>;

/** A stand-in URL that lets a "start from another shot" item be validated and priced before that frame exists. */
const PENDING_FRAME = 'https://pending.invalid/frame.png';

function configFor(i: { prompt: string; modelId: string; mode: string; settings: Record<string, any>; media: Partial<Record<MediaRole, string[]>>; meta: Record<string, any> }): GenerateParams {
  const media = { ...i.media };
  if (i.meta?.startFromItemId && !media.start?.length) media.start = [PENDING_FRAME];
  return {
    modelId: i.modelId,
    mode: i.mode || undefined,
    prompt: i.prompt.trim() || 'draft',
    settings: i.settings,
    media,
    count: clampCount(i.meta?.count),
  };
}
const clampCount = (v: unknown) => Math.min(4, Math.max(1, Math.floor(Number(v) || 1)));

/** Throws a 400 when the model / mode / settings / media don't fit the catalog. Items with no model yet are allowed (still being planned). */
export function validateItemConfig(i: Parameters<typeof configFor>[0]): void {
  if (!i.modelId) return;
  prepareGeneration(configFor(i));
}

export async function addItems(orgId: string, projectId: string, items: ItemCreate[], kind: 'shot' | 'ad_unit'): Promise<ItemRow[]> {
  const db = getDb();
  const start = (await db.query<{ m: number | null }>('SELECT MAX(position) AS m FROM project_items WHERE project_id=$1', [projectId])).rows[0].m ?? -1;
  const out: ItemRow[] = [];
  let pos = start + 1;
  // Validate everything first so a bad item never leaves a half-saved batch behind.
  for (const [n, i] of items.entries()) {
    try {
      validateItemConfig(i);
    } catch (e) {
      if (e instanceof HttpError) throw badRequest(`Item ${n + 1} ("${i.title}"): ${e.message}`);
      throw e;
    }
  }
  for (const i of items) {
    const { rows } = await db.query<ItemRow>(
      `INSERT INTO project_items (org_id, project_id, kind, group_name, position, title, prompt, notes, model_id, mode, settings, media, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb) RETURNING *`,
      [orgId, projectId, kind, i.group, pos++, i.title, i.prompt, i.notes, i.modelId, i.mode, JSON.stringify(i.settings), JSON.stringify(i.media), JSON.stringify(i.meta)],
    );
    out.push(rows[0]);
  }
  await touchProject(projectId);
  return out;
}

export async function updateItem(orgId: string, projectId: string, itemId: string, patch: z.infer<typeof itemUpdate>): Promise<ItemRow> {
  const cur = await loadItem(orgId, projectId, itemId);
  if (cur.status === 'generating' && (patch.prompt !== undefined || patch.modelId !== undefined || patch.settings !== undefined)) {
    throw conflict('This item is generating right now. Wait for it to finish before changing it.');
  }
  const next = {
    group: patch.group ?? cur.group_name,
    title: patch.title ?? cur.title,
    prompt: patch.prompt ?? cur.prompt,
    notes: patch.notes ?? cur.notes,
    modelId: patch.modelId ?? cur.model_id,
    mode: patch.mode ?? cur.mode,
    settings: patch.settings ?? cur.settings,
    media: (patch.media ?? cur.media) as Partial<Record<MediaRole, string[]>>,
    meta: patch.meta ?? cur.meta,
  };
  // Changing the model without saying which mode/settings to keep would carry over keys the new model rejects.
  if (patch.modelId !== undefined && patch.modelId !== cur.model_id) {
    if (patch.mode === undefined) next.mode = '';
    if (patch.settings === undefined) next.settings = {};
  }
  validateItemConfig(next);
  let status = patch.status ?? cur.status;
  // Editing the creative of an approved/ready item sends it back to draft so it can't be generated or exported unreviewed.
  const creativeChanged = patch.prompt !== undefined || patch.modelId !== undefined || patch.settings !== undefined || patch.media !== undefined;
  if (patch.status === undefined && creativeChanged && cur.status === 'ready') status = 'draft';
  let approved = patch.approvedAssetId === undefined ? cur.approved_asset_id : patch.approvedAssetId;
  if (patch.approvedAssetId) {
    const ok = (await getDb().query('SELECT 1 FROM media_assets WHERE id=$1 AND org_id=$2 AND metadata->>\'itemId\'=$3', [patch.approvedAssetId, orgId, itemId])).rows.length > 0;
    if (!ok) throw badRequest('That take does not belong to this item');
    if (patch.status === undefined) status = 'approved';
  }
  if (status === 'rejected') approved = null;
  const { rows } = await getDb().query<ItemRow>(
    `UPDATE project_items SET group_name=$4, title=$5, prompt=$6, notes=$7, model_id=$8, mode=$9, settings=$10::jsonb, media=$11::jsonb, meta=$12::jsonb,
       status=$13, approved_asset_id=$14, updated_at=now() WHERE id=$1 AND org_id=$2 AND project_id=$3 RETURNING *`,
    [itemId, orgId, projectId, next.group, next.title, next.prompt, next.notes, next.modelId, next.mode, JSON.stringify(next.settings), JSON.stringify(next.media), JSON.stringify(next.meta), status, approved],
  );
  await touchProject(projectId);
  return rows[0];
}

// ---- cost ----------------------------------------------------------------------------------------------
export type Estimate =
  | { itemId: string; ok: true; costUsd: number | null; outputs: number; seconds: number; unitUsd: number | null; basis: 'admin' | 'list' | null; precision: 'exact' | 'from' | null; model: string; mode: string; promoEnds: string | null }
  | { itemId: string; ok: false; reason: string };

export function estimateItem(item: ItemRow, prices: Record<string, number | null>): Estimate {
  if (!item.model_id) return { itemId: item.id, ok: false, reason: 'Pick a model first' };
  try {
    const p = prepareGeneration(configFor({ prompt: item.prompt, modelId: item.model_id, mode: item.mode, settings: item.settings, media: item.media, meta: item.meta }));
    const unit = unitPrice(p.mode, p.settings, prices[p.model.id] ?? null);
    const outputs = p.requests * outputsPerRequest(p.settings);
    const seconds = billedSeconds(p.model, p.mode, p.settings);
    return {
      itemId: item.id, ok: true, costUsd: unit ? unit.amount * seconds * outputs : null, outputs, seconds, unitUsd: unit?.amount ?? null,
      basis: unit?.basis ?? null, precision: unit?.precision ?? null, model: p.model.label, mode: p.mode.label, promoEnds: LIST_PRICES[p.mode.path]?.promoEnds ?? null,
    };
  } catch (e) {
    return { itemId: item.id, ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function estimateItems(orgId: string, items: ItemRow[]) {
  const prices = await getPrices(orgId);
  const estimates = items.map((i) => estimateItem(i, prices));
  const total = estimates.reduce((s, e) => s + (e.ok ? (e.costUsd ?? 0) : 0), 0);
  return {
    estimates,
    totalUsd: total,
    unpriced: estimates.filter((e) => e.ok && e.costUsd === null).map((e) => e.itemId),
    blocked: estimates.filter((e) => !e.ok).map((e) => ({ itemId: e.itemId, reason: (e as { reason: string }).reason })),
  };
}

export interface Spend {
  generationUsd: number;
  chatUsd: number;
  /** Estimated cost of items still rendering: counted against the budget before they finish. */
  inFlightUsd: number;
  totalUsd: number;
}

export async function projectSpend(orgId: string, projectId: string, items?: ItemRow[]): Promise<Spend> {
  const db = getDb();
  const [g, c] = await Promise.all([
    db.query<{ s: number }>(`SELECT COALESCE(SUM(cost_usd),0)::float8 AS s FROM job_runs WHERE org_id=$1 AND kind='generation' AND status='completed' AND input->>'projectId'=$2`, [orgId, projectId]),
    db.query<{ s: number }>(
      `SELECT COALESCE(SUM(m.cost_usd),0)::float8 AS s FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.project_id=$1 AND t.org_id=$2`,
      [projectId, orgId],
    ),
  ]);
  const rows = items ?? (await loadItems(orgId, projectId));
  const flight = rows.filter((i) => i.status === 'generating');
  const inFlightUsd = flight.length ? (await estimateItems(orgId, flight)).totalUsd : 0;
  const generationUsd = g.rows[0].s;
  const chatUsd = c.rows[0].s;
  return { generationUsd, chatUsd, inFlightUsd, totalUsd: generationUsd + chatUsd + inFlightUsd };
}

// ---- variants (ad matrix) -----------------------------------------------------------------------------
export function variantPlan(base: ItemRow, hooks: string[], aspects: string[]) {
  const hs = hooks.length ? hooks : [''];
  const as = aspects.length ? aspects : [''];
  const model = base.model_id ? getStudioModel(base.model_id) : undefined;
  const out: ItemCreate[] = [];
  for (const [hi, hook] of hs.entries()) {
    for (const aspect of as) {
      const settings = { ...base.settings };
      if (aspect) {
        const mode = model?.modes.find((m) => m.id === base.mode) ?? model?.modes[0];
        const spec = mode?.params.aspect_ratio;
        if (!spec || spec.type !== 'enum' || !spec.values.includes(aspect)) {
          throw badRequest(`${model?.label ?? 'This model'} can't make ${aspect}. Pick a model that supports it, or remove ${aspect} from the matrix.`);
        }
        settings.aspect_ratio = aspect;
      }
      const prompt = hook ? (base.prompt.includes('{{hook}}') ? base.prompt.split('{{hook}}').join(hook) : `${base.prompt}\n\nOpening moment (the hook): ${hook}`) : base.prompt;
      const label = [hs.length > 1 ? `Hook ${hi + 1}` : '', aspect].filter(Boolean).join(' · ');
      out.push({
        group: base.group_name, title: label ? `${base.title} · ${label}` : base.title, prompt, notes: [base.notes, hook ? `Hook: ${hook}` : ''].filter(Boolean).join('\n'),
        modelId: base.model_id, mode: base.mode, settings, media: base.media ?? {}, meta: { ...base.meta, hook: hook || undefined, aspect: aspect || undefined, variantOf: base.id },
      });
    }
  }
  return out;
}

export async function expandVariants(orgId: string, project: ProjectRow, baseId: string, hooks: string[], aspects: string[], opts: { create: boolean }) {
  const base = await loadItem(orgId, project.id, baseId);
  if (!base.model_id) throw badRequest('Give the base unit a model first, so the variants can be priced.');
  const plan = variantPlan(base, hooks, aspects);
  if (plan.length > 60) throw badRequest(`That matrix makes ${plan.length} variants. The limit is 60 at a time.`);
  const prices = await getPrices(orgId);
  // Price every variant without saving it: the preview is the same math the real generation uses.
  const preview = plan.map((p, n) => {
    const fake = { ...base, id: `variant-${n}`, title: p.title, prompt: p.prompt, settings: p.settings, meta: p.meta } as ItemRow;
    return { title: p.title, hook: p.meta.hook ?? null, aspect: p.meta.aspect ?? null, estimate: estimateItem(fake, prices) };
  });
  const totalUsd = preview.reduce((s, v) => s + (v.estimate.ok ? (v.estimate.costUsd ?? 0) : 0), 0);
  const created = opts.create ? await addItems(orgId, project.id, plan, base.kind) : [];
  return { count: plan.length, totalUsd, preview, created: created.map(mapItem) };
}

// ---- generation ---------------------------------------------------------------------------------------
/** The frame a "start from" shot should animate: its approved take, else its newest still image. */
async function frameFrom(orgId: string, projectId: string, sourceId: string): Promise<string | null> {
  const { rows } = await getDb().query<{ url: string }>(
    `SELECT a.url FROM media_assets a LEFT JOIN project_items i ON i.approved_asset_id = a.id AND i.id::text = $3
     WHERE a.org_id=$1 AND a.metadata->>'projectId'=$2 AND a.metadata->>'itemId'=$3 AND a.type='photo'
     ORDER BY (i.id IS NOT NULL) DESC, a.created_at DESC LIMIT 1`,
    [orgId, projectId, sourceId],
  );
  return rows[0]?.url ?? null;
}

export async function paramsForRun(orgId: string, item: ItemRow): Promise<GenerateParams> {
  const media = { ...item.media };
  const src = item.meta?.startFromItemId;
  if (src && !media.start?.length) {
    const url = await frameFrom(orgId, item.project_id, String(src));
    if (!url) throw badRequest(`"${item.title}" starts from another shot, which has no image yet. Generate and approve that one first.`);
    media.start = [url];
  }
  return {
    modelId: item.model_id, mode: item.mode || undefined, prompt: item.prompt, settings: item.settings, media,
    count: clampCount(item.meta?.count), metadata: { projectId: item.project_id, itemId: item.id },
  };
}

/** Runs one card's generation and keeps the card's status honest: review when media came back, draft (with the reason) when nothing did. */
export async function generateCard(orgId: string, item: ItemRow, params: GenerateParams, ctx: Parameters<Work>[0]) {
  const db = getDb();
  try {
    const r = await runStudioGeneration(orgId, ctx, params);
    await db.query(`UPDATE project_items SET status='review', last_error=$2, updated_at=now() WHERE id=$1`, [item.id, r.failures.length ? `${r.failures.length} request(s) failed` : null]);
    return r;
  } catch (e) {
    await db.query(`UPDATE project_items SET status='draft', last_error=$2, updated_at=now() WHERE id=$1`, [item.id, e instanceof Error ? e.message.slice(0, 500) : 'Generation failed']);
    throw e;
  }
}

function itemWork(orgId: string, item: ItemRow, params: GenerateParams): Work {
  return async (ctx) => {
    const r = await generateCard(orgId, item, params, ctx);
    return { output: { assets: r.assets, failures: r.failures }, model: params.modelId, inputTokens: 0, outputTokens: 0, costUsd: r.costUsd, simulated: r.simulated };
  };
}

/** Cards a workflow works on: by status (and optionally scene/concept), in board order. */
export async function selectCards(orgId: string, projectId: string, f: { statuses?: string[]; group?: string; limit?: number }): Promise<ItemRow[]> {
  const statuses = (f.statuses?.length ? f.statuses : ['draft', 'ready', 'rejected']).filter((s): s is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(s));
  const { rows } = await getDb().query<ItemRow>(
    `SELECT * FROM project_items WHERE org_id=$1 AND project_id=$2 AND status = ANY($3::text[]) AND ($4::text = '' OR group_name = $4)
     ORDER BY position, created_at LIMIT $5`,
    [orgId, projectId, statuses, f.group ?? '', Math.min(100, f.limit ?? 50)],
  );
  return rows;
}

export interface StartResult {
  runs: RunDto[];
  totalUsd: number;
  unpriced: string[];
}

/**
 * Starts generation for the chosen items. Nothing is spent unless the caller passes the total they were shown
 * (`expectedTotalUsd`) and the server's own estimate does not exceed it, and the project budget has room.
 */
export async function startGeneration(
  orgId: string,
  userId: string,
  project: ProjectRow,
  ids: string[],
  opts: { expectedTotalUsd: number },
): Promise<StartResult> {
  const all = await loadItems(orgId, project.id);
  const chosen = ids.map((id) => all.find((i) => i.id === id)).filter((i): i is ItemRow => !!i);
  if (chosen.length !== new Set(ids).size) throw notFound('One or more items were not found in this project');
  if (chosen.length === 0) throw badRequest('Choose at least one item to generate');
  const busy = chosen.filter((i) => i.status === 'generating');
  if (busy.length) throw conflict(`Already generating: ${busy.map((i) => `"${i.title}"`).join(', ')}`);

  const est = await estimateItems(orgId, chosen);
  if (est.blocked.length) {
    const first = est.blocked[0];
    const item = chosen.find((i) => i.id === first.itemId)!;
    throw badRequest(`Can't generate "${item.title}": ${first.reason}`, est.blocked);
  }
  // Only float rounding is tolerated: a cent would swamp image costs, which are fractions of a cent.
  if (est.totalUsd > opts.expectedTotalUsd + 1e-6) {
    throw conflict(`The cost is now $${est.totalUsd.toFixed(4)}, more than the $${opts.expectedTotalUsd.toFixed(4)} you approved. Review the estimate and approve again.`);
  }
  if (project.budget_usd > 0) {
    const spend = await projectSpend(orgId, project.id, all);
    if (spend.totalUsd + est.totalUsd > project.budget_usd + 1e-9) {
      const left = Math.max(0, project.budget_usd - spend.totalUsd);
      throw new HttpError(402, `This would take the project over its $${project.budget_usd.toFixed(2)} budget ($${left.toFixed(2)} left, this batch is $${est.totalUsd.toFixed(2)}). Raise the budget or trim the batch.`, 'over_budget');
    }
  }

  // Resolve every start frame first so a missing one fails the whole request before anything is queued.
  const prepared = await Promise.all(chosen.map(async (item) => ({ item, params: await paramsForRun(orgId, item) })));
  const runs: RunDto[] = [];
  for (const { item, params } of prepared) {
    const run = await createRun({
      orgId, kind: 'generation', refId: item.id, createdBy: userId, model: item.model_id,
      refName: `${project.name}: ${item.title}`.slice(0, 120),
      input: { projectId: project.id, itemId: item.id, mode: item.mode, prompt: item.prompt, settings: item.settings, media: params.media },
    });
    await getDb().query(`UPDATE project_items SET status='generating', last_error=NULL, updated_at=now() WHERE id=$1`, [item.id]);
    void generationQueue.enqueue(orgId, run.id, itemWork(orgId, item, params));
    runs.push(run);
  }
  await touchProject(project.id);
  return { runs, totalUsd: est.totalUsd, unpriced: est.unpriced };
}

// ---- project creation helpers ------------------------------------------------------------------------
export function emptyBrief(type: ProjectType): Record<string, string> {
  return Object.fromEntries(PROJECT_TYPES[type].briefFields.map((f) => [f.key, '']));
}

/** Keep only known brief keys, as trimmed strings. */
export function cleanBrief(type: ProjectType, input: Record<string, unknown>): Record<string, string> {
  const allowed = new Set(PROJECT_TYPES[type].briefFields.map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) throw badRequest(`Unknown brief field "${k}". Fields: ${[...allowed].join(', ')}`);
    if (typeof v !== 'string') throw badRequest(`Brief field "${k}" must be text`);
    if (v.length > 6000) throw badRequest(`Brief field "${k}" is too long (6000 characters max)`);
    out[k] = v.trim();
  }
  return out;
}
