import { z } from 'zod';
import { getDb } from '../ctx';
import { getModel } from '../lib/pricing';
import { placeholderImage } from '../lib/placeholder';
import { render, stringify } from '../lib/template';
import { createAlert } from './alerts';
import { runPrompt } from './claude';
import type { Work } from './jobs';
import { getDefaults } from './settings';
import { runStudioGeneration } from './studio';
import { getStudioModel } from './studioCatalog';
import { runTransform, type TransformConfig } from './transform';
import { recordUsage } from './usage';

export const NODE_TYPES = ['trigger', 'llm', 'generate', 'transform', 'action', 'output'] as const;
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
- trigger: {label, source:'manual'|'schedule'|'higgsfield', sampleInput?, intervalMinutes? (schedule)}
- llm: {label, model (a Claude model id), systemPrompt?, userPrompt (required), maxTokens?}
- generate: {label, model (a Studio model id from list_models), prompt (required), settings?:{...mode settings}, startUrl?, endUrl?, count? (1-4)}  -- this SPENDS money when the workflow runs
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
}

/** Build the unit of work the job queue will run for one workflow execution. */
export function workflowWork(orgId: string, wf: WorkflowRecord, runInput: Record<string, unknown>): Work {
  return async ({ runId, log }) => {
    const def = wf.definition;
    const issues = validateWorkflow(def).filter((i) => i.level === 'error');
    if (issues.length) throw new Error(`Workflow is invalid: ${issues.map((i) => i.message).join('; ')}`);

    const defaults = await getDefaults(orgId);
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
      };
      await log('info', `▶ ${label} (${node.type})`, id);
      const t0 = Date.now();
      let out: unknown;

      switch (node.type) {
        case 'trigger': {
          const source = node.data.source ?? 'manual';
          if (source === 'higgsfield') {
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
