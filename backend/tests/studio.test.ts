import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { getStudioModel, resolveMedia, resolveSettings, STUDIO_MODELS } from '../src/services/studioCatalog';

describe('studio catalog', () => {
  const plane = (id: string, settings: Record<string, any> = {}, media: any = {}) => {
    const m = getStudioModel(id)!;
    return m.build({ prompt: 'a fox', settings: resolveSettings(m, settings), media: resolveMedia(m, media) });
  };

  it('switches Kling between text and image endpoints and maps flags like the platform expects', () => {
    const text = plane('kling-3-pro');
    expect(text.path).toBe('kling-video/v3.0/pro/text-to-video');
    expect(text.body).toMatchObject({ prompt: 'a fox', sound: 'on', duration: 5, cfg_scale: 0.5, multi_shots: false, aspect_ratio: '16:9' });
    const img = plane('kling-3-4k', { sound: false }, { start: ['https://x.test/a.png'], end: ['https://x.test/b.png'] });
    expect(img.path).toBe('kling-video/v3.0/4k/image-to-video');
    expect(img.body).toMatchObject({ sound: 'off', image_url: 'https://x.test/a.png', last_image_url: 'https://x.test/b.png' });
    expect(img.body).not.toHaveProperty('aspect_ratio');
    expect(plane('kling-3-turbo', {}, { start: ['https://x.test/a.png'] }).path).toBe('kling-video/v3.0-turbo/image-to-video');
  });

  it('sends Soul batch size as a number and fills defaults', () => {
    const s = plane('soul-2', { batchSize: '4' });
    expect(s.path).toBe('higgsfield-ai/soul/v2/standard');
    expect(s.body).toMatchObject({ batch_size: 4, resolution: '720p', aspect_ratio: '1:1', enhance_prompt: false });
    expect(plane('soul-cinema').path).toBe('higgsfield-ai/soul/cinema');
    expect(plane('flux-2').path).toBe('flux-2-pro');
  });

  it('rejects unknown/out-of-range settings and unsupported or non-http media', () => {
    const kling = getStudioModel('kling-3-std')!;
    expect(() => resolveSettings(kling, { duration: 99 })).toThrow(/between 3 and 15/);
    expect(() => resolveSettings(kling, { nope: 1 })).toThrow(/Unknown setting/);
    expect(() => resolveSettings(kling, { sound: 'yes' })).toThrow(/true or false/);
    expect(() => resolveMedia(getStudioModel('soul-2')!, { start: ['https://x.test/a.png'] })).toThrow(/does not accept start/);
    expect(() => resolveMedia(kling, { start: ['https://a/1.png', 'https://a/2.png'] })).toThrow(/at most 1/);
    expect(() => resolveMedia(kling, { start: ['javascript:alert(1)'] })).toThrow(/http\(s\)/);
  });

  it('has unique model ids with valid defaults', () => {
    expect(new Set(STUDIO_MODELS.map((m) => m.id)).size).toBe(STUDIO_MODELS.length);
    for (const m of STUDIO_MODELS) expect(() => resolveSettings(m, {})).not.toThrow();
  });
});

// ---- API + fake platform ----------------------------------------------------------------------
let db: Db;
let server: http.Server;
let base = '';
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

async function waitRun(id: string, as = 'user') {
  for (let i = 0; i < 200; i++) {
    const r = (await call('GET', `/runs/${id}`, { as })).json;
    if (['completed', 'failed'].includes(r.run.status)) return r;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

/** A stand-in for the Higgsfield platform that records what it receives. */
const fake = {
  server: null as http.Server | null,
  url: '',
  seen: [] as { method: string; url: string; auth: string | undefined; body: any }[],
  /** How the next submitted requests should end. */
  script: 'video' as 'video' | 'nsfw' | 'reject' | 'image2',
  statusCalls: new Map<string, number>(),
};

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

  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      fake.seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const send = (code: number, obj: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      const m = /^\/requests\/([^/]+)\/status$/.exec(req.url!);
      if (req.method === 'POST') {
        if (fake.script === 'reject') return send(422, { detail: 'prompt too long' });
        return send(200, { request_id: `req-${fake.seen.length}`, status: 'queued', status_url: '', cancel_url: '' });
      }
      if (m) {
        const n = (fake.statusCalls.get(m[1]) ?? 0) + 1;
        fake.statusCalls.set(m[1], n);
        if (n < 3) return send(200, { status: n === 1 ? 'queued' : 'in_progress', request_id: m[1] });
        if (fake.script === 'nsfw') return send(200, { status: 'nsfw', request_id: m[1] });
        if (fake.script === 'image2') return send(200, { status: 'completed', request_id: m[1], images: [{ url: `https://cdn.test/${m[1]}-a.png` }, { url: `https://cdn.test/${m[1]}-b.png` }] });
        return send(200, { status: 'completed', request_id: m[1], video: { url: `https://cdn.test/${m[1]}.mp4` } });
      }
      send(404, { detail: 'not found' });
    });
  });
  await new Promise<void>((r) => fake.server!.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(fake.server!.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  server.close();
  fake.server?.close();
  await db.close();
});

describe('studio API (simulated mode)', () => {
  it('lists the catalog and reports it is not connected', async () => {
    const r = await call('GET', '/studio/models', { as: 'viewer' });
    expect(r.status).toBe(200);
    expect(r.json.connected).toBe(false);
    expect(r.json.models.length).toBe(STUDIO_MODELS.length);
    const kling = r.json.models.find((m: any) => m.id === 'kling-3-pro');
    expect(kling).toMatchObject({ surface: 'video', priceUsd: null, nativeBatch: false });
    expect(kling).not.toHaveProperty('build');
    expect(r.json.models.find((m: any) => m.id === 'soul-2').nativeBatch).toBe(true);
  });

  it('validates input and enforces roles', async () => {
    const ok = { modelId: 'kling-3-std', prompt: 'a fox', settings: {}, media: {}, count: 1 };
    expect((await call('POST', '/studio/generate', { as: 'viewer', body: ok })).status).toBe(403);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, modelId: 'nope' } })).status).toBe(404);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, prompt: '   ' } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, settings: { duration: 100 } } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, count: 9 } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, modelId: 'soul-2', media: { start: ['https://x.test/a.png'] } } })).status).toBe(400);
  });

  it('generates, stores results in the media timeline, and records usage with admin-set prices', async () => {
    expect((await call('PUT', '/settings/studio-prices', { as: 'user', body: { prices: { 'kling-3-std': 0.5 } } })).status).toBe(403);
    expect((await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { 'kling-3-std': 0.5 } } })).status).toBe(200);
    expect((await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { bogus: 1 } } })).status).toBe(400);

    const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'kling-3-std', prompt: 'a fox in snow', count: 3 } });
    expect(g.status).toBe(202);
    expect(g.json.run.kind).toBe('generation');
    const done = await waitRun(g.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.simulated).toBe(true);
    expect(done.run.output.assets).toHaveLength(3);
    expect(done.run.costUsd).toBeCloseTo(1.5, 6);
    expect(done.logs.map((l: any) => l.message).join('\n')).toMatch(/SIMULATED/);

    const m = (await call('GET', `/media?source=studio&runId=${g.json.run.id}`, { as: 'viewer' })).json;
    expect(m.total).toBe(3);
    expect(m.items[0]).toMatchObject({ type: 'video', title: 'a fox in snow' });
    expect(m.items[0].metadata).toMatchObject({ source: 'studio', model: 'kling-3-std', simulated: true });
    const usage = await db.query(`SELECT SUM(units)::float8 AS u, SUM(cost_usd)::float8 AS c FROM usage_events WHERE run_id=$1 AND provider='higgsfield'`, [g.json.run.id]);
    expect(usage.rows[0]).toMatchObject({ u: 3, c: 1.5 });
  });

  it('uses the native batch for Soul (one request, batch_size) and unpriced models cost $0', async () => {
    const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'soul-2', prompt: 'portrait', settings: { batchSize: '4' }, count: 3 } });
    const done = await waitRun(g.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.costUsd).toBe(0);
    expect(done.run.output.assets).toHaveLength(1); // simulated platform returns one image per request; count is ignored with native batching
  });
});

describe('studio API (against a fake Higgsfield platform)', () => {
  it('rejects unsafe base URLs, then connects', async () => {
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'ftp://x.test' } })).status).toBe(400);
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'http://user:pw@x.test' } })).status).toBe(400);
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'not a url' } })).status).toBe(400);
    expect((await call('PUT', '/settings/higgsfield', { as: 'user', body: { baseUrl: fake.url } })).status).toBe(403);
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: fake.url + '/' } })).json.baseUrl).toBe(fake.url);
    // URL alone is not enough - a key is required too
    expect((await call('GET', '/studio/models', { as: 'viewer' })).json.connected).toBe(false);
    // Malformed Higgsfield keys are refused at save time (missing colon, extra part, whitespace)
    for (const bad of ['justonepartvalue', 'id:extra:secretvalue', 'id: secret value', 'id:\nsecretvalue']) {
      expect((await call('PUT', '/settings/secrets/higgsfield', { as: 'admin', body: { value: bad } })).status).toBe(400);
    }
    expect((await call('PUT', '/settings/secrets/higgsfield', { as: 'admin', body: { value: 'key-id:secret-value' } })).status).toBe(200);
    const shape = (await call('GET', '/settings/secrets', { as: 'admin' })).json.find((s: any) => s.name === 'higgsfield');
    expect(shape).toMatchObject({ formatOk: true, last4: 'alue' });
    expect(JSON.stringify(shape)).not.toContain('secret-value');
    const m = (await call('GET', '/studio/models', { as: 'viewer' })).json;
    expect(m.connected).toBe(true);
    expect(JSON.stringify(m)).not.toContain('secret-value');
  });

  it('submits to the model path with the Key header, polls, and stores the returned video', async () => {
    fake.script = 'video';
    fake.seen.length = 0;
    const g = await call('POST', '/studio/generate', {
      as: 'user',
      body: { modelId: 'kling-3-pro', prompt: 'drone shot', settings: { duration: 8, sound: false }, media: { start: ['https://img.test/start.png'] } },
    });
    const done = await waitRun(g.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.simulated).toBe(false);

    const post = fake.seen.find((s) => s.method === 'POST')!;
    expect(post.url).toBe('/kling-video/v3.0/pro/image-to-video');
    expect(post.auth).toBe('Key key-id:secret-value');
    expect(post.body).toMatchObject({ prompt: 'drone shot', duration: 8, sound: 'off', image_url: 'https://img.test/start.png' });
    expect(fake.seen.filter((s) => s.method === 'GET').every((s) => /^\/requests\/req-\d+\/status$/.test(s.url) && s.auth === 'Key key-id:secret-value')).toBe(true);

    expect(done.run.output.assets).toHaveLength(1);
    expect(done.run.output.assets[0]).toMatchObject({ type: 'video', url: expect.stringMatching(/^https:\/\/cdn\.test\/req-\d+\.mp4$/) });
    expect(done.logs.map((l: any) => l.message).join('\n')).not.toMatch(/SIMULATED/);
  });

  it('stores every image a request returns', async () => {
    fake.script = 'image2';
    const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'flux-2', prompt: 'two images' } });
    const done = await waitRun(g.json.run.id);
    expect(done.run.output.assets.map((a: any) => a.type)).toEqual(['photo', 'photo']);
  });

  it('fails the run clearly on moderation blocks and on API errors', async () => {
    fake.script = 'nsfw';
    const a = await waitRun((await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'flux-2', prompt: 'blocked' } })).json.run.id);
    expect(a.run.status).toBe('failed');
    expect(a.run.error).toMatch(/content moderation/);

    fake.script = 'reject';
    const b = await waitRun((await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'flux-2', prompt: 'rejected' } })).json.run.id);
    expect(b.run.status).toBe('failed');
    expect(b.run.error).toBe('Higgsfield API responded 422: prompt too long');
    expect(JSON.stringify(b)).not.toContain('secret-value');
  });
});

describe('workflow Generate node', () => {
  const def = (extra: Record<string, unknown> = {}) => ({
    nodes: [
      { id: 't', type: 'trigger', data: { source: 'manual', sampleInput: 'a lighthouse' } },
      { id: 'g', type: 'generate', data: { model: 'flux-2', prompt: 'Photo of {{input}}', ...extra } },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [{ id: '1', source: 't', target: 'g' }, { id: '2', source: 'g', target: 'o' }],
  });

  it('runs inside a workflow and attaches media to that workflow', async () => {
    fake.script = 'image2';
    fake.seen.length = 0;
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Gen WF', definition: def() } })).json;
    const run = await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { input: { text: 'a lighthouse' } } });
    const done = await waitRun(run.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(fake.seen.find((s) => s.method === 'POST')!.body.prompt).toBe('Photo of a lighthouse');
    expect(done.run.output.result.assets).toHaveLength(2);
    const media = (await call('GET', `/media?workflowId=${wf.id}`, { as: 'viewer' })).json;
    expect(media.total).toBe(2);
  });

  it('is validated on save/run', async () => {
    const bad = (await call('POST', '/workflows', { as: 'user', body: { name: 'Bad Gen', definition: def({ model: 'nope', prompt: '' }) } })).json;
    expect((await call('POST', `/workflows/${bad.id}/run`, { as: 'user', body: {} })).status).toBe(400);
    expect((await call('PUT', `/workflows/${bad.id}`, { as: 'user', body: { status: 'active' } })).status).toBe(400);
  });
});
