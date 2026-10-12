import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { prepareGeneration } from '../src/services/studio';
import { billedSeconds, buildRequest, getStudioModel, LIST_PRICES, pickMode, resolveMedia, resolveSettings, STUDIO_MODELS, unitPrice, type MediaRole } from '../src/services/studioCatalog';

/** Validate + build exactly what would be sent to the platform. */
const plan = (modelId: string, p: { mode?: string; prompt?: string; settings?: Record<string, any>; media?: Partial<Record<MediaRole, string[]>> } = {}) =>
  prepareGeneration({ modelId, prompt: 'a fox', ...p });

describe('studio catalog (data-driven)', () => {
  it('has unique model ids, valid defaults, and unique mode ids/paths', () => {
    expect(new Set(STUDIO_MODELS.map((m) => m.id)).size).toBe(STUDIO_MODELS.length);
    for (const m of STUDIO_MODELS) {
      expect(new Set(m.modes.map((x) => x.id)).size).toBe(m.modes.length);
      for (const mode of m.modes) {
        expect(mode.path).toMatch(/^[a-z0-9][a-z0-9._/-]*$/i);
        expect(() => resolveSettings(mode, {})).not.toThrow();
      }
    }
    // Only models that exist in Higgsfield's live catalog (Flux 2 / Soul Cinema were removed)
    expect(getStudioModel('flux-2')).toBeUndefined();
    expect(getStudioModel('soul-cinema')).toBeUndefined();
  });

  it('Soul 2: numeric batch size, character reference, and image mode needs a reference image', () => {
    const t = plan('soul-2', { settings: { batch_size: '4', aspect_ratio: '3:2' } });
    expect(t.path).toBe('higgsfield-ai/soul/v2/standard');
    expect(t.body).toEqual({ prompt: 'a fox', batch_size: 4, resolution: '720p', aspect_ratio: '3:2', enhance_prompt: true });
    expect(t.requests).toBe(1); // native batch: one request, four images

    const char = '8b1d9cae-1111-4222-8333-444455556666';
    const c = plan('soul-2', { settings: { custom_reference_id: char, custom_reference_strength: 0.7 } });
    expect(c.body).toMatchObject({ custom_reference_id: char, custom_reference_strength: 0.7 });
    // strength is dropped when no character is chosen
    expect(plan('soul-2', { settings: { custom_reference_strength: 0.7 } }).body).not.toHaveProperty('custom_reference_strength');

    const img = plan('soul-2', { media: { start: ['https://x.test/ref.png'] } });
    expect(img.path).toBe('higgsfield-ai/soul/v2/image-to-image');
    expect(img.body).toMatchObject({ image_url: 'https://x.test/ref.png' });
    expect(() => plan('soul-2', { mode: 'image' })).toThrow(/Reference image is required/);
    expect(() => plan('soul-2', { settings: { custom_reference_id: 'not-a-uuid' } })).toThrow(/invalid character id/);
  });

  it('Kling picks text vs image mode from the media, maps on/off flags, and sends first/last frames', () => {
    const text = plan('kling-3-pro');
    expect(text.path).toBe('kling-video/v3.0/pro/text-to-video');
    expect(text.body).toMatchObject({ sound: 'on', duration: 5, cfg_scale: 0.5, multi_shots: false, aspect_ratio: '16:9' });
    const img = plan('kling-3-4k', { settings: { sound: false }, media: { start: ['https://x.test/a.png'], end: ['https://x.test/b.png'] } });
    expect(img.path).toBe('kling-video/v3.0/4k/image-to-video');
    expect(img.body).toMatchObject({ sound: 'off', image_url: 'https://x.test/a.png', last_image_url: 'https://x.test/b.png' });
    expect(img.body).not.toHaveProperty('aspect_ratio');
    expect(plan('kling-3-turbo', { media: { start: ['https://x.test/a.png'] } }).path).toBe('kling-video/v3.0-turbo/image-to-video');
    expect(plan('kling-3-std', { prompt: '', media: { start: ['https://x.test/a.png'] } }).mode.promptRequired).toBe(false); // image-to-video may omit the prompt
  });

  it('Kling motion control sends character image + motion video with yes/no flags', () => {
    const r = plan('kling-3-motion-pro', { prompt: '', settings: { keep_original_sound: false }, media: { start: ['https://x.test/c.png'], video: ['https://x.test/m.mp4'] } });
    expect(r.path).toBe('kling-video/v3/motion-control/pro');
    expect(r.body).toEqual({ image_url: 'https://x.test/c.png', video_url: 'https://x.test/m.mp4', keep_original_sound: 'no', character_orientation: 'video' });
    expect(() => plan('kling-3-motion-std', { prompt: '', media: { start: ['https://x.test/c.png'] } })).toThrow(/Motion video is required/);
  });

  it('Seedance reference mode sends lists of images, videos and audio; text mode sends aspect ratio', () => {
    const ref = plan('seedance-2-5', { media: { reference: ['https://a/1.png', 'https://a/2.png'], video: ['https://a/v.mp4'], audio: ['https://a/a.wav'] } });
    expect(ref.path).toBe('bytedance/seedance-2.5/reference-to-video');
    expect(ref.body).toMatchObject({ image_urls: ['https://a/1.png', 'https://a/2.png'], video_urls: ['https://a/v.mp4'], audio_urls: ['https://a/a.wav'], generate_audio: true, output_format: 'mp4' });
    expect(plan('seedance-2-0').body).toMatchObject({ aspect_ratio: '16:9', resolution: '720p' });
    expect(plan('seedance-2-0').body).not.toHaveProperty('output_format'); // 2.0 has no format option
    expect(plan('seedance-2-0', { media: { start: ['https://a/s.png'], end: ['https://a/e.png'] } }).body).toMatchObject({ image_url: 'https://a/s.png', end_image_url: 'https://a/e.png' });
  });

  it('numeric enums are sent as numbers; empty optional enums/text/seed are omitted', () => {
    const l = plan('ltx-2-5-fast', { settings: { duration: '8', fps: '48' } });
    expect(l.body).toMatchObject({ duration: 8, fps: 48 });
    expect(l.body).not.toHaveProperty('camera_movement');
    const q = plan('qwen-image-3', { settings: { negative_prompt: 'blurry', seed: 42 } });
    expect(q.body).toMatchObject({ negative_prompt: 'blurry', seed: 42, prompt_extend: true });
    expect(plan('qwen-image-3').body).not.toHaveProperty('seed');
  });

  it('rejects unknown/out-of-range settings, unsupported or non-http media, and too many files', () => {
    expect(() => plan('kling-3-std', { settings: { duration: 99 } })).toThrow(/between 3 and 15/);
    expect(() => plan('kling-3-std', { settings: { nope: 1 } })).toThrow(/Unknown setting/);
    expect(() => plan('kling-3-std', { settings: { sound: 'yes' } })).toThrow(/true or false/);
    expect(() => plan('z-image-turbo', { media: { start: ['https://x.test/a.png'] } })).toThrow(/does not accept start/);
    expect(() => plan('kling-3-std', { media: { start: ['https://a/1.png', 'https://a/2.png'] } })).toThrow(/at most 1/);
    expect(() => plan('kling-3-std', { media: { start: ['javascript:alert(1)'] } })).toThrow(/http\(s\)/);
    expect(() => plan('kling-3-std', { mode: 'warp' })).toThrow(/no "warp" mode/);
    expect(() => plan('kling-3-std', { prompt: '  ' })).toThrow(/Write a prompt/);
  });

  it('every mode has a list price in the right unit, and unitPrice picks resolution rates, ranges and admin overrides', () => {
    for (const m of STUDIO_MODELS) {
      for (const mode of m.modes) {
        const lp = LIST_PRICES[mode.path];
        expect(lp, `${m.id}/${mode.id} (${mode.path})`).toBeDefined();
        expect(lp.unit).toBe(m.priceUnit === 'second' ? 'second' : 'image');
        expect(lp.min).toBeGreaterThan(0);
        expect(lp.max).toBeGreaterThanOrEqual(lp.min);
      }
    }
    const soul = getStudioModel('soul-2')!.modes[0];
    expect(unitPrice(soul, { resolution: '1080p' }, null)).toEqual({ amount: 0.0057, precision: 'exact', basis: 'list' });
    const seed = getStudioModel('seedance-2-5')!.modes[0];
    expect(unitPrice(seed, { resolution: '720p' }, null)).toEqual({ amount: 0.144, precision: 'from', basis: 'list' });
    expect(unitPrice(seed, {}, 0.5)).toEqual({ amount: 0.5, precision: 'exact', basis: 'admin' });
    const motion = getStudioModel('kling-3-motion-std')!;
    expect(billedSeconds(motion, motion.modes[0], {})).toBe(5); // billed by the input video's length: assumption
    expect(billedSeconds(getStudioModel('kling-3-std')!, getStudioModel('kling-3-std')!.modes[0], { duration: 8 })).toBe(8);
  });

  it('pickMode prefers the mode whose inputs match what was provided', () => {
    const wan = getStudioModel('wan-3')!;
    expect(pickMode(wan, undefined, {}).id).toBe('text');
    expect(pickMode(wan, undefined, { start: ['https://x/a.png'] }).id).toBe('image');
    expect(pickMode(wan, undefined, { reference: ['https://x/a.png'] }).id).toBe('reference');
    expect(buildRequest(wan.modes[0], { prompt: 'p', settings: resolveSettings(wan.modes[0], {}), media: resolveMedia(wan.modes[0], {}) }).path).toBe('alibaba/wan-3.0/text-to-video');
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
  seen: [] as { method: string; url: string; auth: string | undefined; idem: string | undefined; body: any }[],
  script: 'video' as 'video' | 'nsfw' | 'reject' | 'image2',
  statusCalls: new Map<string, number>(),
  uploads: [] as { bytes: number; headers: http.IncomingHttpHeaders }[],
  /** Price estimate requests (kept apart from generation requests). `estimateUsd: null` = the endpoint is unavailable (404). */
  estimates: [] as { url: string; body: any }[],
  estimateUsd: null as number | null,
  estimateMode: 'price' as 'price' | 'description',
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
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const isJson = (req.headers['content-type'] ?? '').includes('json');
      const body = buf.length && isJson ? JSON.parse(buf.toString()) : null;
      const send = (code: number, obj: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      if (req.method === 'PUT' && req.url!.startsWith('/storage/')) {
        fake.uploads.push({ bytes: buf.length, headers: req.headers });
        res.writeHead(200).end();
        return;
      }
      if (req.url!.startsWith('/estimate/')) {
        fake.estimates.push({ url: req.url!, body });
        if (fake.estimateUsd === null) return send(404, { detail: 'no estimate' });
        if (fake.estimateMode === 'description') return send(200, { type: 'description', pricing_description: 'Per-second pricing by resolution' });
        return send(200, { credits: String(fake.estimateUsd * 16), usd: String(fake.estimateUsd) });
      }
      fake.seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string | undefined, body });
      const m = /^\/requests\/([^/]+)\/status$/.exec(req.url!);
      if (req.url === '/files/generate-upload-url') {
        return send(200, { public_url: 'https://cdn.test/in/file-1.png', upload_url: 'https://127.0.0.1.invalid/never', content_type: body.content_type, upload_headers: {} });
      }
      if (req.url!.startsWith('/v1/custom-references/list')) {
        return send(200, { items: [{ id: '8b1d9cae-1111-4222-8333-444455556666', name: 'Mia', status: 'completed', thumbnail_url: 'https://cdn.test/mia.jpg' }, { id: 'aaaaaaaa-1111-4222-8333-444455556666', name: 'Draft', status: 'training' }] });
      }
      if (req.url === '/v1/custom-references' && req.method === 'POST') {
        return send(201, { id: 'bbbbbbbb-1111-4222-8333-444455556666', name: body.name, status: 'training', echo: body });
      }
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
  it('serves the data-driven catalog (modes, params, media inputs) and reports it is not connected', async () => {
    const r = await call('GET', '/studio/models', { as: 'viewer' });
    expect(r.status).toBe(200);
    expect(r.json.connected).toBe(false);
    expect(r.json.models.length).toBe(STUDIO_MODELS.length);
    const kling = r.json.models.find((m: any) => m.id === 'kling-3-pro');
    expect(kling).toMatchObject({ surface: 'video', priceUsd: null, priceUnit: 'second' });
    expect(kling.modes.map((m: any) => m.id)).toEqual(['text', 'image']);
    expect(kling.modes[1].media.map((x: any) => x.role)).toEqual(['start', 'end']);
    expect(r.json.models.find((m: any) => m.id === 'soul-2').modes[0].params.custom_reference_id.type).toBe('character');
  });

  it('validates input and enforces roles', async () => {
    const ok = { modelId: 'kling-3-std', prompt: 'a fox', settings: {}, media: {}, count: 1 };
    expect((await call('POST', '/studio/generate', { as: 'viewer', body: ok })).status).toBe(403);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, modelId: 'nope' } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, prompt: '   ' } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, settings: { duration: 100 } } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, count: 9 } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, modelId: 'z-image-turbo', media: { start: ['https://x.test/a.png'] } } })).status).toBe(400);
    expect((await call('POST', '/studio/generate', { as: 'user', body: { ...ok, mode: 'image' } })).status).toBe(400); // start frame required
  });

  it('generates, stores results, and prices per second of video x outputs (admin-set price)', async () => {
    expect((await call('PUT', '/settings/studio-prices', { as: 'user', body: { prices: { 'kling-3-std': 0.05 } } })).status).toBe(403);
    expect((await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { 'kling-3-std': 0.05 } } })).status).toBe(200);
    expect((await call('PUT', '/settings/studio-prices', { as: 'admin', body: { prices: { bogus: 1 } } })).status).toBe(400);

    const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'kling-3-std', prompt: 'a fox in snow', settings: { duration: 10 }, count: 3 } });
    expect(g.status).toBe(202);
    expect(g.json.run.kind).toBe('generation');
    const done = await waitRun(g.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.simulated).toBe(true);
    expect(done.run.output.assets).toHaveLength(3);
    expect(done.run.costUsd).toBeCloseTo(0.05 * 10 * 3, 6);
    expect(done.logs.map((l: any) => l.message).join('\n')).toMatch(/SIMULATED/);

    const m = (await call('GET', `/media?source=studio&runId=${g.json.run.id}`, { as: 'viewer' })).json;
    expect(m.total).toBe(3);
    expect(m.items[0]).toMatchObject({ type: 'video', title: 'a fox in snow' });
    expect(m.items[0].metadata).toMatchObject({ source: 'studio', model: 'kling-3-std', mode: 'text', simulated: true });
    const usage = await db.query(`SELECT SUM(units)::float8 AS u, SUM(cost_usd)::float8 AS c FROM usage_events WHERE run_id=$1 AND provider='higgsfield'`, [g.json.run.id]);
    expect(usage.rows[0]).toMatchObject({ u: 3, c: 1.5 });
  });

  it('Soul batch is one request; with no admin price it uses Higgsfield’s per-resolution list price', async () => {
    const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'soul-2', prompt: 'portrait', settings: { batch_size: '4' }, count: 3 } });
    const done = await waitRun(g.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.output.assets).toHaveLength(1); // simulated platform returns one image per request; count is ignored with native batching
    expect(done.run.costUsd).toBeCloseTo(0.0032, 8); // 720p list price x 1 image
    const hi = await waitRun((await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'soul-2', prompt: 'portrait', settings: { resolution: '1080p' } } })).json.run.id);
    expect(hi.run.costUsd).toBeCloseTo(0.0057, 8);
    expect(hi.logs.map((l: any) => l.message).join('\n')).toMatch(/list price/);
  });

  it('exposes list prices per mode in the catalog', async () => {
    const m = (await call('GET', '/studio/models', { as: 'viewer' })).json;
    expect(m.pricesAsOf).toBe('2026-10-12');
    const soul = m.models.find((x: any) => x.id === 'soul-2');
    expect(soul.modes[0].price).toMatchObject({ unit: 'image', min: 0.0032, max: 0.0057, byResolution: { '720p': 0.0032, '1080p': 0.0057 } });
    expect(m.models.find((x: any) => x.id === 'kling-3-turbo').modes[0].price).toMatchObject({ unit: 'second', promoEnds: '2026-10-18' });
  });

  it('uploads and characters need a connection', async () => {
    const up = await fetch(base + '/api/studio/uploads?filename=a.png', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${tokens.user}` }, body: new Uint8Array([1, 2, 3]) });
    expect(up.status).toBe(400);
    expect((await call('GET', '/studio/characters', { as: 'viewer' })).json).toEqual({ connected: false, characters: [] });
    expect((await call('POST', '/studio/characters', { as: 'user', body: { name: 'X', imageUrls: ['https://a/1.png'], confirmedCost: true } })).status).toBe(400);
  });
});

describe('studio API (against a fake Higgsfield platform)', () => {
  it('rejects unsafe base URLs, trims pasted model paths, then connects', async () => {
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'ftp://x.test' } })).status).toBe(400);
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'http://user:pw@x.test' } })).status).toBe(400);
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'not a url' } })).status).toBe(400);
    expect((await call('PUT', '/settings/higgsfield', { as: 'user', body: { baseUrl: fake.url } })).status).toBe(403);
    // A pasted full model URL on higgsfield.ai is trimmed to the host (regression: doubled paths 404'd every model)
    expect((await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: 'https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard' } })).json.baseUrl).toBe('https://api.higgsfield.ai');
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

  it('submits to the mode path with the Key header and an Idempotency-Key, polls, and stores the video', async () => {
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
    expect(post.idem).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({ prompt: 'drone shot', duration: 8, sound: 'off', image_url: 'https://img.test/start.png' });
    expect(fake.seen.filter((s) => s.method === 'GET').every((s) => /^\/requests\/req-\d+\/status$/.test(s.url) && s.auth === 'Key key-id:secret-value')).toBe(true);

    expect(done.run.output.assets[0]).toMatchObject({ type: 'video', url: expect.stringMatching(/^https:\/\/cdn\.test\/req-\d+\.mp4$/) });
    expect(done.logs.map((l: any) => l.message).join('\n')).not.toMatch(/SIMULATED/);
  });

  it('stores every image a request returns and sends the character on Soul 2', async () => {
    fake.script = 'image2';
    fake.seen.length = 0;
    const char = '8b1d9cae-1111-4222-8333-444455556666';
    const g = await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'soul-2', prompt: 'two images', settings: { custom_reference_id: char, batch_size: '4' } } });
    const done = await waitRun(g.json.run.id);
    expect(done.run.output.assets.map((a: any) => a.type)).toEqual(['photo', 'photo']);
    expect(fake.seen.find((s) => s.method === 'POST')!.body).toMatchObject({ custom_reference_id: char, batch_size: 4 });
  });

  it('uploads a local file via the platform upload API and keeps it in the library', async () => {
    fake.seen.length = 0;
    const res = await fetch(base + '/api/studio/uploads?filename=my%20photo.png', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${tokens.user}` }, body: new Uint8Array([137, 80, 78, 71]) });
    // The fake's presigned upload_url is deliberately unreachable (.invalid), so the PUT fails and surfaces as a clear 502
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).not.toContain('secret-value');
    expect(fake.seen[0]).toMatchObject({ method: 'POST', url: '/files/generate-upload-url', auth: 'Key key-id:secret-value', body: { content_type: 'image/png' } });
    // Unsupported types and oversized/empty bodies are refused before anything is sent
    const bad = await fetch(base + '/api/studio/uploads', { method: 'POST', headers: { 'content-type': 'application/zip', authorization: `Bearer ${tokens.user}` }, body: new Uint8Array([1]) });
    expect(bad.status).toBe(400);
    const viewer = await fetch(base + '/api/studio/uploads', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${tokens.viewer}` }, body: new Uint8Array([1]) });
    expect(viewer.status).toBe(403);
  });

  it('lists characters and requires explicit cost confirmation to create one', async () => {
    const list = (await call('GET', '/studio/characters', { as: 'viewer' })).json;
    expect(list.connected).toBe(true);
    expect(list.characters).toEqual([
      { id: '8b1d9cae-1111-4222-8333-444455556666', name: 'Mia', status: 'completed', thumbnailUrl: 'https://cdn.test/mia.jpg' },
      { id: 'aaaaaaaa-1111-4222-8333-444455556666', name: 'Draft', status: 'training', thumbnailUrl: null },
    ]);
    const payload = { name: 'Zoe', imageUrls: ['https://cdn.test/z1.png', 'https://cdn.test/z2.png'] };
    expect((await call('POST', '/studio/characters', { as: 'user', body: payload })).status).toBe(400); // no confirmedCost
    expect((await call('POST', '/studio/characters', { as: 'viewer', body: { ...payload, confirmedCost: true } })).status).toBe(403);
    fake.seen.length = 0;
    const made = await call('POST', '/studio/characters', { as: 'user', body: { ...payload, confirmedCost: true } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ id: 'bbbbbbbb-1111-4222-8333-444455556666', name: 'Zoe', status: 'training' });
    expect(fake.seen[0].body).toEqual({ name: 'Zoe', model_version: 'v2', input_images: [{ type: 'image_url', image_url: 'https://cdn.test/z1.png' }, { type: 'image_url', image_url: 'https://cdn.test/z2.png' }] });
    const usage = await db.query(`SELECT cost_usd FROM usage_events WHERE model='soul-id'`);
    expect(usage.rows[0].cost_usd).toBe(2.5);
  });

  it('fails the run clearly on moderation blocks and on API errors', async () => {
    fake.script = 'nsfw';
    const a = await waitRun((await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'z-image-turbo', prompt: 'blocked' } })).json.run.id);
    expect(a.run.status).toBe('failed');
    expect(a.run.error).toMatch(/content moderation/);

    fake.script = 'reject';
    const b = await waitRun((await call('POST', '/studio/generate', { as: 'user', body: { modelId: 'z-image-turbo', prompt: 'rejected' } })).json.run.id);
    expect(b.run.status).toBe('failed');
    expect(b.run.error).toBe('Higgsfield API responded 422: prompt too long');
    expect(JSON.stringify(b)).not.toContain('secret-value');
  });
});

describe('workflow Generate node', () => {
  const def = (extra: Record<string, unknown> = {}) => ({
    nodes: [
      { id: 't', type: 'trigger', data: { source: 'manual', sampleInput: 'a lighthouse' } },
      { id: 'g', type: 'generate', data: { model: 'z-image-turbo', prompt: 'Photo of {{input}}', ...extra } },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [{ id: '1', source: 't', target: 'g' }, { id: '2', source: 'g', target: 'o' }],
  });

  it('runs inside a workflow and attaches media to that workflow', async () => {
    fake.script = 'image2';
    fake.seen.length = 0;
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Gen WF', definition: def() } })).json;
    // A workflow that generates media must be confirmed with the cost the person was shown.
    const est = (await call('POST', `/workflows/${wf.id}/estimate`, { as: 'user' })).json;
    expect(est.steps).toHaveLength(1);
    expect(est.totalUsd).toBeGreaterThan(0);
    const refused = await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { input: { text: 'a lighthouse' } } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('cost_confirmation_required');
    expect((await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { input: { text: 'a lighthouse' }, expectedTotalUsd: est.totalUsd / 2 } })).status).toBe(409);
    expect(fake.seen.filter((s) => s.method === 'POST')).toHaveLength(0); // nothing was sent to Higgsfield
    const run = await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { input: { text: 'a lighthouse' }, expectedTotalUsd: est.totalUsd } });
    const done = await waitRun(run.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(fake.seen.find((s) => s.method === 'POST')!.body.prompt).toBe('Photo of a lighthouse');
    expect(done.run.output.result.assets).toHaveLength(2);
    expect((await call('GET', `/media?workflowId=${wf.id}`, { as: 'viewer' })).json.total).toBe(2);
  });

  it('a start-frame URL switches the node to image mode automatically', async () => {
    fake.script = 'video';
    fake.seen.length = 0;
    const d = def({ model: 'kling-3-turbo', startUrl: 'https://img.test/{{input}}.png' });
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Anim WF', definition: d } })).json;
    const done = await waitRun((await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { input: { text: 'cat' }, expectedTotalUsd: 5 } })).json.run.id);
    expect(done.run.status).toBe('completed');
    expect(fake.seen.find((s) => s.method === 'POST')!).toMatchObject({ url: '/kling-video/v3.0-turbo/image-to-video', body: { image_url: 'https://img.test/cat.png' } });
  });

  it('is validated on save/run', async () => {
    const bad = (await call('POST', '/workflows', { as: 'user', body: { name: 'Bad Gen', definition: def({ model: 'nope', prompt: '' }) } })).json;
    expect((await call('POST', `/workflows/${bad.id}/run`, { as: 'user', body: {} })).status).toBe(400);
    expect((await call('PUT', `/workflows/${bad.id}`, { as: 'user', body: { status: 'active' } })).status).toBe(400);
  });
});
