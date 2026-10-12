import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getDb } from '../ctx';
import { HttpError } from '../lib/errors';
import { calcCostUsd, getModel } from '../lib/pricing';
import { PROJECT_TYPES } from './projectTypes';
import {
  addItems, ASSET_KINDS, cleanBrief, estimateItems, expandVariants, itemCreate, itemUpdate, loadItems, loadProject, projectSpend,
  touchProject, updateItem, type ItemRow, type ProjectRow,
} from './projects';
import { getSecret } from './secrets';
import { getDefaults } from './settings';
import { LIST_PRICES, STUDIO_MODELS, getStudioModel, PRICES_AS_OF, type ParamSpec, type StudioModel } from './studioCatalog';
import { recordUsage } from './usage';
import { definitionSchema, NODE_REFERENCE, validateWorkflow } from './workflowEngine';

const MAX_ROUNDS = 8;
const MAX_OUTPUT_TOKENS = 8000;
const HISTORY_LIMIT = 60;
const RESULT_LIMIT = 14_000;

export interface Changed {
  board: boolean;
  brief: boolean;
  workflows: boolean;
  assets: boolean;
}

interface ToolCtx {
  orgId: string;
  userId: string;
  projectId: string;
  changed: Changed;
}

// ---- tools -------------------------------------------------------------------------------------------
type Schema = Record<string, unknown>;
const str = (description: string): Schema => ({ type: 'string', description });
const strs = (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description });

const ITEM_PROPS: Record<string, Schema> = {
  group: str('Scene (drama) or concept (ad) this belongs to, e.g. "Ep 1 · Scene 2" or "Concept A: Morning ritual".'),
  title: str('Short label for the card.'),
  prompt: str('The full generation prompt, self-contained. For video models describe the motion.'),
  notes: str('Dialogue, voiceover, hook line, captions, director notes. Not sent to the model.'),
  modelId: str('A Studio model id from list_models. Leave empty only while still planning.'),
  mode: str('Mode id for that model (text-to-video, image-to-video...). Leave empty to let the server pick from the media provided.'),
  settings: { type: 'object', description: 'Model settings by key, exactly as list_models(model_id) shows them (duration, aspect_ratio, resolution, custom_reference_id...).' },
  media: { type: 'object', description: 'Input media by role: {start:[url], end:[url], reference:[url...], video:[url], audio:[url]}. Only public https URLs the user has given you.' },
  meta: { type: 'object', description: 'Free-form: {startFromItemId: "<id of an image item whose approved frame becomes this video\'s start frame>", count: 1-4 takes, platform, hook}.' },
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_models',
    description:
      'List the Higgsfield Studio models you can use. Without arguments: a compact overview (id, what it is for, modes, media inputs, list price). With model_id: that model\'s full settings per mode. Call this before choosing a model; never guess ids or setting names.',
    input_schema: { type: 'object', properties: { surface: { type: 'string', enum: ['image', 'video'] }, model_id: str('Show the full settings for this model.') } },
  },
  { name: 'get_project', description: 'Current brief, reference assets, and every board item with status and cost estimate. Use it to re-check state after changes.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'update_brief',
    description: 'Write or revise the project brief (story bible / brand kit). Only the fields you pass change; send the complete new text for each field you touch.',
    input_schema: { type: 'object', properties: { fields: { type: 'object', description: 'Field key -> full text. Keys are listed in the project context.' } }, required: ['fields'] },
  },
  {
    name: 'add_items',
    description: 'Add cards to the board (shots or ad units). All are validated against the model catalog first; if any is invalid nothing is added and you get the reason. Max 40 per call.',
    input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: ITEM_PROPS, required: ['title'] } } }, required: ['items'] },
  },
  {
    name: 'update_item',
    description: 'Change one card. Pass only the fields to change. Cannot approve or generate: only the user can.',
    input_schema: { type: 'object', properties: { id: str('Item id.'), fields: { type: 'object', properties: { ...ITEM_PROPS, status: { type: 'string', enum: ['draft'] } } } }, required: ['id', 'fields'] },
  },
  { name: 'delete_items', description: 'Delete cards by id (not ones that are generating).', input_schema: { type: 'object', properties: { ids: strs('Item ids.') }, required: ['ids'] } },
  {
    name: 'estimate_cost',
    description: 'Exact cost of generating cards, from Higgsfield list prices and each card\'s duration/resolution. Omit ids for every card that has not been approved yet.',
    input_schema: { type: 'object', properties: { ids: strs('Item ids.') } },
  },
  {
    name: 'request_approval',
    description:
      'Mark cards "ready" and show the user an approval banner with the total cost. This does NOT generate anything: the user reviews the cost and presses Generate themselves. Use it when a set of cards is complete.',
    input_schema: { type: 'object', properties: { ids: strs('Item ids.') }, required: ['ids'] },
  },
  {
    name: 'expand_variants',
    description:
      'Ad campaigns: make a hooks x formats matrix from one base unit. Creates one card per combination and returns the total cost. In the base prompt, {{hook}} marks where the hook goes (else it is appended).',
    input_schema: {
      type: 'object',
      properties: { baseItemId: str('Base unit id (must have a model).'), hooks: strs('Hook lines. Optional.'), aspects: strs('Aspect ratios like "9:16", "1:1". Optional.') },
      required: ['baseItemId'],
    },
  },
  {
    name: 'create_workflow',
    description: 'Save a workflow in the visual workflow builder, linked to this project. It is saved as a draft: the user opens, reviews and runs it. Returns validation issues; fix them with another call.',
    input_schema: { type: 'object', properties: { name: str('Workflow name.'), description: str('What it does.'), definition: { type: 'object', description: 'See the workflow reference in the system prompt.' } }, required: ['name', 'definition'] },
  },
  {
    name: 'add_asset',
    description: 'Record a reference the project needs (a character, product, location...) so the user can attach its image or Soul ID. You cannot upload images; give it a clear name and notes.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: [...ASSET_KINDS] }, name: str('Name.'), notes: str('Look, role, anything to keep consistent.') }, required: ['kind', 'name'] },
  },
];

const cap = (s: string) => (s.length > RESULT_LIMIT ? s.slice(0, RESULT_LIMIT) + '\n…[truncated]' : s);
const json = (v: unknown) => cap(JSON.stringify(v));

const specText = (s: ParamSpec): string => {
  switch (s.type) {
    case 'enum': return `${s.values.filter(Boolean).join('|')} (default ${s.default || 'none'})`;
    case 'int': case 'number': return `${s.min}-${s.max} (default ${s.default})`;
    case 'boolean': return `true|false (default ${s.default})`;
    case 'text': return `text up to ${s.maxLength} chars`;
    case 'seed': return `integer ${s.min}-${s.max}, optional`;
    case 'character': return 'Soul ID uuid, optional';
  }
};

const priceText = (path: string) => {
  const p = LIST_PRICES[path];
  if (!p) return 'price unknown';
  const range = p.min === p.max ? `$${p.min}` : `$${p.min}-$${p.max}`;
  return `${range} per ${p.unit}${p.byResolution ? ` (by resolution: ${Object.entries(p.byResolution).map(([k, v]) => `${k} $${v}`).join(', ')})` : ''}${p.promoEnds ? `, promo until ${p.promoEnds}` : ''}`;
};

const modelOverview = (m: StudioModel) => ({
  id: m.id, label: m.label, kind: m.surface, about: m.description,
  modes: m.modes.map((md) => ({
    id: md.id, price: priceText(md.path),
    inputs: md.media.map((i) => `${i.role}${i.required ? ' (required)' : ''} x${i.max}`).join(', ') || 'none (text only)',
  })),
});

const modelDetail = (m: StudioModel) => ({
  ...modelOverview(m), note: m.note ?? null, billing: m.priceUnit === 'second' ? 'per second of video' : 'per image',
  modes: m.modes.map((md) => ({
    id: md.id, label: md.label, price: priceText(md.path), promptRequired: md.promptRequired !== false,
    settings: Object.fromEntries(Object.entries(md.params).filter(([, s]) => s.type !== 'seed').map(([k, s]) => [k, specText(s)])),
    media: md.media.map((i) => ({ role: i.role, label: i.label, required: !!i.required, max: i.max })),
  })),
});

const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });
const estimateIds = z.object({ ids: z.array(z.string().uuid()).max(100).optional() });

function line(i: ItemRow, est?: { ok: boolean; costUsd?: number | null; reason?: string }) {
  const cost = est ? (est.ok ? (est.costUsd === null || est.costUsd === undefined ? 'price unknown' : `$${est.costUsd.toFixed(est.costUsd < 0.1 ? 4 : 2)}`) : `blocked: ${est.reason}`) : '';
  return { id: i.id, group: i.group_name, title: i.title, status: i.status, model: i.model_id || null, mode: i.mode || null, cost, hasPrompt: !!i.prompt.trim() };
}

async function runTool(ctx: ToolCtx, name: string, input: any): Promise<unknown> {
  const { orgId, projectId } = ctx;
  const project = await loadProject(orgId, projectId);
  switch (name) {
    case 'list_models': {
      const a = z.object({ surface: z.enum(['image', 'video']).optional(), model_id: z.string().optional() }).parse(input ?? {});
      if (a.model_id) {
        const m = getStudioModel(a.model_id);
        if (!m) throw new Error(`No model "${a.model_id}". Ids: ${STUDIO_MODELS.map((x) => x.id).join(', ')}`);
        return { pricesAsOf: PRICES_AS_OF, model: modelDetail(m) };
      }
      return { pricesAsOf: PRICES_AS_OF, models: STUDIO_MODELS.filter((m) => !a.surface || m.surface === a.surface).map(modelOverview) };
    }
    case 'get_project': {
      const items = await loadItems(orgId, projectId);
      const est = await estimateItems(orgId, items);
      const byId = new Map(est.estimates.map((e) => [e.itemId, e]));
      const assets = (await getDb().query('SELECT kind, name, notes, url, character_id FROM project_assets WHERE project_id=$1 ORDER BY created_at', [projectId])).rows;
      const spend = await projectSpend(orgId, projectId, items);
      return {
        brief: project.brief, assets: assets.map((a: any) => ({ kind: a.kind, name: a.name, notes: a.notes, hasImage: !!a.url, soulIdCharacterId: a.character_id || null })),
        budgetUsd: project.budget_usd || null, spentUsd: Number(spend.totalUsd.toFixed(4)),
        items: items.map((i) => line(i, byId.get(i.id) as any)), totalEstimateUsd: Number(est.totalUsd.toFixed(4)),
      };
    }
    case 'update_brief': {
      const a = z.object({ fields: z.record(z.string(), z.any()) }).parse(input);
      const clean = cleanBrief(project.type, a.fields);
      if (Object.keys(clean).length === 0) throw new Error('No fields given');
      await getDb().query('UPDATE projects SET brief = brief || $2::jsonb, updated_at=now() WHERE id=$1', [projectId, JSON.stringify(clean)]);
      ctx.changed.brief = true;
      return { summary: `Updated ${Object.keys(clean).length} brief field${Object.keys(clean).length > 1 ? 's' : ''}: ${Object.keys(clean).join(', ')}` };
    }
    case 'add_items': {
      const a = z.object({ items: z.array(itemCreate).min(1).max(40) }).parse(input);
      const rows = await addItems(orgId, projectId, a.items, PROJECT_TYPES[project.type].itemKind);
      ctx.changed.board = true;
      const est = await estimateItems(orgId, rows);
      const byId = new Map(est.estimates.map((e) => [e.itemId, e]));
      return { summary: `Added ${rows.length} ${rows.length === 1 ? PROJECT_TYPES[project.type].itemLabel.toLowerCase() : PROJECT_TYPES[project.type].itemLabel.toLowerCase() + 's'}`, items: rows.map((r) => line(r, byId.get(r.id) as any)), totalEstimateUsd: Number(est.totalUsd.toFixed(4)) };
    }
    case 'update_item': {
      const a = z.object({ id: z.string().uuid(), fields: itemUpdate.omit({ approvedAssetId: true }) }).parse(input);
      const row = await updateItem(orgId, projectId, a.id, a.fields);
      ctx.changed.board = true;
      return { summary: `Updated "${row.title}"`, item: line(row) };
    }
    case 'delete_items': {
      const a = idsSchema.parse(input);
      const r = await getDb().query(`DELETE FROM project_items WHERE org_id=$1 AND project_id=$2 AND id = ANY($3::uuid[]) AND status <> 'generating'`, [orgId, projectId, a.ids]);
      await touchProject(projectId);
      ctx.changed.board = true;
      return { summary: `Deleted ${r.rowCount} item${r.rowCount === 1 ? '' : 's'}`, skipped: a.ids.length - r.rowCount };
    }
    case 'estimate_cost': {
      const a = estimateIds.parse(input ?? {});
      const all = await loadItems(orgId, projectId);
      const chosen = a.ids ? all.filter((i) => a.ids!.includes(i.id)) : all.filter((i) => i.status !== 'approved' && i.model_id);
      const est = await estimateItems(orgId, chosen);
      const byId = new Map(est.estimates.map((e) => [e.itemId, e]));
      const spend = await projectSpend(orgId, projectId, all);
      return {
        totalUsd: Number(est.totalUsd.toFixed(4)), items: chosen.map((i) => line(i, byId.get(i.id) as any)), unpricedItemIds: est.unpriced,
        budgetUsd: project.budget_usd || null, spentUsd: Number(spend.totalUsd.toFixed(4)), budgetLeftUsd: project.budget_usd > 0 ? Number(Math.max(0, project.budget_usd - spend.totalUsd).toFixed(4)) : null,
        pricesAsOf: PRICES_AS_OF,
      };
    }
    case 'request_approval': {
      const a = idsSchema.parse(input);
      const all = await loadItems(orgId, projectId);
      const chosen = all.filter((i) => a.ids.includes(i.id));
      const est = await estimateItems(orgId, chosen);
      const blocked = new Set(est.blocked.map((b) => b.itemId));
      const ok = chosen.filter((i) => !blocked.has(i.id) && ['draft', 'rejected', 'review'].includes(i.status));
      if (ok.length) await getDb().query(`UPDATE project_items SET status='ready', updated_at=now() WHERE org_id=$1 AND id = ANY($2::uuid[])`, [orgId, ok.map((i) => i.id)]);
      await touchProject(projectId);
      ctx.changed.board = true;
      return {
        summary: `${ok.length} item${ok.length === 1 ? '' : 's'} ready for your approval`, markedReady: ok.length,
        totalUsd: Number(est.totalUsd.toFixed(4)), blocked: est.blocked,
        note: 'Nothing has been generated. The user reviews the cost and presses Generate.',
      };
    }
    case 'expand_variants': {
      const a = z.object({ baseItemId: z.string().uuid(), hooks: z.array(z.string().max(300)).max(20).default([]), aspects: z.array(z.string().max(10)).max(6).default([]) }).parse(input);
      const r = await expandVariants(orgId, project, a.baseItemId, a.hooks, a.aspects, { create: true });
      ctx.changed.board = true;
      return { summary: `Created ${r.count} variants`, count: r.count, totalUsd: Number(r.totalUsd.toFixed(4)), items: r.created.map((i) => ({ id: i.id, title: i.title })) };
    }
    case 'create_workflow': {
      const a = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).default(''), definition: definitionSchema }).parse(input);
      const issues = validateWorkflow(a.definition);
      const { rows } = await getDb().query<{ id: string }>(
        `INSERT INTO workflows (org_id, project_id, name, description, definition, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
        [orgId, projectId, a.name, a.description, JSON.stringify(a.definition), ctx.userId],
      );
      ctx.changed.workflows = true;
      return { summary: `Saved workflow "${a.name}"`, workflowId: rows[0].id, issues, note: issues.some((i) => i.level === 'error') ? 'It has errors: fix them with another create_workflow call (this one stays as a draft).' : 'Saved as a draft for the user to review.' };
    }
    case 'add_asset': {
      const a = z.object({ kind: z.enum(ASSET_KINDS), name: z.string().trim().min(1).max(80), notes: z.string().max(1000).default('') }).parse(input);
      await getDb().query(`INSERT INTO project_assets (org_id, project_id, kind, name, notes) VALUES ($1,$2,$3,$4,$5)`, [orgId, projectId, a.kind, a.name, a.notes]);
      ctx.changed.assets = true;
      return { summary: `Added ${a.kind} "${a.name}"`, note: 'The user can attach an image or Soul ID to it.' };
    }
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}

// ---- system prompt -----------------------------------------------------------------------------------
const STATIC_PROMPT = `You are the Director: a creative producer inside a content studio that makes short video and images with Higgsfield. You work with one person on one project at a time.

How you work
- Be a collaborator, not a form. Ask a few sharp questions only when you truly need the answer; otherwise propose something concrete and let the person react. Keep replies short and plain; no filler.
- You can edit the project directly with your tools: write the brief, add and revise cards on the board, build workflows. Do the work, then say in a sentence or two what you changed.
- You can NEVER spend money on generation. Generation happens only when the person presses Generate and confirms the cost. When a set of cards is ready, call request_approval and tell them the total. Always state costs when you plan more than a couple of cards, using estimate_cost, never your own arithmetic.
- Choose models with list_models and use only ids, modes and setting values it shows. Match the model to the job: cheap models for drafts and keyframes, premium ones for hero shots. Mention the cost trade-off in one line when you pick.
- Never invent facts about the person's brand, product or story. If the brief is missing something important, ask or note it.
- The board is the source of truth. Don't paste long lists of cards into chat; summarise.
- Prompts for image and video models should be concrete and visual: subject, action, setting, camera, light, mood. No on-screen text unless asked.
- Reference media: only use image URLs the person has provided. You can't upload files.

${NODE_REFERENCE}`;

async function contextPrompt(orgId: string, project: ProjectRow): Promise<string> {
  const def = PROJECT_TYPES[project.type];
  const items = await loadItems(orgId, project.id);
  const est = await estimateItems(orgId, items);
  const byId = new Map(est.estimates.map((e) => [e.itemId, e]));
  const assets = (await getDb().query('SELECT kind, name, notes, url, character_id FROM project_assets WHERE project_id=$1 ORDER BY created_at', [project.id])).rows;
  const spend = await projectSpend(orgId, project.id, items);
  const briefLines = def.briefFields.map((f) => `- ${f.key} (${f.label}): ${project.brief?.[f.key]?.trim() || '(empty)'}`);
  const itemLines = items.slice(0, 80).map((i) => {
    const l = line(i, byId.get(i.id) as any);
    return `- ${l.id} | ${l.group || 'no group'} | ${l.title} | ${l.status} | ${l.model ?? 'no model'} | ${l.cost || '-'}`;
  });
  return [
    `PROJECT: "${project.name}"  type: ${def.label}  default aspect: ${project.aspect}  budget: ${project.budget_usd > 0 ? `$${project.budget_usd.toFixed(2)}` : 'none set'}  spent so far: $${spend.totalUsd.toFixed(2)}`,
    project.description ? `Description: ${project.description}` : '',
    '',
    def.guidance,
    '',
    'BRIEF (use these exact field keys with update_brief):',
    ...briefLines,
    '',
    `REFERENCE ASSETS (${assets.length}):`,
    ...(assets.length ? assets.map((a: any) => `- ${a.kind}: ${a.name}${a.character_id ? ` (Soul ID ${a.character_id}: pass as settings.custom_reference_id on Soul image shots)` : ''}${a.url ? ' [has image]' : ' [no image yet]'}${a.notes ? ` — ${a.notes}` : ''}`) : ['(none)']),
    '',
    `BOARD (${items.length} ${def.itemLabel.toLowerCase()}${items.length === 1 ? '' : 's'}${items.length > 80 ? ', first 80 shown' : ''}): id | group | title | status | model | est. cost`,
    ...(itemLines.length ? itemLines : ['(empty)']),
  ].filter((l) => l !== undefined).join('\n');
}

// ---- conversation ------------------------------------------------------------------------------------
export interface ChatBlock {
  type: 'text' | 'tool';
  text?: string;
  name?: string;
  summary?: string;
  error?: boolean;
}
export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  costUsd: number;
  createdAt: string;
}

type StoredBlock = { type: string; [k: string]: any };
interface MsgRow {
  id: string | number;
  role: 'user' | 'assistant';
  content: StoredBlock[];
  cost_usd: number;
  created_at: Date;
}

/** Turns stored Anthropic messages into what the UI shows: text, plus one chip per tool call. Tool results and raw tool traffic are hidden. */
export function toDtos(rows: MsgRow[]): ChatMessageDto[] {
  const results = new Map<string, { text: string; error: boolean }>();
  for (const r of rows) {
    if (r.role !== 'user' || !Array.isArray(r.content)) continue;
    for (const b of r.content) if (b.type === 'tool_result') results.set(b.tool_use_id, { text: typeof b.content === 'string' ? b.content : '', error: !!b.is_error });
  }
  const out: ChatMessageDto[] = [];
  for (const r of rows) {
    const blocks: ChatBlock[] = [];
    for (const b of Array.isArray(r.content) ? r.content : []) {
      if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
      if (b.type === 'tool_use') {
        const res = results.get(b.id);
        let summary = '';
        if (res) {
          if (res.error) summary = res.text.slice(0, 200);
          else {
            try { summary = String(JSON.parse(res.text).summary ?? ''); } catch { summary = ''; }
          }
        }
        blocks.push({ type: 'tool', name: b.name, summary: summary || b.name.replace(/_/g, ' '), error: res?.error ?? false });
      }
    }
    if (blocks.length) out.push({ id: String(r.id), role: r.role, blocks, costUsd: r.cost_usd, createdAt: new Date(r.created_at).toISOString() });
  }
  return out;
}

async function threadId(orgId: string, projectId: string, userId: string): Promise<string> {
  const db = getDb();
  await db.query(`INSERT INTO chat_threads (org_id, project_id, created_by) VALUES ($1,$2,$3) ON CONFLICT (project_id) DO NOTHING`, [orgId, projectId, userId]);
  return (await db.query<{ id: string }>('SELECT id FROM chat_threads WHERE project_id=$1', [projectId])).rows[0].id;
}

export async function loadMessages(orgId: string, projectId: string): Promise<MsgRow[]> {
  const { rows } = await getDb().query<MsgRow>(
    `SELECT m.id, m.role, m.content, m.cost_usd, m.created_at FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
     WHERE t.project_id=$1 AND t.org_id=$2 ORDER BY m.id`,
    [projectId, orgId],
  );
  return rows;
}

export async function clearChat(orgId: string, projectId: string): Promise<void> {
  await getDb().query('DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE project_id=$1 AND org_id=$2)', [projectId, orgId]);
}

/**
 * Prepares stored history for the API: starts at a plain user message and never contains a tool_use without
 * its matching tool_result (e.g. after a crash mid-turn), which the API would reject.
 */
export function historyForApi(rows: MsgRow[]): Anthropic.MessageParam[] {
  let list = rows.slice(-HISTORY_LIMIT);
  const startsClean = (r: MsgRow) => r.role === 'user' && Array.isArray(r.content) && !r.content.some((b) => b.type === 'tool_result');
  const first = list.findIndex(startsClean);
  list = first === -1 ? [] : list.slice(first);
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const uses = r.role === 'assistant' ? r.content.filter((b) => b.type === 'tool_use').map((b) => b.id as string) : [];
    if (uses.length) {
      const next = list[i + 1];
      const answered = new Set(next?.role === 'user' ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id as string) : []);
      if (!uses.every((u) => answered.has(u))) break;
    }
    out.push({ role: r.role, content: r.content as Anthropic.MessageParam['content'] });
  }
  return out;
}

async function saveMessage(orgId: string, thread: string, role: 'user' | 'assistant', content: StoredBlock[], model: string | null, costUsd: number): Promise<void> {
  await getDb().query(`INSERT INTO chat_messages (thread_id, org_id, role, content, model, cost_usd) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`, [thread, orgId, role, JSON.stringify(content), model, costUsd]);
}

/** Cost with prompt-cache pricing: reads are 0.1x and writes 1.25x the input rate. */
function costOf(model: string, u: Anthropic.Usage): number {
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  return calcCostUsd(model, Math.round(input), u.output_tokens);
}

export interface TurnResult {
  messages: ChatMessageDto[];
  changed: Changed;
  costUsd: number;
  simulated: boolean;
}

export async function directorTurn(orgId: string, userId: string, projectId: string, text: string, requestedModel?: string): Promise<TurnResult> {
  const project = await loadProject(orgId, projectId);
  const thread = await threadId(orgId, projectId, userId);
  const model = getModel(requestedModel ?? (await getDefaults(orgId)).model) ?? getModel('claude-sonnet-5-5')!;
  const before = (await getDb().query<{ n: string }>('SELECT COALESCE(MAX(id),0) AS n FROM chat_messages WHERE thread_id=$1', [thread])).rows[0].n;
  const changed: Changed = { board: false, brief: false, workflows: false, assets: false };
  const prior = historyForApi(await loadMessages(orgId, projectId));
  await saveMessage(orgId, thread, 'user', [{ type: 'text', text }], null, 0);

  const apiKey = await getSecret(orgId, 'anthropic');
  let costUsd = 0;
  if (!apiKey) {
    const reply = `[SIMULATED — no Anthropic API key is set. Add one in Settings → API keys and I can plan this with you.]\n\nYou said: "${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"`;
    await saveMessage(orgId, thread, 'assistant', [{ type: 'text', text: reply }], model.id, 0);
    return { messages: await sinceId(orgId, projectId, before), changed, costUsd: 0, simulated: true };
  }

  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const ctx: ToolCtx = { orgId, userId, projectId, changed };
  const messages: Anthropic.MessageParam[] = [...prior, { role: 'user', content: [{ type: 'text', text }] }];
  const dynamic = await contextPrompt(orgId, project);

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await client.messages.create({
        model: model.id,
        max_tokens: Math.min(MAX_OUTPUT_TOKENS, model.maxOutputTokens),
        // The long, stable instructions + tool list are cached; only the project snapshot changes between turns.
        system: [{ type: 'text', text: STATIC_PROMPT, cache_control: { type: 'ephemeral' } }, { type: 'text', text: dynamic }],
        tools: TOOLS,
        messages,
      });
      const cost = costOf(model.id, res.usage);
      costUsd += cost;
      await recordUsage({ orgId, provider: 'claude', model: model.id, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, costUsd: cost, simulated: false });

      const content: StoredBlock[] = res.content
        .filter((b) => b.type === 'text' || b.type === 'tool_use')
        .map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: (b as Anthropic.ToolUseBlock).id, name: (b as Anthropic.ToolUseBlock).name, input: (b as Anthropic.ToolUseBlock).input }));
      if (res.stop_reason === 'refusal') content.push({ type: 'text', text: 'I can’t help with that request.' });
      if (res.stop_reason === 'max_tokens' && !content.some((b) => b.type === 'text')) content.push({ type: 'text', text: 'That reply got too long and was cut off. Try asking for a smaller piece at a time.' });
      const toolUses = res.stop_reason === 'tool_use' || res.stop_reason === 'max_tokens' ? content.filter((b) => b.type === 'tool_use') : [];
      // A tool call cut off by the token limit may carry partial input, so it is never run.
      const truncated = res.stop_reason === 'max_tokens';
      if (truncated) for (let i = content.length - 1; i >= 0; i--) if (content[i].type === 'tool_use') content.splice(i, 1);
      if (content.length === 0) content.push({ type: 'text', text: '…' });
      await saveMessage(orgId, thread, 'assistant', content, model.id, cost);
      messages.push({ role: 'assistant', content: content as Anthropic.MessageParam['content'] });

      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      const results: StoredBlock[] = [];
      for (const tu of toolUses) {
        try {
          const out = await runTool(ctx, tu.name, tu.input);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: json(out) });
        } catch (e) {
          const msg = e instanceof z.ZodError ? `Invalid input: ${e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}` : e instanceof Error ? e.message : String(e);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: cap(msg), is_error: true });
        }
      }
      await saveMessage(orgId, thread, 'user', results, null, 0);
      messages.push({ role: 'user', content: results as Anthropic.MessageParam['content'] });
      if (round === MAX_ROUNDS - 1) await saveMessage(orgId, thread, 'assistant', [{ type: 'text', text: 'I made a lot of changes in one go, so I’m pausing here. Check the board, then tell me what to continue with.' }], model.id, 0);
    }
  } catch (e) {
    // Keep whatever was saved so far; report the failure as part of the conversation so it isn't lost.
    const msg = e instanceof Anthropic.APIError ? `The Claude API returned an error (${e.status ?? 'network'}): ${e.message}` : e instanceof Error ? e.message : String(e);
    await saveMessage(orgId, thread, 'assistant', [{ type: 'text', text: `Something went wrong: ${msg}` }], model.id, 0);
    if (e instanceof HttpError) throw e;
  }
  return { messages: await sinceId(orgId, projectId, before), changed, costUsd, simulated: false };
}

async function sinceId(orgId: string, projectId: string, afterId: string | number): Promise<ChatMessageDto[]> {
  const rows = await loadMessages(orgId, projectId);
  // Tool results for a visible tool chip may sit in a later row, so build DTOs from everything and then cut.
  return toDtos(rows).filter((m) => Number(m.id) > Number(afterId));
}
