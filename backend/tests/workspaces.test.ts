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
let rgm = '';
let glg = '';

async function call(method: string, path: string, opts: { as: string; workspace?: string; body?: unknown }) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[opts.as]}`, ...(opts.workspace ? { 'x-workspace': opts.workspace } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
  for (const u of users) tokens[u.role] = u.token;
  const list = (await call('GET', '/workspaces', { as: 'admin' })).json;
  rgm = list.workspaces[0].id;
  glg = list.workspaces[1].id;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

const project = (name: string) => ({ name, type: 'micro_drama', description: '', budgetUsd: 0 });
const names = (r: { json: { name: string }[] }) => r.json.map((p) => p.name);

describe('workspaces', () => {
  it('starts with Right Girl Media and Greene Legal Group, the same two for every login', async () => {
    for (const as of ['admin', 'user']) {
      const r = await call('GET', '/workspaces', { as });
      expect(r.json.workspaces.map((w: { name: string }) => w.name)).toEqual(['Right Girl Media', 'Greene Legal Group']);
    }
  });

  it('opens in Right Girl Media when no workspace is named or the name is unknown', async () => {
    expect((await call('GET', '/workspaces', { as: 'admin' })).json.current).toBe(rgm);
    expect((await call('GET', '/workspaces', { as: 'admin', workspace: '00000000-0000-4000-8000-000000000000' })).json.current).toBe(rgm);
    expect((await call('GET', '/workspaces', { as: 'admin', workspace: glg })).json.current).toBe(glg);
  });

  it('keeps projects separate, and projects made before workspaces belong to Right Girl Media', async () => {
    await call('POST', '/projects', { as: 'user', workspace: rgm, body: project('RGM carousel') });
    await call('POST', '/projects', { as: 'user', workspace: glg, body: project('GLG dunk trend') });
    const inRgm = names(await call('GET', '/projects', { as: 'admin', workspace: rgm }));
    const inGlg = names(await call('GET', '/projects', { as: 'admin', workspace: glg }));
    expect(inRgm).toContain('RGM carousel');
    expect(inRgm).toContain('Default project'); // seeded with no workspace
    expect(inRgm).not.toContain('GLG dunk trend');
    expect(inGlg).toEqual(['GLG dunk trend']);
  });

  it('keeps the media library separate', async () => {
    const add = (workspace: string, title: string) =>
      call('POST', '/media', { as: 'user', workspace, body: { type: 'photo', title, url: 'https://example.com/a.png', tags: ['only-here'] } });
    await add(rgm, 'rgm photo');
    await add(glg, 'glg photo');
    const titles = async (workspace: string) => (await call('GET', '/media?q=photo', { as: 'admin', workspace })).json.items.map((m: { title: string }) => m.title);
    expect(await titles(glg)).toEqual(['glg photo']);
    expect(await titles(rgm)).toContain('rgm photo');
    expect(await titles(rgm)).not.toContain('glg photo');
    const tags = (await call('GET', '/media/tags', { as: 'admin', workspace: glg })).json as { tag: string; n: number }[];
    expect(tags.find((t) => t.tag === 'only-here')?.n).toBe(1);
  });
});

describe('what the team login can see and change', () => {
  it('sees prices, charges, the monthly budget and balances for reports', async () => {
    const teamSummary = (await call('GET', '/dashboard/summary', { as: 'user' })).json;
    expect(teamSummary.budget).not.toBeNull();
    expect(teamSummary.spend).toBeDefined();
    expect(Array.isArray((await call('GET', '/dashboard/credits', { as: 'user' })).json)).toBe(true);
    const teamSettings = (await call('GET', '/settings', { as: 'user' })).json;
    expect(teamSettings.billing).not.toBeNull();
    expect(teamSettings.higgsfield.prices).toBeDefined();
  });

  it('cannot see or change keys, and cannot change budget, prices or balances', async () => {
    expect((await call('PUT', '/settings/credits/claude', { as: 'user', body: { balanceUsd: 5 } })).status).toBe(403);
    expect((await call('GET', '/settings/secrets', { as: 'user' })).status).toBe(403);
    expect((await call('PUT', '/settings/billing', { as: 'user', body: { monthlyBudgetUsd: 1, alertThresholdPct: 50 } })).status).toBe(403);
    expect((await call('PUT', '/settings/studio-prices', { as: 'user', body: { prices: {} } })).status).toBe(403);
  });
});
