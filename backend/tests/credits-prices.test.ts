import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb, setIo } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { clearLivePriceCache } from '../src/services/livePrice';
import { checkPriceFreshness } from '../src/services/scheduler';
import { billedSeconds, getStudioModel } from '../src/services/studioCatalog';
import { recordUsage } from '../src/services/usage';

let db: Db;
let server: http.Server;
let base = '';
let orgId = '';
const tokens: Record<string, string> = {};

async function call(method: string, path: string, opts: { as: string; body?: unknown }) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[opts.as]}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function waitRun(id: string) {
  for (let i = 0; i < 300; i++) {
    const r = (await call('GET', `/runs/${id}`, { as: 'user' })).json;
    if (['completed', 'failed'].includes(r.run.status)) return r;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

/** Higgsfield stand-in: estimates (configurable), generation, polling. */
const hf = {
  server: null as http.Server | null,
  url: '',
  estimateUsd: null as number | null,
  mode: 'price' as 'price' | 'description',
  estimates: [] as { url: string; body: any }[],
};

beforeAll(async () => {
  hf.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      const send = (code: number, obj: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      if (req.url!.startsWith('/estimate/')) {
        hf.estimates.push({ url: req.url!, body });
        if (hf.estimateUsd === null) return send(404, { detail: 'no estimate' });
        if (hf.mode === 'description') return send(200, { type: 'description', pricing_description: 'Per-second pricing by resolution' });
        return send(200, { credits: String(hf.estimateUsd * 16), usd: String(hf.estimateUsd) });
      }
      if (req.method === 'POST') return send(200, { request_id: `req-${Math.random().toString(36).slice(2)}`, status: 'queued' });
      const m = /^\/requests\/([^/]+)\/status$/.exec(req.url!);
      if (m) return send(200, { status: 'completed', request_id: m[1], video: { url: `https://cdn.test/${m[1]}.mp4` } });
      send(404, { detail: 'not found' });
    });
  });
  await new Promise<void>((r) => hf.server!.listen(0, '127.0.0.1', r));
  hf.url = `http://127.0.0.1:${(hf.server!.address() as AddressInfo).port}`;

  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
  for (const u of users) tokens[u.role] = u.token;
  orgId = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
}, 60_000);

afterAll(async () => {
  server.close();
  hf.server?.close();
  setIo(null);
  await db.close();
});

beforeEach(() => {
  clearLivePriceCache();
  hf.estimates.length = 0;
});

describe('billing seconds', () => {
  it('bills a dropdown duration ("6") by its length, not as 1 second', () => {
    const ltx = getStudioModel('ltx-2-5-fast')!;
    expect(billedSeconds(ltx, ltx.modes[0], { duration: '6' })).toBe(6);
    expect(billedSeconds(ltx, ltx.modes[0], { duration: 8 })).toBe(8);
    expect(billedSeconds(ltx, ltx.modes[0], {})).toBe(1);
    expect(billedSeconds(ltx, ltx.modes[0], { duration: '' })).toBe(1);
    expect(billedSeconds(ltx, ltx.modes[0], { duration: 'abc' })).toBe(1);
  });
});

describe('live prices from Higgsfield', () => {
  let proj: any;
  let card: any;

  it('works with no connection (snapshot prices)', async () => {
    proj = (await call('POST', '/projects', { as: 'user', body: { name: 'Pricing', type: 'micro_drama' } })).json;
    card = (await call('POST', `/projects/${proj.id}/items`, { as: 'user', body: { title: 'A', prompt: 'a lamp', modelId: 'kling-3-std', settings: { duration: 5 } } })).json[0];
    const est = (await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} })).json;
    expect(est.estimates[0]).toMatchObject({ ok: true, basis: 'list' });
    expect((await call('POST', '/settings/higgsfield/check-prices', { as: 'admin' })).status).toBe(400); // not connected
  });

  it('after connecting, the approval estimate is Higgsfield’s own quote for exactly these settings', async () => {
    expect((await call('PUT', '/settings/secrets/higgsfield', { as: 'admin', body: { value: 'keyid:keysecret' } })).status).toBe(200);
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: hf.url } })).status).toBe(200);
    hf.estimateUsd = 0.5;
    const est = (await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} })).json;
    expect(est.totalUsd).toBeCloseTo(0.5, 8);
    expect(est.estimates[0]).toMatchObject({ ok: true, basis: 'live', costUsd: 0.5 });
    expect(hf.estimates[0].url).toBe('/estimate/kling-video/v3.0/std/text-to-video');
    expect(hf.estimates[0].body).toMatchObject({ prompt: 'a lamp', duration: 5 });
    // a second look inside ten minutes reuses the answer instead of asking again
    await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} });
    expect(hf.estimates).toHaveLength(1);
  });

  it('generation is gated on, and records, the live price', async () => {
    const low = await call('POST', `/projects/${proj.id}/generate`, { as: 'user', body: { ids: [card.id], expectedTotalUsd: 0.3 } });
    expect(low.status).toBe(409); // the snapshot would have said ~$0.36; Higgsfield says $0.50
    const go = await call('POST', `/projects/${proj.id}/generate`, { as: 'user', body: { ids: [card.id], expectedTotalUsd: 0.5 } });
    expect(go.status).toBe(202);
    const done = await waitRun(go.json.runs[0].id);
    expect(done.run.status).toBe('completed');
    expect(done.run.costUsd).toBeCloseTo(0.5, 8);
    expect(done.logs.map((l: any) => l.message).join('\n')).toMatch(/from Higgsfield's own estimate/);
  });

  it('falls back to the snapshot when the lookup is unavailable or only returns a description; an admin price still wins', async () => {
    hf.estimateUsd = null;
    clearLivePriceCache();
    expect((await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} })).json.estimates[0].basis).toBe('list');
    hf.estimateUsd = 0.5;
    hf.mode = 'description';
    clearLivePriceCache();
    expect((await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} })).json.estimates[0].basis).toBe('list');
    hf.mode = 'price';
    clearLivePriceCache();
    await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { 'kling-3-std': 0.2 } } });
    const est = (await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} })).json.estimates[0];
    expect(est).toMatchObject({ basis: 'admin', costUsd: 1 }); // $0.20/s x 5s
    await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { 'kling-3-std': null } } });
  });

  it('workflow estimates use the live price too', async () => {
    clearLivePriceCache();
    const def = { nodes: [{ id: 't', type: 'trigger', data: { source: 'manual' } }, { id: 'g', type: 'generate', data: { model: 'z-image-turbo', prompt: 'a lamp' } }], edges: [{ id: 'e', source: 't', target: 'g' }] };
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Live wf', definition: def } })).json;
    hf.estimateUsd = 0.07;
    expect((await call('POST', `/workflows/${wf.id}/estimate`, { as: 'user' })).json.totalUsd).toBeCloseTo(0.07, 8);
  });
});

describe('price check', () => {
  it('compares every model with Higgsfield’s estimate, shows written pricing as is, and needs an admin', async () => {
    expect((await call('POST', '/settings/higgsfield/check-prices', { as: 'user' })).status).toBe(403);
    hf.estimateUsd = 0.01;
    hf.mode = 'price';
    const r = await call('POST', '/settings/higgsfield/check-prices', { as: 'admin' });
    expect(r.status).toBe(200);
    expect(r.json.rows.length).toBeGreaterThan(30);
    const soul = r.json.rows.find((x: any) => x.modelId === 'soul-2' && x.modeId === 'text');
    expect(soul).toMatchObject({ liveUsd: 0.01, snapshotUsd: 0.0032, status: 'changed' });
    expect(soul.diffPct).toBeGreaterThan(200);
    const z = r.json.rows.find((x: any) => x.modelId === 'z-image-turbo');
    expect(z).toMatchObject({ liveUsd: 0.01, snapshotUsd: 0.015, status: 'changed' });
    // required inputs are filled with stand-ins so the estimate can be asked for
    const motion = hf.estimates.find((e) => e.url.includes('motion-control'));
    expect(motion?.body).toMatchObject({ image_url: 'https://example.com/placeholder.png', video_url: 'https://example.com/placeholder.mp4' });

    hf.mode = 'description';
    const d = await call('POST', '/settings/higgsfield/check-prices', { as: 'admin' });
    expect(d.json.rows[0]).toMatchObject({ status: 'info', liveUsd: null, description: 'Per-second pricing by resolution' });
    expect(d.json.counts.info).toBe(d.json.rows.length);
    // the last result is kept for the Settings page
    expect((await call('GET', '/settings', { as: 'admin' })).json.higgsfield.priceCheck.counts.info).toBe(d.json.rows.length);
    hf.mode = 'price';
  });

  it('reports a failed lookup per row instead of failing the whole check', async () => {
    hf.estimateUsd = null; // every estimate 404s
    const r = await call('POST', '/settings/higgsfield/check-prices', { as: 'admin' });
    expect(r.status).toBe(200);
    expect(r.json.counts.error).toBe(r.json.rows.length);
    expect(r.json.rows[0].note).toMatch(/404/);
  });
});

describe('promotion reminder', () => {
  it('raises one alert after the promo ends, and not if prices were re-checked since', async () => {
    const { promoEndDate } = await import('../src/services/priceCheck');
    const promo = promoEndDate()!;
    const before = new Date(`${promo}T10:00:00Z`).getTime();
    const after = new Date(`${promo}T23:59:59Z`).getTime() + 3600_000;
    expect(await checkPriceFreshness(before)).toBe(0);

    // the earlier price checks ran today (before the promo ended), so they don't count
    expect(await checkPriceFreshness(after)).toBe(1);
    expect(await checkPriceFreshness(after)).toBe(0); // once per promotion
    const a = (await db.query(`SELECT severity, message FROM alerts WHERE kind='prices_check'`)).rows;
    expect(a).toHaveLength(1);
    expect(a[0].message).toContain('Check prices');

    // re-checked after the promotion: no alert even if it was never raised
    await db.query(`DELETE FROM alerts WHERE kind='prices_check'`);
    await db.query(`UPDATE org_settings SET value = jsonb_set(value, '{checkedAt}', to_jsonb($1::text)) WHERE key='price_check'`, [new Date(after).toISOString()]);
    expect(await checkPriceFreshness(after)).toBe(0);
  });
});

describe('credits', () => {
  const credits = async (as = 'viewer') => (await call('GET', '/dashboard/credits', { as })).json as any[];
  const of = (rows: any[], p: string) => rows.find((r) => r.provider === p);

  it('starts empty and only admins can set a balance', async () => {
    expect(of(await credits(), 'claude')).toMatchObject({ set: false, remainingUsd: null, low: false });
    expect((await call('PUT', '/settings/credits/claude', { as: 'user', body: { balanceUsd: 20 } })).status).toBe(403);
    expect((await call('PUT', '/settings/credits/claude', { as: 'admin', body: { balanceUsd: -1 } })).status).toBe(400);
    expect((await call('PUT', '/settings/credits/other', { as: 'admin', body: { balanceUsd: 5 } })).status).toBe(400);
  });

  it('subtracts real spend recorded after the balance was entered, ignores demo data, and tells open dashboards at once', async () => {
    // spend recorded BEFORE the balance was entered is history, not part of "left"
    await recordUsage({ orgId, provider: 'claude', costUsd: 1, simulated: false });
    const events: any[] = [];
    setIo({ to: () => ({ emit: (ev: string, payload: unknown) => events.push({ ev, payload }) }) } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect((await call('PUT', '/settings/credits/claude', { as: 'admin', body: { balanceUsd: 20 } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));

    await recordUsage({ orgId, provider: 'claude', costUsd: 3.5, simulated: false });
    await recordUsage({ orgId, provider: 'claude', costUsd: 100, simulated: true }); // demo data never counts
    expect(events.filter((e) => e.ev === 'usage:new').map((e) => e.payload)).toEqual([
      { provider: 'claude', costUsd: 3.5, simulated: false },
      { provider: 'claude', costUsd: 100, simulated: true },
    ]);
    const c = of(await credits(), 'claude');
    expect(c).toMatchObject({ set: true, startingUsd: 20, usedSinceUsd: 3.5, remainingUsd: 16.5, low: false });
    expect(c.lifetimeUsedUsd).toBeCloseTo(4.5, 8);
    expect(of(await credits(), 'higgsfield')).toMatchObject({ set: false });
    setIo(null);
  });

  it('warns once when credit runs low, and entering a fresh balance starts a new count', async () => {
    await recordUsage({ orgId, provider: 'claude', costUsd: 15, simulated: false }); // 20 - 18.5 = 1.5 left
    const c = of(await credits(), 'claude');
    expect(c.remainingUsd).toBeCloseTo(1.5, 8);
    expect(c.low).toBe(true);
    const alerts = (await db.query(`SELECT severity, message FROM alerts WHERE kind='credits_low'`)).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/Anthropic \(Claude\) credit looks low.*\$1\.50 left of the \$20\.00/);
    await recordUsage({ orgId, provider: 'claude', costUsd: 0.1, simulated: false });
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM alerts WHERE kind='credits_low'`)).rows[0].n).toBe(1); // not repeated

    await new Promise((r) => setTimeout(r, 20));
    await call('PUT', '/settings/credits/claude', { as: 'admin', body: { balanceUsd: 50 } });
    expect(of(await credits(), 'claude')).toMatchObject({ startingUsd: 50, usedSinceUsd: 0, remainingUsd: 50, low: false });
    expect((await call('DELETE', '/settings/credits/claude', { as: 'admin' })).status).toBe(204);
    expect(of(await credits(), 'claude').set).toBe(false);
  });
});
