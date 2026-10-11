import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';

let db: Db;
let server: http.Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

async function call(method: string, path: string, opts: { as?: string; body?: unknown; raw?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.as) headers.authorization = `Bearer ${tokens[opts.as]}`;
  const res = await fetch(base + '/api' + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  if (opts.raw) return res;
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

beforeAll(async () => {
  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await call('GET', '/dev/users')).json as { id: string; role: string; token: string }[];
  for (const u of users) { tokens[u.role] = u.token; ids[u.role] = u.id; }
}, 60_000);

afterAll(async () => {
  server.close();
  await db.close();
});

describe('auth & RBAC', () => {
  it('health is public and reports the db', async () => {
    const r = await call('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ok');
  });
  it('allows same-origin and allow-listed browser origins on POST but rejects foreign ones (CORS)', async () => {
    const post = (origin: string) =>
      fetch(base + '/api/prompts/run', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.user}`, origin }, body: JSON.stringify({ user: 'cors check', model: 'claude-haiku-5-5', maxTokens: 20 }) });
    expect((await post('http://127.0.0.1:5173')).status).toBe(200); // dev allow-list (regression: this used to be blocked)
    expect((await post(base)).status).toBe(200); // same-origin
    expect((await post('https://evil.example')).status).toBe(403);
  });
  it('rejects missing and bogus tokens', async () => {
    expect((await call('GET', '/dashboard/summary')).status).toBe(401);
    tokens.bogus = 'dev:00000000-0000-0000-0000-000000000000';
    expect((await call('GET', '/dashboard/summary', { as: 'bogus' })).status).toBe(401);
    tokens.junk = 'not-a-token';
    expect((await call('GET', '/me', { as: 'junk' })).status).toBe(401);
  });
  it('viewers can read but not write; users cannot reach admin routes', async () => {
    expect((await call('GET', '/workflows', { as: 'viewer' })).status).toBe(200);
    expect((await call('POST', '/workflows', { as: 'viewer', body: { name: 'x' } })).status).toBe(403);
    expect((await call('GET', '/settings/secrets', { as: 'user' })).status).toBe(403);
    expect((await call('PUT', '/settings/billing', { as: 'user', body: { monthlyBudgetUsd: 1, alertThresholdPct: 50 } })).status).toBe(403);
    expect((await call('GET', '/settings/secrets', { as: 'admin' })).status).toBe(200);
  });
});

describe('dashboard', () => {
  it('serves summary, spend series and breakdowns from the database', async () => {
    const s = await call('GET', '/dashboard/summary?range=30d', { as: 'viewer' });
    expect(s.status).toBe(200);
    expect(s.json.spend.value).toBeGreaterThan(0);
    expect(s.json.includesSimulatedData).toBe(true);
    const spend = await call('GET', '/dashboard/spend?range=7d', { as: 'viewer' });
    expect(spend.json).toHaveLength(8);
    const b = await call('GET', '/dashboard/breakdown?by=model&range=90d', { as: 'viewer' });
    expect(b.json.length).toBeGreaterThan(0);
    expect((await call('GET', '/dashboard/breakdown?by=workflow', { as: 'viewer' })).status).toBe(200);
  });
});

describe('prompt studio', () => {
  const body = { system: 'Be brief', user: 'Say hi to {{name}} and {{who}}', model: 'claude-haiku-5-5', temperature: 0.5, maxTokens: 200, variables: { name: 'Ada' } };
  it('runs a prompt (simulated without a key), records usage + cost, reports problems', async () => {
    const r = await call('POST', '/prompts/run', { as: 'user', body });
    expect(r.status).toBe(200);
    expect(r.json.run.status).toBe('completed');
    expect(r.json.run.simulated).toBe(true);
    expect(r.json.run.costUsd).toBeGreaterThan(0);
    expect(r.json.run.output.text).toContain('SIMULATED');
    expect(r.json.missingVariables).toEqual(['who']);
    expect(r.json.temperatureIgnored).toBe(true);
    const logs = await call('GET', `/runs/${r.json.run.id}`, { as: 'user' });
    expect(logs.json.logs.length).toBeGreaterThanOrEqual(2);
  });
  it('validates input', async () => {
    expect((await call('POST', '/prompts/run', { as: 'user', body: { ...body, model: 'gpt-4' } })).status).toBe(400);
    expect((await call('POST', '/prompts/run', { as: 'user', body: { ...body, maxTokens: 0 } })).status).toBe(400);
    expect((await call('POST', '/prompts/run', { as: 'user', body: { ...body, user: '' } })).status).toBe(400);
  });
  it('versions prompts and saves templates', async () => {
    const c = await call('POST', '/prompts', { as: 'user', body: { name: 'Greeter', isTemplate: true, ...body } });
    expect(c.status).toBe(201);
    const id = c.json.prompt.id;
    const v2 = await call('POST', `/prompts/${id}/versions`, { as: 'user', body: { ...body, user: 'Hello {{name}}', note: 'shorter' } });
    expect(v2.json.version).toBe(2);
    const got = await call('GET', `/prompts/${id}`, { as: 'viewer' });
    expect(got.json.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(got.json.prompt.currentVersion).toBe(2);
    expect(got.json.variableNames).toEqual(['name']);
    const tpl = await call('GET', '/prompts?template=true&q=greeter', { as: 'viewer' });
    expect(tpl.json.some((p: any) => p.id === id)).toBe(true);
  });
  it('compares variants side by side', async () => {
    const r = await call('POST', '/prompts/compare', { as: 'user', body: { user: 'Hi', maxTokens: 100, variants: [{ model: 'claude-haiku-5-5' }, { model: 'claude-sonnet-5-5', label: 'Sonnet' }] } });
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(2);
    expect(r.json.results[1].label).toBe('Sonnet');
    expect(r.json.results.every((x: any) => x.run.status === 'completed')).toBe(true);
  });
  it('isolates prompts by organisation', async () => {
    const other = await db.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Other') RETURNING id`);
    const u = await db.query<{ id: string }>(`INSERT INTO users (org_id,email,name,role) VALUES ($1,'o@x.test','O','admin') RETURNING id`, [other.rows[0].id]);
    tokens.other = `dev:${u.rows[0].id}`;
    expect((await call('GET', '/prompts', { as: 'other' })).json).toEqual([]);
    const some = (await call('GET', '/prompts', { as: 'admin' })).json[0].id;
    expect((await call('GET', `/prompts/${some}`, { as: 'other' })).status).toBe(404);
  });
});

describe('workflows', () => {
  let wfId = '';
  it('creates from a template, validates, runs through the queue, and logs each node', async () => {
    const c = await call('POST', '/workflows/from-template', { as: 'user', body: { templateId: 'extract-structured' } });
    expect(c.status).toBe(201);
    wfId = c.json.id;
    const run = await call('POST', `/workflows/${wfId}/run`, { as: 'user', body: { input: { text: 'Invoice #1 from Globex, $5, due 2026-12-01' } } });
    expect(run.status).toBe(202);
    const runId = run.json.run.id;
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await call('GET', `/runs/${runId}`, { as: 'user' })).json;
      if (['completed', 'failed'].includes(state.run.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Simulated LLM text is not JSON, so the json_parse transform must fail the run with a clear error.
    expect(state.run.status).toBe('failed');
    expect(state.run.error).toMatch(/valid JSON/);
    const messages = state.logs.map((l: any) => l.message).join('\n');
    expect(messages).toContain('Extract fields');
    expect(messages).toContain('Run failed');
  });
  it('runs a passing workflow end to end, records usage, and saves media', async () => {
    const def = {
      nodes: [
        { id: 't', type: 'trigger', data: { source: 'manual' } },
        { id: 'l', type: 'llm', data: { model: 'claude-haiku-5-5', userPrompt: 'Caption: {{input}}', maxTokens: 100 } },
        { id: 'x', type: 'transform', data: { mode: 'uppercase' } },
        { id: 'a', type: 'action', data: { action: 'save_media', mediaType: 'photo', title: 'WF out', tags: 'wf-test' } },
        { id: 'o', type: 'output', data: {} },
      ],
      edges: [{ id: '1', source: 't', target: 'l' }, { id: '2', source: 'l', target: 'x' }, { id: '3', source: 'x', target: 'a' }, { id: '4', source: 'x', target: 'o' }],
    };
    const c = await call('POST', '/workflows', { as: 'user', body: { name: 'E2E', definition: def } });
    const before = (await call('GET', '/media?tag=wf-test', { as: 'viewer' })).json.total;
    const run = await call('POST', `/workflows/${c.json.id}/run`, { as: 'user', body: { input: { text: 'a cat' } } });
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await call('GET', `/runs/${run.json.run.id}`, { as: 'user' })).json;
      if (['completed', 'failed'].includes(state.run.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state.run.status).toBe('completed');
    expect(state.run.costUsd).toBeGreaterThan(0);
    expect(String(state.run.output.result)).toContain('SIMULATED');
    expect(String(state.run.output.result)).toBe(String(state.run.output.result).toUpperCase());
    expect((await call('GET', '/media?tag=wf-test', { as: 'viewer' })).json.total).toBe(before + 1);
    const usage = await db.query('SELECT 1 FROM usage_events WHERE workflow_id=$1', [c.json.id]);
    expect(usage.rowCount).toBe(1);
  });
  it('refuses to save/activate or run invalid workflows', async () => {
    const bad = await call('POST', '/workflows', { as: 'user', body: { name: 'bad', definition: { nodes: [{ id: 'l', type: 'llm', data: {} }], edges: [] } } });
    expect(bad.status).toBe(201);
    expect((await call('PUT', `/workflows/${bad.json.id}`, { as: 'user', body: { status: 'active' } })).status).toBe(400);
    expect((await call('POST', `/workflows/${bad.json.id}/run`, { as: 'user', body: {} })).status).toBe(400);
    expect((await call('POST', '/workflows', { as: 'user', body: { name: 'x', definition: { nodes: [{ id: 'q', type: 'evil', data: {} }], edges: [] } } })).status).toBe(400);
  });
  it('bumps version only when the definition changes', async () => {
    const before = (await call('GET', `/workflows/${wfId}`, { as: 'user' })).json;
    const renamed = (await call('PUT', `/workflows/${wfId}`, { as: 'user', body: { name: 'Renamed' } })).json;
    expect(renamed.version).toBe(before.version);
    const edited = (await call('PUT', `/workflows/${wfId}`, { as: 'user', body: { definition: { nodes: before.definition.nodes.slice(0, 2), edges: before.definition.edges.slice(0, 1) } } })).json;
    expect(edited.version).toBe(before.version + 1);
  });
  it('cancels queued runs only', async () => {
    const run = (await db.query<{ id: string }>(`INSERT INTO job_runs (org_id, kind, ref_name, status) SELECT org_id,'prompt','q','queued' FROM users WHERE id=$1 RETURNING id`, [ids.user])).rows[0].id;
    expect((await call('POST', `/runs/${run}/cancel`, { as: 'user' })).json.status).toBe('cancelled');
    expect((await call('POST', `/runs/${run}/cancel`, { as: 'user' })).status).toBe(409);
  });
});

describe('media timeline', () => {
  it('paginates with a stable cursor without duplicates', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await call('GET', `/media?limit=20${cursor ? `&cursor=${cursor}` : ''}`, { as: 'viewer' });
      expect(r.status).toBe(200);
      for (const i of r.json.items) { expect(seen.has(i.id)).toBe(false); seen.add(i.id); }
      cursor = r.json.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const total = (await call('GET', '/media?limit=1', { as: 'viewer' })).json.total;
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThan(1);
  });
  it('filters by type, tag, date range and workflow, and rejects bad cursors', async () => {
    const videos = (await call('GET', '/media?type=video&limit=60', { as: 'viewer' })).json;
    expect(videos.items.every((i: any) => i.type === 'video')).toBe(true);
    const tag = videos.items[0].tags[0];
    const tagged = (await call('GET', `/media?tag=${tag}&limit=60`, { as: 'viewer' })).json;
    expect(tagged.items.every((i: any) => i.tags.includes(tag))).toBe(true);
    const future = (await call('GET', '/media?from=2999-01-01', { as: 'viewer' })).json;
    expect(future.total).toBe(0);
    const wf = (await call('GET', '/workflows', { as: 'viewer' })).json[0].id;
    const byWf = (await call('GET', `/media?workflowId=${wf}&limit=60`, { as: 'viewer' })).json;
    expect(byWf.items.every((i: any) => i.workflowId === wf)).toBe(true);
    expect((await call('GET', '/media?cursor=garbage', { as: 'viewer' })).status).toBe(400);
  });
  it('exports CSV with a neutralised formula title and registers only http(s) URLs', async () => {
    await call('POST', '/media', { as: 'user', body: { type: 'photo', title: '=HYPERLINK("x")', url: 'https://example.com/a.png', tags: ['Export-Test'] } });
    const csv = await call('GET', '/media/export?tag=export-test', { as: 'viewer' });
    expect(csv.text).toContain("'=HYPERLINK");
    expect((await call('POST', '/media', { as: 'user', body: { type: 'photo', title: 'x', url: 'javascript:alert(1)' } })).status).toBe(400);
  });
});

describe('settings, secrets, team, budgets', () => {
  it('stores API keys encrypted and never returns them', async () => {
    const put = await call('PUT', '/settings/secrets/anthropic', { as: 'admin', body: { value: 'sk-ant-api03-SUPERSECRETVALUE9876' } });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.json)).not.toContain('SUPERSECRET');
    expect(put.json.last4).toBe('9876');
    const stored = await db.query<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE name='anthropic'`);
    expect(stored.rows[0].ciphertext).not.toContain('SUPERSECRET');
    const list = await call('GET', '/settings/secrets', { as: 'admin' });
    expect(list.text).not.toContain('SUPERSECRET');
    expect((await call('DELETE', '/settings/secrets/anthropic', { as: 'admin' })).status).toBe(204);
    expect((await call('PUT', '/settings/secrets/bogus', { as: 'admin', body: { value: '12345678' } })).status).toBe(404);
  });
  it('manages team roles but keeps at least one admin and blocks self-removal', async () => {
    const team = (await call('GET', '/team', { as: 'viewer' })).json;
    expect(team.length).toBeGreaterThanOrEqual(3);
    expect((await call('PATCH', `/team/${ids.admin}`, { as: 'admin', body: { role: 'user' } })).status).toBe(409);
    expect((await call('DELETE', `/team/${ids.admin}`, { as: 'admin' })).status).toBe(403);
    const inv = await call('POST', '/team/invite', { as: 'admin', body: { email: 'New@Example.com', role: 'viewer' } });
    expect(inv.status).toBe(201);
    expect((await call('POST', '/team/invite', { as: 'admin', body: { email: 'new@example.com' } })).status).toBe(409);
    expect((await call('PATCH', `/team/${inv.json.id}`, { as: 'admin', body: { role: 'user' } })).json.role).toBe('user');
    expect((await call('POST', '/team/invite', { as: 'user', body: { email: 'z@example.com' } })).status).toBe(403);
  });
  it('raises a budget alert exactly once per threshold when spend crosses it', async () => {
    await call('PUT', '/settings/billing', { as: 'admin', body: { monthlyBudgetUsd: 0.0001, alertThresholdPct: 50 } });
    await call('POST', '/prompts/run', { as: 'user', body: { user: 'budget trip', model: 'claude-haiku-5-5', maxTokens: 50 } });
    await call('POST', '/prompts/run', { as: 'user', body: { user: 'again', model: 'claude-haiku-5-5', maxTokens: 50 } });
    const alerts = (await call('GET', '/monitoring/alerts', { as: 'viewer' })).json.filter((a: any) => a.kind === 'budget_exceeded');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('critical');
    expect((await call('POST', `/monitoring/alerts/${alerts[0].id}/ack`, { as: 'user' })).status).toBe(204);
  });
});

describe('monitoring, search, export', () => {
  it('reports real status from persisted runs and filters logs', async () => {
    const m = (await call('GET', '/monitoring', { as: 'viewer' })).json;
    expect(m.apiHealthPct).toBeGreaterThan(0);
    expect(typeof m.queueSize).toBe('number');
    expect(m.claudeConfigured).toBe(false);
    const errors = (await call('GET', '/monitoring/logs?level=error&limit=50', { as: 'viewer' })).json;
    expect(errors.every((l: any) => l.level === 'error')).toBe(true);
    const wf = (await call('GET', '/monitoring/logs?kind=workflow&limit=50', { as: 'viewer' })).json;
    expect(wf.every((l: any) => l.kind === 'workflow')).toBe(true);
  });
  it('searches across prompts, workflows and media, treating wildcards literally', async () => {
    const r = (await call('GET', '/search?q=caption', { as: 'viewer' })).json;
    expect(r.prompts.length + r.workflows.length).toBeGreaterThan(0);
    const pct = (await call('GET', '/search?q=%25%25', { as: 'viewer' })).json;
    expect(pct.prompts.length + pct.workflows.length + pct.media.length).toBe(0);
    expect((await call('GET', '/search?q=a', { as: 'viewer' })).json).toEqual({ prompts: [], workflows: [], media: [] });
  });
  it('exports usage CSV and a valid PDF report', async () => {
    const csv = await call('GET', '/export/usage.csv?range=90d', { as: 'viewer' });
    expect(csv.text.split('\n')[0]).toBe('timestamp,provider,model,workflow,input_tokens,output_tokens,units,cost_usd,simulated');
    const pdf = await call('GET', '/export/report.pdf?range=30d', { as: 'viewer', raw: true });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await pdf.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
