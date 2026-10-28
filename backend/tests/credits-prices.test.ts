import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
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
  /** Simulates Higgsfield being slow: status never leaves in_progress. */
  stuck: false,
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
      if (m && hf.stuck) return send(200, { status: 'in_progress', request_id: m[1] });
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

describe('Studio page quote', () => {
  it('returns Higgsfield’s quote for the exact request, null when an admin price is set, and validates input', async () => {
    hf.estimateUsd = 0.004;
    hf.mode = 'price';
    clearLivePriceCache();
    const q = await call('POST', '/studio/estimate', { as: 'user', body: { modelId: 'soul-2', prompt: 'a portrait', settings: { resolution: '1080p' } } });
    expect(q.json).toEqual({ usd: 0.004 });
    expect(hf.estimates.at(-1)?.body).toMatchObject({ prompt: 'a portrait', resolution: '1080p' });
    const three = await call('POST', '/studio/estimate', { as: 'user', body: { modelId: 'kling-3-std', prompt: 'x', count: 3 } });
    expect(three.json.usd).toBeCloseTo(0.012, 8); // one quote per request, three requests
    await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { 'soul-2': 0.01 } } });
    expect((await call('POST', '/studio/estimate', { as: 'user', body: { modelId: 'soul-2', prompt: 'a portrait' } })).json).toEqual({ usd: null });
    await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { 'soul-2': null } } });
    expect((await call('POST', '/studio/estimate', { as: 'user', body: { modelId: 'nope', prompt: 'x' } })).status).toBe(400);
    hf.estimateUsd = null;
    clearLivePriceCache();
    expect((await call('POST', '/studio/estimate', { as: 'user', body: { modelId: 'soul-2', prompt: 'a portrait' } })).json).toEqual({ usd: null }); // lookup unavailable -> page falls back
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
    // Earlier tests ran price checks at the real clock time. Once the real date is past the promo those would count as
    // "re-checked after the promotion", so set them aside and put them back (re-dated) for the last step.
    const earlier = (await db.query(`SELECT org_id, value FROM org_settings WHERE key='price_check'`)).rows;
    await db.query(`DELETE FROM org_settings WHERE key='price_check'`);
    expect(await checkPriceFreshness(before)).toBe(0);

    // no price check since the promotion ended, so it raises the reminder
    expect(await checkPriceFreshness(after)).toBe(1);
    expect(await checkPriceFreshness(after)).toBe(0); // once per promotion
    const a = (await db.query(`SELECT severity, message FROM alerts WHERE kind='prices_check'`)).rows;
    expect(a).toHaveLength(1);
    expect(a[0].message).toContain('Check prices');

    // re-checked after the promotion: no alert even if it was never raised
    await db.query(`DELETE FROM alerts WHERE kind='prices_check'`);
    for (const r of earlier) {
      await db.query(`INSERT INTO org_settings (org_id, key, value) VALUES ($1, 'price_check', jsonb_set($2::jsonb, '{checkedAt}', to_jsonb($3::text)))`, [r.org_id, JSON.stringify(r.value), new Date(after).toISOString()]);
    }
    expect(earlier.length).toBeGreaterThan(0);
    expect(await checkPriceFreshness(after)).toBe(0);
  });
});

describe('credits', () => {
  const credits = async (as = 'admin') => (await call('GET', '/dashboard/credits', { as })).json as any[];
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

describe('when Higgsfield is slow', () => {
  it('waits up to 30 minutes by default', () => {
    expect(config.studioDeadlineMs).toBe(1_800_000);
  });

  it('gives up with the full request id and a clear warning that it may still finish and charge', async () => {
    const saved = config.studioDeadlineMs;
    config.studioDeadlineMs = 200;
    hf.stuck = true;
    try {
      const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'z-image-turbo', prompt: 'a lamp' } });
      expect(g.status).toBe(202);
      const done = await waitRun(g.json.run.id);
      expect(done.run.status).toBe('failed');
      expect(done.run.error).toMatch(/Timed out waiting for the platform after 0 minutes\. It may still finish at Higgsfield \(request id req-[a-z0-9]+\); check your Higgsfield console usage before trying again/);
      const ids = (done.logs.find((l: any) => /Higgsfield request id/.test(l.message))?.message as string).match(/req-[a-z0-9]+/)![0];
      expect(done.run.error).toContain(ids); // the id in the error is the same one logged at submit time
      expect(done.logs.map((l: any) => l.message).join('\n')).toMatch(/timed out after 0 minutes and may still complete/);
      expect(done.run.costUsd).toBe(0); // nothing is recorded as spent for work we never received
    } finally {
      hf.stuck = false;
      config.studioDeadlineMs = saved;
    }
  });

  it('a slow request that does finish inside the wait still succeeds', async () => {
    const saved = config.studioDeadlineMs;
    config.studioDeadlineMs = 5000;
    hf.stuck = true;
    setTimeout(() => (hf.stuck = false), 300); // Higgsfield recovers
    try {
      const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'z-image-turbo', prompt: 'a lamp' } });
      const done = await waitRun(g.json.run.id);
      expect(done.run.status).toBe('completed');
    } finally {
      hf.stuck = false;
      config.studioDeadlineMs = saved;
    }
  });
});
