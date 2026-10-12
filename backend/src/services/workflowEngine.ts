import { z } from 'zod';
import { getDb } from '../ctx';
import { getModel } from '../lib/pricing';
import { placeholderImage } from '../lib/placeholder';
import { render, stringify } from '../lib/template';
import { createAlert } from './alerts';
import { runPrompt } from './claude';
import type { Work } from './jobs';
import { getDefaults } from './settings';
import { estimateItem, generateCard, loadItem, paramsForRun, selectCards, type ItemRow } from './projects';
import { getPrices, prepareGeneration, runStudioGeneration } from './studio';
import { billedSeconds, getStudioModel, outputsPerRequest, unitPrice } from './studioCatalog';
import { runTransform, type TransformConfig } from './transform';
import { recordUsage } from './usage';

export const NODE_TYPES = ['trigger', 'llm', 'generate', 'foreach', 'transform', 'action', 'output'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Request-body shape for a workflow definition, shared by the REST routes and the Claude chat tool. */
export const definitionSchema = z.object({
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

/** Plain-language description of every node type, given to the Claude chat so it can build valid workflows. */
export const NODE_REFERENCE = `Workflow definition = {nodes:[{id,type,position:{x,y},data}], edges:[{id,source,target}]}. Exactly one trigger. Data flows along edges; a node's text input is available as {{input}}, run variables as {{vars.name}}, any earlier node's result as {{nodes.<nodeId>.output}}.
Node types and their data fields:
- trigger: {label, source:'manual'|'schedule'|'higgsfield'|'project', sampleInput?, intervalMinutes? (schedule), statuses?:['draft','ready','rejected',...] and group? (project: outputs this project's board cards as a JSON list of {id,title,group,prompt,notes,modelId})}
- llm: {label, model (a Claude model id), systemPrompt?, userPrompt (required), maxTokens?}
- generate: {label, model (a Studio model id from list_models), prompt (required), settings?:{...mode settings}, startUrl?, endUrl?, count? (1-4)}  -- this SPENDS money when the workflow runs
- foreach: {label, mode:'cards'|'prompt', maxItems? (default 20, max 50), concurrency? (1-4, default 2)}  -- takes a LIST as input (a JSON array or one item per line) and runs a generation for each item. SPENDS money per item.
    mode 'cards': the items are board cards (from the project trigger); each is generated with its OWN model, settings and inputs, and the card moves to "review". Use this to render a scene or episode.
    mode 'prompt': also set model (Studio model id), prompt (a template using {{item}}, {{item.field}}, {{index}}), settings?, startUrl? (template). Use this to turn a list written by Claude into many images/clips.
- Project variables are available when the workflow belongs to a project: {{project.name}}, {{project.aspect}}, {{project.brief.visualStyle}}, {{project.brief.characters}}, etc.
- Every workflow that spends money shows its estimated cost and needs the user's confirmation before it runs; scheduled runs of spending workflows are skipped.
- transform: {label, mode:'template'|'json_parse'|'pick'|'regex_extract'|'uppercase'|'lowercase'|'trim'|'split_lines'|'join', template? (template), path? (pick), pattern? (regex_extract), separator? (join)}
- action: {label, action:'save_media'|'notify'|'log', message?, title?, url?, tags?, mediaType?:'photo'|'video'}
- output: {label}  -- the run result
Lay nodes out left to right, about 280px apart.`;

export interface WfNode {
  id: string;
  type: NodeType;
  position?: { x: number; y: number };
  data: Record<string, any>;
}
export interface WfEdge {
  id: string;
  source: string;
  target: string;
}
export interface WorkflowDefinition {
  nodes: WfNode[];
  edges: WfEdge[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

const MAX_FOREACH = 50;

/** Structural validation shared by "save", "activate" and "run". */
export function validateWorkflow(def: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ level: 'error', message, nodeId });
  const warn = (message: string, nodeId?: string) => issues.push({ level: 'warning', message, nodeId });

  const ids = new Set<string>();
  for (const n of def.nodes) {
    if (ids.has(n.id)) err(`Duplicate node id "${n.id}"`, n.id);
    ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) err(`Unknown node type "${n.type}"`, n.id);
  }
  const triggers = def.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) err('Workflow needs a Trigger node');
  if (triggers.length > 1) err('Workflow can only have one Trigger node');
  if (!def.nodes.some((n) => n.type === 'output')) warn('No Output node — the run result will be the last node\'s output');

  for (const e of def.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) err(`Edge ${e.id} references a missing node`);
    if (e.source === e.target) err(`Edge ${e.id} connects a node to itself`, e.source);
  }
  const typeOf = new Map(def.nodes.map((n) => [n.id, n.type]));
  for (const e of def.edges) {
    if (typeOf.get(e.target) === 'trigger') err('Trigger nodes cannot have incoming connections', e.target);
    if (typeOf.get(e.source) === 'output') err('Output nodes cannot have outgoing connections', e.source);
  }

  if (hasCycle(def)) err('Workflow contains a cycle');

  for (const n of def.nodes) {
    if (n.type === 'llm') {
      if (!String(n.data.userPrompt ?? '').trim()) err('LLM node needs a user prompt', n.id);
      if (n.data.model && !getModel(n.data.model)) err(`Unknown model "${n.data.model}"`, n.id);
    }
    if (n.type === 'generate') {
      if (!String(n.data.prompt ?? '').trim()) err('Generate node needs a prompt', n.id);
      if (!n.data.model || !getStudioModel(n.data.model)) err('Generate node needs a valid Studio model', n.id);
    }
    if (n.type === 'foreach') {
      const mode = n.data.mode ?? 'cards';
      if (mode !== 'cards' && mode !== 'prompt') err('For-each mode must be "cards" or "prompt"', n.id);
      if (mode === 'prompt') {
        if (!String(n.data.prompt ?? '').trim()) err('For-each needs a prompt template', n.id);
        if (!n.data.model || !getStudioModel(n.data.model)) err('For-each needs a valid Studio model', n.id);
      }
      if (n.data.maxItems !== undefined && !(Number(n.data.maxItems) >= 1 && Number(n.data.maxItems) <= MAX_FOREACH)) err(`Max items must be between 1 and ${MAX_FOREACH}`, n.id);
      if (!def.edges.some((e) => e.target === n.id)) warn('For-each has no input list connected', n.id);
    }
    if (n.type === 'trigger' && n.data.source === 'project' && n.data.statuses !== undefined && !Array.isArray(n.data.statuses)) err('Project trigger statuses must be a list', n.id);
    if (n.type === 'transform' && n.data.mode === 'regex_extract' && !n.data.pattern) err('Regex transform needs a pattern', n.id);
    if (n.type === 'transform' && n.data.mode === 'pick' && !n.data.path) err('Pick transform needs a path', n.id);
  }

  const trigger = triggers[0];
  if (trigger) {
    const reach = reachable(def, trigger.id);
    for (const n of def.nodes) if (n.id !== trigger.id && !reach.has(n.id)) warn('Node is not connected to the trigger and will not run', n.id);
  }
  return issues;
}

function hasCycle(def: WorkflowDefinition): boolean {
  return topoOrder(def).length < def.nodes.length;
}

/** Kahn's algorithm. Returns nodes in execution order; shorter than input when a cycle exists. */
export function topoOrder(def: WorkflowDefinition): string[] {
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    indeg.set(e.target, indeg.get(e.target)! + 1);
    out.get(e.source)!.push(e.target);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of out.get(id)!) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  return order;
}

function reachable(def: WorkflowDefinition, from: string): Set<string> {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of def.edges) if (e.source === cur && !seen.has(e.target)) (seen.add(e.target), stack.push(e.target));
  }
  return seen;
}

const clip = (v: unknown, n = 20_000) => {
  const s = stringify(v);
  return s.length > n ? s.slice(0, n) + '…[truncated]' : v;
};

export interface WorkflowRecord {
  id: string;
  name: string;
  definition: WorkflowDefinition;
  /** Set when the workflow belongs to a project: unlocks {{project.*}} variables and the project-cards trigger. */
  projectId?: string | null;
}

/** What `{{project.*}}` resolves to inside a project's workflows. */
async function projectVars(orgId: string, projectId: string | null | undefined): Promise<Record<string, unknown> | undefined> {
  if (!projectId) return undefined;
  const { rows } = await getDb().query<{ name: string; type: string; aspect: string; description: string; brief: Record<string, string> }>(
    'SELECT name, type, aspect, description, brief FROM projects WHERE id=$1 AND org_id=$2',
    [projectId, orgId],
  );
  return rows[0] ? { name: rows[0].name, type: rows[0].type, aspect: rows[0].aspect, description: rows[0].description, brief: rows[0].brief ?? {} } : undefined;
}

const stripFences = (s: string) => s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/** A list from a JSON array, or one item per non-empty line; anything else becomes a single item. */
export function toList(input: unknown, max: number): unknown[] {
  let v = input;
  if (typeof v === 'string') {
    const s = v.trim();
    try {
      v = JSON.parse(stripFences(s));
    } catch {
      v = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(v)) v = v === null || v === undefined || v === '' ? [] : [v];
  return (v as unknown[]).slice(0, max);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemId = (item: unknown): string | null => (item && typeof item === 'object' && typeof (item as any).id === 'string' && UUID_RE.test((item as any).id) ? (item as any).id : null);
const clampInt = (v: unknown, lo: number, hi: number, def: number) => Math.min(hi, Math.max(lo, Math.floor(Number(v)) || def));

const cardJson = (c: ItemRow) => ({ id: c.id, title: c.title, group: c.group_name, prompt: c.prompt, notes: c.notes, modelId: c.model_id });

/** Build the unit of work the job queue will run for one workflow execution. */
export function workflowWork(orgId: string, wf: WorkflowRecord, runInput: Record<string, unknown>): Work {
  return async ({ runId, log }) => {
    const def = wf.definition;
    const issues = validateWorkflow(def).filter((i) => i.level === 'error');
    if (issues.length) throw new Error(`Workflow is invalid: ${issues.map((i) => i.message).join('; ')}`);

    const defaults = await getDefaults(orgId);
    const project = await projectVars(orgId, wf.projectId);
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    const outputs = new Map<string, unknown>();
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, simulated: false, model: null as string | null };
    let finalResult: unknown = null;
    let lastOutput: unknown = null;

    const order = topoOrder(def);
    const trigger = def.nodes.find((n) => n.type === 'trigger')!;
    const live = reachableIds(def, trigger.id);

    for (const id of order) {
      if (!live.has(id)) continue;
      const node = byId.get(id)!;
      const label = node.data.label || node.type;
      const incoming = def.edges.filter((e) => e.target === id).map((e) => e.source);
      const input = incoming.length === 0 ? undefined : incoming.length === 1 ? outputs.get(incoming[0]) : Object.fromEntries(incoming.map((s) => [s, outputs.get(s)]));
      const vars: Record<string, unknown> = {
        input,
        vars: runInput,
        nodes: Object.fromEntries([...outputs].map(([k, v]) => [k, { output: v }])),
        ...(project ? { project } : {}),
      };
      await log('info', `▶ ${label} (${node.type})`, id);
      const t0 = Date.now();
      let out: unknown;

      switch (node.type) {
        case 'trigger': {
          const source = node.data.source ?? 'manual';
          if (source === 'project') {
            if (!wf.projectId) throw new Error('A "Project cards" trigger only works in a workflow that belongs to a project.');
            const cards = await selectCards(orgId, wf.projectId, { statuses: node.data.statuses, group: typeof node.data.group === 'string' ? node.data.group : '' });
            await log('info', `Found ${cards.length} card${cards.length === 1 ? '' : 's'} to work on`, id);
            out = JSON.stringify(cards.map(cardJson), null, 2);
          } else if (source === 'higgsfield') {
            // Recent generations made in Studio (our own history; no extra platform call needed).
            const { rows } = await getDb().query(
              `SELECT type, title, url, created_at FROM media_assets WHERE org_id=$1 AND metadata->>'source'='studio' AND url NOT LIKE 'data:%'
               ORDER BY created_at DESC LIMIT 5`,
              [orgId],
            );
            out = JSON.stringify(rows.map((r) => ({ type: r.type, title: r.title, url: r.url, createdAt: new Date(r.created_at).toISOString() })), null, 2);
          } else {
            out = runInput.text ?? runInput.input ?? node.data.sampleInput ?? '';
          }
          break;
        }
        case 'llm': {
          const model = node.data.model || defaults.model;
          const user = render(String(node.data.userPrompt ?? ''), vars);
          const system = render(String(node.data.systemPrompt ?? ''), vars);
          if (user.missing.length) await log('warn', `Unresolved variables: ${user.missing.join(', ')}`, id);
          const r = await runPrompt(orgId, {
            model,
            system: system.text,
            user: user.text,
            temperature: node.data.temperature ?? defaults.temperature,
            maxTokens: Number(node.data.maxTokens) || defaults.maxTokens,
          });
          await recordUsage({ orgId, runId, provider: 'claude', model: r.model, workflowId: wf.id, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, simulated: r.simulated });
          totals.inputTokens += r.inputTokens;
          totals.outputTokens += r.outputTokens;
          totals.costUsd += r.costUsd;
          totals.simulated ||= r.simulated;
          totals.model = r.model;
          if (r.simulated) await log('warn', 'No Anthropic key configured — simulated response', id);
          await log('info', `${r.model}: ${r.inputTokens} in / ${r.outputTokens} out, $${r.costUsd.toFixed(5)}`, id);
          out = r.text;
          break;
        }
        case 'generate': {
          const prompt = render(String(node.data.prompt ?? ''), vars);
          if (prompt.missing.length) await log('warn', `Unresolved variables: ${prompt.missing.join(', ')}`, id);
          const urlOrNone = (v: unknown) => {
            const s = render(String(v ?? ''), vars).text.trim();
            return s ? [s] : undefined;
          };
          const r = await runStudioGeneration(
            orgId,
            { runId, log: (level, msg, nid, data) => log(level, msg, nid ?? id, data) },
            {
              modelId: node.data.model,
              prompt: prompt.text,
              settings: node.data.settings ?? {},
              media: { ...(urlOrNone(node.data.startUrl) ? { start: urlOrNone(node.data.startUrl) } : {}), ...(urlOrNone(node.data.endUrl) ? { end: urlOrNone(node.data.endUrl) } : {}) },
              count: Number(node.data.count) || 1,
              workflowId: wf.id,
            },
          );
          totals.costUsd += r.costUsd;
          totals.simulated ||= r.simulated;
          out = { assets: r.assets.map((a) => ({ id: a.id, type: a.type, url: a.url })), failures: r.failures };
          break;
        }
        case 'foreach': {
          const r = await runForeach(orgId, wf, runId, node, input, vars, log);
          totals.costUsd += r.costUsd;
          totals.simulated ||= r.simulated;
          out = { items: r.items, assets: r.assets, failures: r.failures };
          break;
        }
        case 'transform':
          out = runTransform(node.data as TransformConfig, input, vars);
          break;
        case 'action':
          out = await runAction(orgId, wf, runId, node, input, vars, log);
          break;
        case 'output':
          out = input;
          finalResult = input;
          break;
      }
      outputs.set(id, out);
      lastOutput = out;
      await log('info', `✓ ${label} done in ${Date.now() - t0}ms`, id);
    }

    return {
      output: { result: finalResult ?? lastOutput, nodes: Object.fromEntries([...outputs].map(([k, v]) => [k, clip(v)])) },
      model: totals.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
      simulated: totals.simulated,
    };
  };
}

/**
 * Runs one generation per list item (a few at a time), carrying on past individual failures.
 * 'cards': each item is a board card, generated with its own settings and its status kept up to date.
 * 'prompt': each item fills a prompt template and is generated with this node's model.
 */
async function runForeach(orgId: string, wf: WorkflowRecord, runId: string, node: WfNode, input: unknown, vars: Record<string, unknown>, log: Logger) {
  const mode = node.data.mode ?? 'cards';
  const max = clampInt(node.data.maxItems, 1, MAX_FOREACH, 20);
  const conc = clampInt(node.data.concurrency, 1, 4, 2);
  const list = toList(input, max);
  if (list.length === 0) throw new Error('For-each got an empty list, so there is nothing to generate.');
  const total = Array.isArray(input) ? input.length : list.length;
  if (total > max) await log('warn', `Only the first ${max} items will be processed`, node.id);
  await log('info', `For each of ${list.length} item${list.length > 1 ? 's' : ''} (${mode}, ${conc} at a time)`, node.id);

  const res = { items: list.length, assets: [] as { id: string; type: string; url: string; item: number }[], failures: [] as string[], costUsd: 0, simulated: false };
  const one = async (item: unknown, index: number) => {
    const ctx = { runId, log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, nid?: string, data?: unknown) => log(level, `[${index + 1}/${list.length}] ${msg}`, nid ?? node.id, data) };
    let r;
    if (mode === 'cards') {
      const cid = itemId(item);
      if (!cid || !wf.projectId) throw new Error('item is not a board card (it needs an id)');
      const card = await loadItem(orgId, wf.projectId, cid);
      if (card.status === 'generating') throw new Error(`"${card.title}" is already generating`);
      if (!card.model_id) throw new Error(`"${card.title}" has no model yet`);
      await getDb().query(`UPDATE project_items SET status='generating', last_error=NULL, updated_at=now() WHERE id=$1`, [card.id]);
      try {
        r = await generateCard(orgId, card, await paramsForRun(orgId, card), ctx);
      } catch (e) {
        // paramsForRun can fail before generateCard has a chance to reset the card.
        await getDb().query(`UPDATE project_items SET status='draft', last_error=$2, updated_at=now() WHERE id=$1 AND status='generating'`, [card.id, e instanceof Error ? e.message.slice(0, 500) : 'Failed']);
        throw e;
      }
    } else {
      const itemVars = { ...vars, item, index };
      const prompt = render(String(node.data.prompt ?? ''), itemVars);
      const start = render(String(node.data.startUrl ?? ''), itemVars).text.trim();
      // If the item names one of this project's cards (e.g. Claude returned the card ids back), file the results under that card.
      const claimed = wf.projectId ? itemId(item) : null;
      const cid = claimed && (await getDb().query('SELECT 1 FROM project_items WHERE id=$1 AND project_id=$2 AND org_id=$3', [claimed, wf.projectId, orgId])).rows.length > 0 ? claimed : null;
      r = await runStudioGeneration(orgId, ctx, {
        modelId: node.data.model, prompt: prompt.text, settings: node.data.settings ?? {}, media: start ? { start: [start] } : {}, count: Number(node.data.count) || 1, workflowId: wf.id,
        metadata: wf.projectId && cid ? { projectId: wf.projectId, itemId: cid } : undefined,
      });
      if (cid) await getDb().query(`UPDATE project_items SET status='review', updated_at=now() WHERE id=$1 AND status IN ('draft','ready','rejected')`, [cid]);
    }
    res.costUsd += r.costUsd;
    res.simulated ||= r.simulated;
    for (const a of r.assets) res.assets.push({ id: a.id, type: a.type, url: a.url, item: index });
    res.failures.push(...r.failures);
  };

  for (let i = 0; i < list.length; i += conc) {
    const batch = list.slice(i, i + conc);
    const settled = await Promise.allSettled(batch.map((item, k) => one(item, i + k)));
    for (const [k, s] of settled.entries()) {
      if (s.status === 'rejected') {
        const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
        res.failures.push(`Item ${i + k + 1}: ${msg}`);
        await log('error', `Item ${i + k + 1} failed: ${msg}`, node.id);
      }
    }
  }
  if (res.assets.length === 0) throw new Error(`Nothing was generated. ${res.failures[0] ?? ''}`.trim());
  await log('info', `For-each finished: ${res.assets.length} output${res.assets.length > 1 ? 's' : ''}, ${res.failures.length} failure${res.failures.length === 1 ? '' : 's'}, $${res.costUsd.toFixed(4)}`, node.id);
  return res;
}

// ---- cost estimate (used before a run is confirmed) ------------------------------------------------
export interface WorkflowEstimate {
  totalUsd: number;
  /** True when the number of items isn't known up front, so the total is a ceiling (maxItems). */
  upTo: boolean;
  /** Steps that spend money. Empty = the workflow is free to run (apart from Claude tokens). */
  steps: { nodeId: string; label: string; items: number; costUsd: number | null; note?: string }[];
  unpriced: boolean;
  problems: string[];
}

/**
 * What a run would cost on Higgsfield, from list prices (or the org's overrides), without running anything.
 * Claude token costs are small and not included here.
 */
export async function estimateWorkflow(orgId: string, wf: WorkflowRecord): Promise<WorkflowEstimate> {
  const est: WorkflowEstimate = { totalUsd: 0, upTo: false, steps: [], unpriced: false, problems: [] };
  const prices = await getPrices(orgId);
  const trigger = wf.definition.nodes.find((n) => n.type === 'trigger');
  const fromProject = trigger?.data.source === 'project' && !!wf.projectId;

  const perItem = (n: WfNode, count = 1) => {
    const start = String(n.data.startUrl ?? '').trim();
    const end = String(n.data.endUrl ?? '').trim();
    // Templates can't be resolved yet, so any non-empty value stands in for a real URL when choosing the mode.
    const p = prepareGeneration({
      modelId: n.data.model, prompt: String(n.data.prompt ?? '') || 'draft', settings: n.data.settings ?? {}, count,
      media: { ...(start ? { start: ['https://pending.invalid/a.png'] } : {}), ...(end ? { end: ['https://pending.invalid/b.png'] } : {}) },
    });
    const unit = unitPrice(p.mode, p.settings, prices[p.model.id] ?? null);
    const outputs = p.requests * outputsPerRequest(p.settings);
    return unit ? unit.amount * billedSeconds(p.model, p.mode, p.settings) * outputs : null;
  };
  const add = (nodeId: string, label: string, items: number, cost: number | null, note?: string) => {
    est.steps.push({ nodeId, label, items, costUsd: cost, note });
    if (cost === null) est.unpriced = true;
    else est.totalUsd += cost;
  };

  for (const n of wf.definition.nodes) {
    const label = String(n.data.label || n.type);
    try {
      if (n.type === 'generate') add(n.id, label, 1, perItem(n, clampInt(n.data.count, 1, 4, 1)));
      if (n.type === 'foreach') {
        const mode = n.data.mode ?? 'cards';
        const max = clampInt(n.data.maxItems, 1, MAX_FOREACH, 20);
        if (mode === 'cards') {
          if (!wf.projectId) {
            est.problems.push(`${label}: card rendering needs a workflow that belongs to a project`);
            continue;
          }
          const cards = await selectCards(orgId, wf.projectId, { statuses: fromProject ? trigger!.data.statuses : undefined, group: fromProject ? String(trigger!.data.group ?? '') : '', limit: max });
          const prices2 = cards.map((c) => estimateItem(c, prices));
          const bad = prices2.filter((e) => !e.ok);
          if (bad.length) est.problems.push(`${label}: ${bad.length} card${bad.length > 1 ? 's' : ''} can't be generated yet (${(bad[0] as { reason: string }).reason})`);
          const known = prices2.filter((e) => e.ok);
          add(n.id, label, known.length, known.some((e) => e.ok && e.costUsd === null) ? null : known.reduce((s, e) => s + (e.ok ? (e.costUsd ?? 0) : 0), 0), 'cards currently matching the trigger');
        } else {
          const items = fromProject ? (await selectCards(orgId, wf.projectId!, { statuses: trigger!.data.statuses, group: String(trigger!.data.group ?? ''), limit: max })).length : max;
          if (!fromProject) est.upTo = true;
          const each = perItem(n, clampInt(n.data.count, 1, 4, 1));
          add(n.id, label, items, each === null ? null : each * items, fromProject ? undefined : `up to ${max} items`);
        }
      }
    } catch (e) {
      est.problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return est;
}

function reachableIds(def: WorkflowDefinition, from: string): Set<string> {
  return reachable(def, from);
}

type Logger = Parameters<Work>[0]['log'];

async function runAction(orgId: string, wf: WorkflowRecord, runId: string, node: WfNode, input: unknown, vars: Record<string, unknown>, log: Logger): Promise<unknown> {
  const action = node.data.action ?? 'log';
  const message = render(String(node.data.message ?? '{{input}}'), vars).text;
  switch (action) {
    case 'save_media': {
      const type: 'photo' | 'video' = node.data.mediaType === 'video' ? 'video' : 'photo';
      const title = render(String(node.data.title ?? `${wf.name} output`), vars).text.slice(0, 200) || `${wf.name} output`;
      const urlRaw = render(String(node.data.url ?? ''), vars).text.trim();
      if (urlRaw && !/^https?:\/\//i.test(urlRaw)) throw new Error('save_media: url must be an http(s) URL');
      const tags = String(node.data.tags ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const thumb = placeholderImage(title, type, runId);
      const { rows } = await getDb().query<{ id: string }>(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata, workflow_id, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
        [orgId, type, title, urlRaw || thumb, thumb, tags, JSON.stringify({ source: 'workflow', note: stringify(input).slice(0, 500), placeholder: !urlRaw }), wf.id, runId],
      );
      await log('info', `Saved media asset "${title}"${urlRaw ? '' : ' (placeholder — no URL provided)'}`, node.id);
      return { mediaId: rows[0].id };
    }
    case 'notify':
      await createAlert(orgId, { kind: 'workflow_notice', severity: 'info', message: `${wf.name}: ${message.slice(0, 300)}` });
      await log('info', 'Notification sent to the team', node.id);
      return { notified: true };
    case 'log':
      await log('info', message.slice(0, 1000), node.id);
      return { logged: true };
    default:
      throw new Error(`Unknown action "${String(action)}"`);
  }
}
