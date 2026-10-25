import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { historyForApi } from '../src/services/director';

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

async function waitRun(id: string) {
  for (let i = 0; i < 300; i++) {
    const r = (await call('GET', `/runs/${id}`, { as: 'user' })).json;
    if (['completed', 'failed'].includes(r.run.status)) return r;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

/** A scripted stand-in for the Anthropic Messages API. */
const anth = {
  server: null as http.Server | null,
  queue: [] as any[],
  requests: [] as any[],
};
const message = (content: any[], stop_reason: string, usage = { input_tokens: 1000, output_tokens: 200 }) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason, stop_sequence: null,
  usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

beforeAll(async () => {
  anth.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      anth.requests.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      const next = anth.queue.shift();
      res.writeHead(next ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next ?? { type: 'error', error: { type: 'api_error', message: 'script exhausted' } }));
    });
  });
  await new Promise<void>((r) => anth.server!.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(anth.server!.address() as AddressInfo).port}`;

  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
  for (const u of users) tokens[u.role] = u.token;
}, 60_000);

afterAll(async () => {
  server.close();
  anth.server?.close();
  delete process.env.ANTHROPIC_BASE_URL;
  await db.close();
});

let drama: any;
let ad: any;

describe('projects', () => {
  it('lists the two project types and creates projects (writers only), with a blank brief per type', async () => {
    const types = (await call('GET', '/projects/types', { as: 'viewer' })).json;
    expect(types.map((t: any) => t.id)).toEqual(['micro_drama', 'ad_campaign']);
    expect(types[0]).toMatchObject({ itemKind: 'shot', groupLabel: 'Scene', defaultAspect: '9:16' });

    expect((await call('POST', '/projects', { as: 'viewer', body: { name: 'X', type: 'micro_drama' } })).status).toBe(403);
    expect((await call('POST', '/projects', { as: 'user', body: { name: 'X', type: 'podcast' } })).status).toBe(400);
    drama = (await call('POST', '/projects', { as: 'user', body: { name: 'Last Train', type: 'micro_drama' } })).json;
    ad = (await call('POST', '/projects', { as: 'user', body: { name: 'Spring Launch', type: 'ad_campaign', budgetUsd: 50 } })).json;
    expect(drama).toMatchObject({ type: 'micro_drama', aspect: '9:16', budgetUsd: 0 });
    expect(Object.keys(drama.brief)).toContain('logline');
    expect(Object.keys(ad.brief)).toContain('product');

    const list = (await call('GET', '/projects', { as: 'viewer' })).json;
    expect(list.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Last Train', 'Spring Launch']));
  });

  it('updates the brief (only known fields) and the budget', async () => {
    const ok = await call('PUT', `/projects/${drama.id}`, { as: 'user', body: { brief: { logline: 'A stranger on the last train knows too much.' }, budgetUsd: 20 } });
    expect(ok.status).toBe(200);
    expect(ok.json.brief.logline).toMatch(/last train/);
    expect(ok.json.budgetUsd).toBe(20);
    expect(Object.keys(ok.json.brief)).toContain('characters'); // untouched fields remain
    expect((await call('PUT', `/projects/${drama.id}`, { as: 'user', body: { brief: { nonsense: 'x' } } })).status).toBe(400);
    expect((await call('GET', `/projects/${'0'.repeat(8)}-0000-4000-8000-000000000000`, { as: 'user' })).status).toBe(404);
  });
});

describe('board items', () => {
  let item1: any;
  let item2: any;

  it('validates items against the model catalog and saves nothing from a bad batch', async () => {
    const bad = await call('POST', `/projects/${drama.id}/items`, {
      as: 'user',
      body: { items: [{ title: 'Fine', prompt: 'p', modelId: 'kling-3-std' }, { title: 'Too long', prompt: 'p', modelId: 'kling-3-std', settings: { duration: 99 } }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/Item 2 \("Too long"\).*between 3 and 15/);
    expect((await call('GET', `/projects/${drama.id}`, { as: 'user' })).json.items).toHaveLength(0);
    expect((await call('POST', `/projects/${drama.id}/items`, { as: 'user', body: { title: 'X', modelId: 'nope' } })).status).toBe(400);
    expect((await call('POST', `/projects/${drama.id}/items`, { as: 'viewer', body: { title: 'X' } })).status).toBe(403);
  });

  it('adds items in order with estimates, and keeps un-modelled cards as plans', async () => {
    const r = await call('POST', `/projects/${drama.id}/items`, {
      as: 'user',
      body: {
        items: [
          { group: 'Ep 1 · Scene 1', title: 'Platform', prompt: 'A lone woman on an empty platform, fluorescent light', modelId: 'kling-3-std', settings: { duration: 5 } },
          { group: 'Ep 1 · Scene 1', title: 'Keyframe', prompt: 'Close-up portrait, tired eyes', modelId: 'soul-2' },
          { group: 'Ep 1 · Scene 2', title: 'Planned only' },
        ],
      },
    });
    expect(r.status).toBe(201);
    [item1, item2] = r.json;
    expect(r.json.map((i: any) => i.kind)).toEqual(['shot', 'shot', 'shot']);
    expect(r.json.map((i: any) => i.position)).toEqual([0, 1, 2]);

    const snap = (await call('GET', `/projects/${drama.id}`, { as: 'viewer' })).json;
    const byTitle = Object.fromEntries(snap.items.map((i: any) => [i.title, i]));
    expect(byTitle.Platform.estimate).toMatchObject({ ok: true, seconds: 5, model: expect.any(String) });
    expect(byTitle.Platform.estimate.costUsd).toBeCloseTo(byTitle.Platform.estimate.unitUsd * 5, 8);
    expect(byTitle.Keyframe.estimate.costUsd).toBeCloseTo(0.0032, 8); // Soul 720p list price x 1 image
    expect(byTitle['Planned only'].estimate).toMatchObject({ ok: false, reason: expect.stringMatching(/model/i) });
    expect(snap.totalEstimateUsd).toBeCloseTo(byTitle.Platform.estimate.costUsd + 0.0032, 8);
  });

  it('switching models clears settings the new model would reject; editing an unreviewed ready item resets it to draft', async () => {
    const r = await call('PUT', `/projects/${drama.id}/items/${item1.id}`, { as: 'user', body: { modelId: 'seedance-2-0' } });
    expect(r.status).toBe(200);
    expect(r.json.settings).toEqual({});
    await db.query(`UPDATE project_items SET status='ready' WHERE id=$1`, [item1.id]);
    const edited = await call('PUT', `/projects/${drama.id}/items/${item1.id}`, { as: 'user', body: { prompt: 'New wording' } });
    expect(edited.json.status).toBe('draft');
    await call('PUT', `/projects/${drama.id}/items/${item1.id}`, { as: 'user', body: { modelId: 'kling-3-std', settings: { duration: 5 } } });
  });

  it('keeps items inside their own project', async () => {
    expect((await call('PUT', `/projects/${ad.id}/items/${item1.id}`, { as: 'user', body: { title: 'hijack' } })).status).toBe(404);
    expect((await call('DELETE', `/projects/${ad.id}/items/${item1.id}`, { as: 'user' })).status).toBe(404);
  });

  it('reorders and duplicates', async () => {
    const snap = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
    const ids = snap.items.map((i: any) => i.id).reverse();
    expect((await call('PUT', `/projects/${drama.id}/items/reorder`, { as: 'user', body: { ids } })).status).toBe(200);
    const after = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
    expect(after.items.map((i: any) => i.id)).toEqual(ids);
    const dup = await call('POST', `/projects/${drama.id}/items/${item1.id}/duplicate`, { as: 'user' });
    expect(dup.status).toBe(201);
    expect(dup.json.title).toBe('Platform (copy)');
    await call('DELETE', `/projects/${drama.id}/items/${dup.json.id}`, { as: 'user' });
  });

  describe('generation (approval gate, budget, takes)', () => {
    it('refuses unless the approved total covers the real cost, then generates and files the takes under the item', async () => {
      const est = (await call('POST', `/projects/${drama.id}/estimate`, { as: 'user', body: { ids: [item1.id] } })).json;
      expect(est.totalUsd).toBeGreaterThan(0);

      const low = await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [item1.id], expectedTotalUsd: est.totalUsd / 2 } });
      expect(low.status).toBe(409);
      expect(low.json.error.message).toMatch(/more than the/);
      expect((await call('POST', `/projects/${drama.id}/generate`, { as: 'viewer', body: { ids: [item1.id], expectedTotalUsd: 99 } })).status).toBe(403);
      expect((await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [item1.id] } })).status).toBe(400); // total is mandatory
      const unmodelled = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json.items.find((i: any) => i.title === 'Planned only');
      const blocked = await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [unmodelled.id], expectedTotalUsd: 5 } });
      expect(blocked.status).toBe(400);
      expect(blocked.json.error.message).toMatch(/Planned only/);

      const go = await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [item1.id], expectedTotalUsd: est.totalUsd } });
      expect(go.status).toBe(202);
      expect(go.json.runs).toHaveLength(1);
      expect(go.json.totalUsd).toBeCloseTo(est.totalUsd, 8);
      const midway = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json.items.find((i: any) => i.id === item1.id);
      expect(['generating', 'review']).toContain(midway.status);
      if (midway.status === 'generating') expect((await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [item1.id], expectedTotalUsd: 99 } })).status).toBe(409);

      const done = await waitRun(go.json.runs[0].id);
      expect(done.run.status).toBe('completed');
      expect(done.run.refId).toBe(item1.id);
      expect(done.run.input).toMatchObject({ projectId: drama.id, itemId: item1.id });
      expect(done.run.costUsd).toBeCloseTo(est.totalUsd, 8);

      const snap = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
      const it1 = snap.items.find((i: any) => i.id === item1.id);
      expect(it1.status).toBe('review');
      expect(it1.takes).toHaveLength(1);
      expect(it1.takes[0]).toMatchObject({ type: 'video', itemId: item1.id });
      expect(snap.spend.generationUsd).toBeCloseTo(est.totalUsd, 8);
    });

    it('approving a take sets the status; a take from another item is refused; rejecting clears it', async () => {
      const snap = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
      const take = snap.items.find((i: any) => i.id === item1.id).takes[0];
      const stranger = await db.query(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, metadata) SELECT org_id,'photo','x','https://x.test/o.png','https://x.test/o.png','{"projectId":"p","itemId":"other"}'::jsonb FROM projects WHERE id=$1 RETURNING id`,
        [drama.id],
      );
      expect((await call('PUT', `/projects/${drama.id}/items/${item1.id}`, { as: 'user', body: { approvedAssetId: stranger.rows[0].id } })).status).toBe(400);
      const ok = await call('PUT', `/projects/${drama.id}/items/${item1.id}`, { as: 'user', body: { approvedAssetId: take.id } });
      expect(ok.json).toMatchObject({ status: 'approved', approvedAssetId: take.id });
      const rej = await call('PUT', `/projects/${drama.id}/items/${item1.id}`, { as: 'user', body: { status: 'rejected' } });
      expect(rej.json).toMatchObject({ status: 'rejected', approvedAssetId: null });
    });

    it('stops a batch that would take the project over budget (402), without queueing anything', async () => {
      const before = (await db.query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE kind='generation'`)).rows[0].n;
      await call('PUT', `/projects/${drama.id}`, { as: 'user', body: { budgetUsd: 0.01 } });
      const est = (await call('POST', `/projects/${drama.id}/estimate`, { as: 'user', body: { ids: [item1.id] } })).json;
      expect(est.budgetLeftUsd).toBeLessThan(est.totalUsd);
      const r = await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [item1.id], expectedTotalUsd: est.totalUsd } });
      expect(r.status).toBe(402);
      expect(r.json.error).toMatchObject({ code: 'over_budget' });
      expect((await db.query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE kind='generation'`)).rows[0].n).toBe(before);
      await call('PUT', `/projects/${drama.id}`, { as: 'user', body: { budgetUsd: 0 } }); // 0 = no cap
    });

    it('a shot that starts from another shot uses that shot\'s image, and is blocked until one exists', async () => {
      const [anim] = (await call('POST', `/projects/${drama.id}/items`, {
        as: 'user',
        body: { items: [{ title: 'Animate keyframe', prompt: 'she turns slowly', modelId: 'kling-3-turbo', settings: { duration: 3 }, meta: { startFromItemId: item2.id } }] },
      })).json;
      expect(anim.mode).toBe('');
      const est = (await call('POST', `/projects/${drama.id}/estimate`, { as: 'user', body: { ids: [anim.id] } })).json;
      expect(est.estimates[0]).toMatchObject({ ok: true, mode: expect.stringMatching(/image/i) }); // priced as image-to-video before the frame exists
      const none = await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [anim.id], expectedTotalUsd: est.totalUsd } });
      expect(none.status).toBe(400);
      expect(none.json.error.message).toMatch(/no image yet/);

      await db.query(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, metadata) SELECT org_id,'photo','kf','https://cdn.test/keyframe.png','https://cdn.test/keyframe.png',$2::jsonb FROM projects WHERE id=$1`,
        [drama.id, JSON.stringify({ projectId: drama.id, itemId: item2.id })],
      );
      const go = await call('POST', `/projects/${drama.id}/generate`, { as: 'user', body: { ids: [anim.id], expectedTotalUsd: est.totalUsd } });
      expect(go.status).toBe(202);
      const done = await waitRun(go.json.runs[0].id);
      expect(done.run.input.media.start).toEqual(['https://cdn.test/keyframe.png']);
      expect(done.run.status).toBe('completed');
    });
  });
});

describe('ad variants', () => {
  let base: any;
  it('previews the cost of a hooks x formats matrix, then creates it', async () => {
    base = (await call('POST', `/projects/${ad.id}/items`, {
      as: 'user',
      body: { group: 'Concept A', title: 'Morning ritual', prompt: 'A hand lifts the bottle beside a sunlit sink. {{hook}}', modelId: 'kling-3-std', settings: { duration: 5 } },
    })).json[0];
    const single = (await call('POST', `/projects/${ad.id}/estimate`, { as: 'user', body: { ids: [base.id] } })).json.totalUsd;
    const body = { baseItemId: base.id, hooks: ['Stop scrolling', 'Meet your new routine', 'Two minutes a day'], aspects: ['9:16', '1:1'] };
    const preview = await call('POST', `/projects/${ad.id}/variants`, { as: 'user', body });
    expect(preview.status).toBe(200);
    expect(preview.json.count).toBe(6);
    expect(preview.json.totalUsd).toBeCloseTo(single * 6, 8);
    expect(preview.json.created).toEqual([]); // preview saves nothing
    expect(preview.json.preview[0]).toMatchObject({ hook: 'Stop scrolling', aspect: '9:16' });

    expect((await call('GET', `/projects/${ad.id}`, { as: 'user' })).json.items).toHaveLength(1);
    const made = await call('POST', `/projects/${ad.id}/variants`, { as: 'user', body: { ...body, create: true } });
    expect(made.json.created).toHaveLength(6);
    const first = made.json.created[0];
    expect(first.prompt).toContain('Stop scrolling'); // {{hook}} substituted
    expect(first.prompt).not.toContain('{{hook}}');
    expect(first.settings.aspect_ratio).toBe('9:16');
    expect(first.kind).toBe('ad_unit');
    expect(first.meta).toMatchObject({ hook: 'Stop scrolling', aspect: '9:16', variantOf: base.id });
  });

  it('refuses a format the model cannot make, and an over-large matrix', async () => {
    const bad = await call('POST', `/projects/${ad.id}/variants`, { as: 'user', body: { baseItemId: base.id, aspects: ['4:5'] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/can't make 4:5/);
    const hooks = Array.from({ length: 20 }, (_, i) => `hook ${i}`);
    const huge = await call('POST', `/projects/${ad.id}/variants`, { as: 'user', body: { baseItemId: base.id, hooks, aspects: ['9:16', '1:1', '16:9', '9:16'] } });
    expect(huge.status).toBe(400);
    expect(huge.json.error.message).toMatch(/limit is 60/);
  });
});

describe('reference assets', () => {
  it('stores characters (with a Soul ID) and products, and validates ids and URLs', async () => {
    const mia = await call('POST', `/projects/${drama.id}/assets`, { as: 'user', body: { kind: 'character', name: 'Mia', characterId: '8b1d9cae-1111-4222-8333-444455556666', notes: 'Late 20s, red coat' } });
    expect(mia.status).toBe(201);
    expect(mia.json).toMatchObject({ kind: 'character', characterId: '8b1d9cae-1111-4222-8333-444455556666' });
    expect((await call('POST', `/projects/${drama.id}/assets`, { as: 'user', body: { kind: 'character', name: 'X', characterId: 'nope' } })).status).toBe(400);
    expect((await call('POST', `/projects/${drama.id}/assets`, { as: 'user', body: { kind: 'logo', name: 'X', url: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await call('POST', `/projects/${drama.id}/assets`, { as: 'user', body: { kind: 'product', name: 'X', mediaId: '0'.repeat(8) + '-0000-4000-8000-000000000000' } })).status).toBe(404);
    const upd = await call('PUT', `/projects/${drama.id}/assets/${mia.json.id}`, { as: 'user', body: { notes: 'Now with a scar' } });
    expect(upd.json).toMatchObject({ name: 'Mia', notes: 'Now with a scar' });
    expect((await call('DELETE', `/projects/${ad.id}/assets/${mia.json.id}`, { as: 'user' })).status).toBe(404); // other project
    expect((await call('DELETE', `/projects/${drama.id}/assets/${mia.json.id}`, { as: 'user' })).status).toBe(204);
  });

  it('replacing an asset image also replaces the old link on the shots that use it', async () => {
    const old = 'https://d3snorpfx4xhv8.cloudfront.net/org/old-face.png';
    const fresh = 'https://d3snorpfx4xhv8.cloudfront.net/org/new-face.png';
    const asset = await call('POST', `/projects/${drama.id}/assets`, { as: 'user', body: { kind: 'character', name: 'Nya', url: old } });
    const shot = await call('POST', `/projects/${drama.id}/items`, { as: 'user', body: { group: 'Ep 9', title: 'Uses Nya', prompt: 'She turns', modelId: 'kling-3-std', mode: 'image', media: { start: [old] } } });
    expect(shot.status).toBe(201);
    const other = await call('POST', `/projects/${drama.id}/items`, { as: 'user', body: { group: 'Ep 9', title: 'Other face', prompt: 'He turns', modelId: 'kling-3-std', mode: 'image', media: { start: ['https://x.test/other.png'] } } });
    await call('PUT', `/projects/${drama.id}/assets/${asset.json.id}`, { as: 'user', body: { url: fresh } });
    const snap = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
    const byTitle = Object.fromEntries(snap.items.map((i: any) => [i.title, i]));
    expect(byTitle['Uses Nya'].media.start).toEqual([fresh]);
    expect(byTitle['Other face'].media.start).toEqual(['https://x.test/other.png']);
    void other;
    await call('DELETE', `/projects/${drama.id}/assets/${asset.json.id}`, { as: 'user' });
  });
});

describe('director chat (Claude with tools)', () => {
  it('without an Anthropic key it says so and changes nothing', async () => {
    const r = await call('POST', `/projects/${drama.id}/chat`, { as: 'user', body: { message: 'Plan episode 1' } });
    expect(r.status).toBe(200);
    expect(r.json.simulated).toBe(true);
    expect(r.json.messages.at(-1).blocks[0].text).toMatch(/SIMULATED/);
    await call('DELETE', `/projects/${drama.id}/chat`, { as: 'user' });
  });

  it('runs a tool-use loop: edits the brief and board, can only request approval (never generate), and bills the chat to the project', async () => {
    expect((await call('PUT', '/settings/secrets/anthropic', { as: 'admin', body: { value: 'sk-ant-test-key-12345678' } })).status).toBe(200);
    const runsBefore = (await db.query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE kind='generation'`)).rows[0].n;
    anth.requests.length = 0;
    anth.queue.push(
      message(
        [
          { type: 'text', text: 'Let me set up the bible and a first shot.' },
          { type: 'tool_use', id: 'tu_1', name: 'update_brief', input: { fields: { logline: 'A stranger on the last train knows too much.', genre: 'Thriller' } } },
          { type: 'tool_use', id: 'tu_2', name: 'add_items', input: { items: [{ group: 'Ep 1 · Scene 1', title: 'Opening', prompt: 'Empty train carriage at night', modelId: 'kling-3-std', settings: { duration: 5 } }] } },
          { type: 'tool_use', id: 'tu_3', name: 'add_items', input: { items: [{ title: 'Broken', prompt: 'x', modelId: 'does-not-exist' }] } },
        ],
        'tool_use',
      ),
    );
    anth.queue.push(message([{ type: 'text', text: 'Done: one shot added. The second call failed, so I will fix it.' }], 'end_turn', { input_tokens: 2500, output_tokens: 100 }));

    const r = await call('POST', `/projects/${drama.id}/chat`, { as: 'user', body: { message: 'Start episode 1 for me' } });
    expect(r.status).toBe(200);
    expect(r.json.simulated).toBe(false);
    expect(r.json.changed).toMatchObject({ board: true, brief: true });
    expect(r.json.costUsd).toBeGreaterThan(0);

    // what Claude was given: cached instructions, the live project snapshot, and no way to spend
    const first = anth.requests[0];
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(first.system[1].text).toContain('Last Train');
    expect(first.system[1].text).toContain('Platform'); // existing board cards appear in the snapshot
    expect(first.tools.map((t: any) => t.name)).not.toEqual(expect.arrayContaining(['generate']));
    expect(first.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['list_models', 'add_items', 'request_approval', 'create_workflow']));
    expect(first.messages.at(-1).content[0].text).toBe('Start episode 1 for me');
    // the second request carried the tool results back, with the failure flagged
    const results = anth.requests[1].messages.at(-1).content;
    expect(results.map((b: any) => b.tool_use_id)).toEqual(['tu_1', 'tu_2', 'tu_3']);
    expect(results[0].is_error).toBeUndefined();
    expect(results[2].is_error).toBe(true);
    expect(results[2].content).toMatch(/Studio model|does-not-exist/);

    const proj = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
    expect(proj.project.brief.genre).toBe('Thriller');
    expect(proj.items.map((i: any) => i.title)).toContain('Opening');
    expect(proj.items.map((i: any) => i.title)).not.toContain('Broken');
    expect(proj.spend.chatUsd).toBeCloseTo(r.json.costUsd, 8);
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE kind='generation'`)).rows[0].n).toBe(runsBefore); // chat generated nothing

    // the UI view: text and one chip per tool call; raw tool results are hidden
    const view = (await call('GET', `/projects/${drama.id}/chat`, { as: 'viewer' })).json.messages;
    expect(view.map((m: any) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const chips = view[1].blocks.filter((b: any) => b.type === 'tool');
    expect(chips.map((c: any) => c.error)).toEqual([false, false, true]);
    expect(chips[0].summary).toMatch(/Updated 2 brief fields/);
  });

  it('request_approval marks cards ready but generates nothing; workflows are saved as drafts linked to the project', async () => {
    const proj = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
    const opening = proj.items.find((i: any) => i.title === 'Opening');
    anth.requests.length = 0;
    anth.queue.push(
      message(
        [
          { type: 'tool_use', id: 'a1', name: 'request_approval', input: { ids: [opening.id] } },
          {
            type: 'tool_use', id: 'a2', name: 'create_workflow',
            input: {
              name: 'Episode 1 render', description: 'Renders the opening',
              definition: {
                nodes: [
                  { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { source: 'manual' } },
                  { id: 'g', type: 'generate', position: { x: 280, y: 0 }, data: { model: 'kling-3-std', prompt: 'Empty train carriage at night' } },
                  { id: 'o', type: 'output', position: { x: 560, y: 0 }, data: {} },
                ],
                edges: [{ id: 'e1', source: 't', target: 'g' }, { id: 'e2', source: 'g', target: 'o' }],
              },
            },
          },
        ],
        'tool_use',
      ),
    );
    anth.queue.push(message([{ type: 'text', text: 'Ready for you to approve.' }], 'end_turn'));
    const r = await call('POST', `/projects/${drama.id}/chat`, { as: 'user', body: { message: 'Queue it up and make a workflow' } });
    expect(r.json.changed).toMatchObject({ board: true, workflows: true });
    const after = (await call('GET', `/projects/${drama.id}`, { as: 'user' })).json;
    expect(after.items.find((i: any) => i.id === opening.id).status).toBe('ready');
    expect(after.workflows).toHaveLength(1);
    const wf = (await db.query(`SELECT status, project_id FROM workflows WHERE name='Episode 1 render'`)).rows[0];
    expect(wf).toMatchObject({ status: 'draft', project_id: drama.id });
    const toolResult = JSON.parse(anth.requests[1].messages.at(-1).content[0].content);
    expect(toolResult.note).toMatch(/Nothing has been generated/);
  });

  it('surfaces an upstream Claude error in the conversation instead of failing the request', async () => {
    anth.queue.length = 0; // script exhausted -> fake returns 500
    const r = await call('POST', `/projects/${drama.id}/chat`, { as: 'user', body: { message: 'hello?' } });
    expect(r.status).toBe(200);
    expect(r.json.messages.at(-1).blocks[0].text).toMatch(/Something went wrong/);
  }, 30_000);

  it('chat is a write: viewers cannot send, but can read', async () => {
    expect((await call('POST', `/projects/${drama.id}/chat`, { as: 'viewer', body: { message: 'hi' } })).status).toBe(403);
    expect((await call('GET', `/projects/${drama.id}/chat`, { as: 'viewer' })).status).toBe(200);
  });

  it('clearing the chat removes the history', async () => {
    expect((await call('DELETE', `/projects/${drama.id}/chat`, { as: 'user' })).status).toBe(204);
    expect((await call('GET', `/projects/${drama.id}/chat`, { as: 'user' })).json.messages).toEqual([]);
  });
});

describe('history sent back to Claude', () => {
  const row = (id: number, role: 'user' | 'assistant', content: any[]) => ({ id, role, content, cost_usd: 0, created_at: new Date() });
  it('starts at a plain user message and drops a tool call that never got its result', () => {
    const h = historyForApi([
      row(1, 'user', [{ type: 'tool_result', tool_use_id: 'old', content: '{}' }]),
      row(2, 'user', [{ type: 'text', text: 'hi' }]),
      row(3, 'assistant', [{ type: 'text', text: 'hello' }]),
      row(4, 'user', [{ type: 'text', text: 'do it' }]),
      row(5, 'assistant', [{ type: 'tool_use', id: 'x', name: 'get_project', input: {} }]),
    ]);
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const ok = historyForApi([
      row(1, 'user', [{ type: 'text', text: 'do it' }]),
      row(2, 'assistant', [{ type: 'tool_use', id: 'x', name: 'get_project', input: {} }]),
      row(3, 'user', [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }]),
      row(4, 'assistant', [{ type: 'text', text: 'done' }]),
    ]);
    expect(ok).toHaveLength(4);
  });
});

describe('workflows in a project (cards, for-each, cost gate)', () => {
  let proj: any;
  let wfCards: any;
  const cardsDef = {
    nodes: [
      { id: 't', type: 'trigger', data: { source: 'project', statuses: ['draft'] } },
      { id: 'f', type: 'foreach', data: { mode: 'cards', maxItems: 10, concurrency: 2 } },
      { id: 'o', type: 'output', data: {} },
    ],
    edges: [{ id: '1', source: 't', target: 'f' }, { id: '2', source: 'f', target: 'o' }],
  };

  it('a workflow can only belong to a project in the same organisation', async () => {
    proj = (await call('POST', '/projects', { as: 'user', body: { name: 'Workflow Lab', type: 'micro_drama' } })).json;
    const bad = await call('POST', '/workflows', { as: 'user', body: { name: 'x', projectId: '0'.repeat(8) + '-0000-4000-8000-000000000000' } });
    expect(bad.status).toBe(404);
    wfCards = (await call('POST', '/workflows', { as: 'user', body: { name: 'Render cards', projectId: proj.id, definition: cardsDef } })).json;
    expect(wfCards.projectId).toBe(proj.id);
    const links = (await call('GET', `/projects/${proj.id}`, { as: 'user' })).json.workflows;
    expect(links.map((w: any) => w.id)).toContain(wfCards.id);
  });

  it('refuses to run until every card can be generated, then prices the cards the trigger would pick up', async () => {
    await call('POST', `/projects/${proj.id}/items`, {
      as: 'user',
      body: { items: [
        { title: 'A', prompt: 'a lamp', modelId: 'kling-3-std', settings: { duration: 5 } },
        { title: 'B', prompt: 'a door', modelId: 'kling-3-std', settings: { duration: 3 } },
        { title: 'C (no model yet)' },
      ] },
    });
    const blocked = await call('POST', `/workflows/${wfCards.id}/run`, { as: 'user', body: { expectedTotalUsd: 99 } });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.message).toMatch(/can't be generated yet/);
    const c = (await call('GET', `/projects/${proj.id}`, { as: 'user' })).json.items.find((i: any) => i.title.startsWith('C'));
    await call('PUT', `/projects/${proj.id}/items/${c.id}`, { as: 'user', body: { prompt: 'a window', modelId: 'kling-3-std', settings: { duration: 4 } } });
    const est = (await call('POST', `/workflows/${wfCards.id}/estimate`, { as: 'user' })).json;
    expect(est.problems).toEqual([]);
    expect(est.steps[0]).toMatchObject({ items: 3 });
    expect(est.totalUsd).toBeCloseTo((await call('POST', `/projects/${proj.id}/estimate`, { as: 'user', body: {} })).json.totalUsd, 8);
  });

  it('the project budget stops a workflow run (402) before anything is queued', async () => {
    const est = (await call('POST', `/workflows/${wfCards.id}/estimate`, { as: 'user' })).json;
    await call('PUT', `/projects/${proj.id}`, { as: 'user', body: { budgetUsd: 0.01 } });
    const r = await call('POST', `/workflows/${wfCards.id}/run`, { as: 'user', body: { expectedTotalUsd: est.totalUsd } });
    expect(r.status).toBe(402);
    expect(r.json.error.code).toBe('over_budget');
    await call('PUT', `/projects/${proj.id}`, { as: 'user', body: { budgetUsd: 0 } });
  });

  it('renders every card with its own settings, moves them to review and files the takes under each card', async () => {
    const est = (await call('POST', `/workflows/${wfCards.id}/estimate`, { as: 'user' })).json;
    const r = await call('POST', `/workflows/${wfCards.id}/run`, { as: 'user', body: { expectedTotalUsd: est.totalUsd } });
    expect(r.status).toBe(202);
    const done = await waitRun(r.json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.costUsd).toBeCloseTo(est.totalUsd, 8);
    const items = (await call('GET', `/projects/${proj.id}`, { as: 'user' })).json.items;
    expect(items.map((i: any) => i.status)).toEqual(['review', 'review', 'review']);
    expect(items.every((i: any) => i.takeCount === 1)).toBe(true);
    // the trigger only selects drafts, so a second run finds nothing to do
    const again = await call('POST', `/workflows/${wfCards.id}/estimate`, { as: 'user' });
    expect(again.json.steps[0].items).toBe(0);
  });

  it('prompt mode: one generation per list item from a template; the cost estimate is a ceiling (maxItems) when the list is unknown', async () => {
    const def = {
      nodes: [
        { id: 't', type: 'trigger', data: { source: 'manual', sampleInput: 'a fox\na heron\na moth' } },
        { id: 'f', type: 'foreach', data: { mode: 'prompt', model: 'z-image-turbo', prompt: 'Photo of {{item}}, style: {{project.brief.visualStyle}}', maxItems: 5 } },
        { id: 'o', type: 'output', data: {} },
      ],
      edges: [{ id: '1', source: 't', target: 'f' }, { id: '2', source: 'f', target: 'o' }],
    };
    await call('PUT', `/projects/${proj.id}`, { as: 'user', body: { brief: { visualStyle: 'warm film grain' } } });
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Prompt each', projectId: proj.id, definition: def } })).json;
    const est = (await call('POST', `/workflows/${wf.id}/estimate`, { as: 'user' })).json;
    expect(est.upTo).toBe(true);
    expect(est.steps[0]).toMatchObject({ items: 5, note: 'up to 5 items' });
    const done = await waitRun((await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { input: { text: 'a fox\na heron\na moth' }, expectedTotalUsd: est.totalUsd } })).json.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.run.output.result.assets).toHaveLength(3); // only the 3 items given were generated
    expect(done.run.costUsd).toBeCloseTo((est.totalUsd / 5) * 3, 8);
    expect(done.logs.map((l: any) => l.message).join('\n')).toMatch(/For each of 3 items/);
  });

  it('{{project.*}} variables resolve in a project workflow, and free workflows need no confirmation', async () => {
    const def = {
      nodes: [
        { id: 't', type: 'trigger', data: { source: 'manual' } },
        { id: 'x', type: 'transform', data: { mode: 'template', template: '{{project.name}} | {{project.aspect}} | {{project.brief.visualStyle}}' } },
        { id: 'o', type: 'output', data: {} },
      ],
      edges: [{ id: '1', source: 't', target: 'x' }, { id: '2', source: 'x', target: 'o' }],
    };
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Vars', projectId: proj.id, definition: def } })).json;
    const done = await waitRun((await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: {} })).json.run.id);
    expect(done.run.output.result).toBe('Workflow Lab | 9:16 | warm film grain');
  });

  it('validates for-each and the project trigger', async () => {
    const v = (data: any, src = 'manual') => call('POST', '/workflows/validate', { as: 'user', body: { definition: { nodes: [{ id: 't', type: 'trigger', data: { source: src } }, { id: 'f', type: 'foreach', data }], edges: [{ id: 'e', source: 't', target: 'f' }] } } });
    expect((await v({ mode: 'prompt' })).json.issues.map((i: any) => i.message)).toEqual(expect.arrayContaining(['For-each needs a prompt template', 'For-each needs a valid Studio model']));
    expect((await v({ mode: 'sideways' })).json.issues.map((i: any) => i.message)).toContain('For-each mode must be "cards" or "prompt"');
    expect((await v({ mode: 'cards', maxItems: 500 })).json.issues.map((i: any) => i.message)).toContain('Max items must be between 1 and 50');
    expect((await v({ mode: 'cards' })).json.issues.filter((i: any) => i.level === 'error')).toEqual([]);
  });

  it('a project-cards workflow outside a project cannot be run', async () => {
    const wf = (await call('POST', '/workflows', { as: 'user', body: { name: 'Orphan', definition: cardsDef } })).json;
    const r = await call('POST', `/workflows/${wf.id}/run`, { as: 'user', body: { expectedTotalUsd: 5 } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/belongs to a project/);
  });

  it('every shipped template is a valid workflow, and project templates install into a project', async () => {
    const { WORKFLOW_TEMPLATES } = await import('../src/services/templates');
    const { validateWorkflow } = await import('../src/services/workflowEngine');
    for (const t of WORKFLOW_TEMPLATES) expect(validateWorkflow(t.definition).filter((i) => i.level === 'error'), t.id).toEqual([]);
    const r = await call('POST', '/workflows/from-template', { as: 'user', body: { templateId: 'polish-then-render', projectId: proj.id } });
    expect(r.status).toBe(201);
    expect(r.json.projectId).toBe(proj.id);
  });

  it('the scheduler skips workflows that would spend money (and says so), but still runs free ones', async () => {
    const { tick } = await import('../src/services/scheduler');
    const sched = (extra: any[]) => ({ nodes: [{ id: 't', type: 'trigger', data: { source: 'schedule', intervalMinutes: 5 } }, ...extra], edges: extra.length ? [{ id: 'e', source: 't', target: extra[0].id }] : [] });
    const spender = (await call('POST', '/workflows', { as: 'user', body: { name: 'Nightly renders', definition: sched([{ id: 'g', type: 'generate', data: { model: 'z-image-turbo', prompt: 'a lamp' } }]) } })).json;
    const free = (await call('POST', '/workflows', { as: 'user', body: { name: 'Nightly note', definition: sched([{ id: 'a', type: 'action', data: { action: 'log', message: 'hi' } }]) } })).json;
    for (const w of [spender, free]) expect((await call('PUT', `/workflows/${w.id}`, { as: 'user', body: { status: 'active' } })).status).toBe(200);
    const before = (await db.query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE ref_id=$1`, [spender.id])).rows[0].n;
    const started = await tick(Date.now() + 3600_000);
    expect(started).toBe(1);
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE ref_id=$1`, [spender.id])).rows[0].n).toBe(before);
    const alert = (await db.query(`SELECT message FROM alerts WHERE kind='schedule_skipped'`)).rows[0];
    expect(alert.message).toMatch(/Nightly renders.*skipped.*generates media/);
    await tick(Date.now() + 3600_000); // a second pass the same day doesn't pile up duplicate alerts
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM alerts WHERE kind='schedule_skipped'`)).rows[0].n).toBe(1);
    for (const w of [spender, free]) await call('PUT', `/workflows/${w.id}`, { as: 'user', body: { status: 'paused' } });
  });
});

describe('export', () => {
  let proj: any;
  let files: http.Server;
  let filesUrl = '';
  const bytes = { a: Buffer.from('FAKE-MP4-A-'.repeat(2000)), b: Buffer.from([1, 2, 3, 4, 5, 250, 251, 252]) };

  beforeAll(async () => {
    files = http.createServer((req, res) => {
      if (req.url === '/a.mp4') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(bytes.a);
      if (req.url === '/b.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(bytes.b);
      res.writeHead(404).end('nope');
    });
    await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
    filesUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
  });
  afterAll(() => void files.close());

  it('only fetches public https addresses (never the server’s own network)', async () => {
    const { isSafeFetchUrl, isPrivateAddress } = await import('../src/services/projectExport');
    for (const bad of ['https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.0.5/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://[fd00::1]/x', 'http://8.8.8.8/x', 'https://user:pw@8.8.8.8/x', 'ftp://8.8.8.8/x', 'not a url', 'https://[::ffff:127.0.0.1]/x']) {
      expect(await isSafeFetchUrl(bad), bad).toBe(false);
    }
    expect(await isSafeFetchUrl('https://8.8.8.8/clip.mp4')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
  });

  it('exports the script, shot list and approved clips in board order, listing anything that could not be fetched', async () => {
    proj = (await call('POST', '/projects', { as: 'user', body: { name: 'Café “Noir” — Ep 1', type: 'micro_drama' } })).json;
    await call('PUT', `/projects/${proj.id}`, { as: 'user', body: { brief: { logline: 'A barista hears a confession.' } } });
    expect((await call('GET', `/projects/${proj.id}/export/clips.zip`, { as: 'user' })).status).toBe(400); // nothing approved yet

    const made = (await call('POST', `/projects/${proj.id}/items`, {
      as: 'user',
      body: { items: [
        { group: 'Ep 1 · Scene 1', title: 'Opening, steam', prompt: 'Steam over a cup', notes: 'VO: "Closing time."', modelId: 'kling-3-std', settings: { duration: 5 } },
        { group: 'Ep 1 · Scene 1', title: 'The confession', prompt: 'Close on her face', modelId: 'soul-2' },
        { group: 'Ep 1 · Scene 2', title: 'Street', prompt: 'Rain on neon', modelId: 'kling-3-std' },
        { group: 'Ep 1 · Scene 2', title: 'Not approved', prompt: 'x', modelId: 'kling-3-std' },
      ] },
    })).json;
    // an approved take per card: two reachable, one that 404s
    const urls = [`${filesUrl}/a.mp4`, `${filesUrl}/b.png`, `${filesUrl}/missing.mp4`];
    for (const [n, url] of urls.entries()) {
      const type = url.endsWith('.png') ? 'photo' : 'video';
      const a = await db.query(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, metadata) SELECT org_id,$2,'t',$3,$3,$4::jsonb FROM projects WHERE id=$1 RETURNING id`,
        [proj.id, type, url, JSON.stringify({ projectId: proj.id, itemId: made[n].id })],
      );
      expect((await call('PUT', `/projects/${proj.id}/items/${made[n].id}`, { as: 'user', body: { approvedAssetId: a.rows[0].id } })).json.status).toBe('approved');
    }

    const md = await fetch(`${base}/api/projects/${proj.id}/export/script.md`, { headers: { authorization: `Bearer ${tokens.viewer}` } });
    expect(md.status).toBe(200);
    expect(md.headers.get('content-disposition')).toMatch(/attachment; filename="cafe-noir-ep-1-script\.md"/);
    const script = await md.text();
    expect(script).toContain('# Café “Noir” — Ep 1');
    expect(script).toContain('A barista hears a confession.');
    expect(script).toMatch(/### Ep 1 · Scene 1[\s\S]*#### Opening, steam\s+`approved`\s+· clip 001/);
    expect(script).toContain('VO: "Closing time."');
    expect(script).toMatch(/#### Not approved\s+`draft`\s*\n/);

    const csvRes = await fetch(`${base}/api/projects/${proj.id}/export/shot-list.csv`, { headers: { authorization: `Bearer ${tokens.viewer}` } });
    const raw = new Uint8Array(await csvRes.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 byte-order mark so Excel reads accents correctly
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);
    const lines = csv.slice(1).trim().split('\n');
    expect(lines[0]).toBe('order,group,title,status,model,mode,prompt,notes,estimated_cost_usd,clip_file,approved_url');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^1,Ep 1 · Scene 1,"Opening, steam",approved,kling-3-std,/);
    expect(lines[1]).toContain('001-ep-1-scene-1-opening-steam.mp4');
    expect(lines[4]).toMatch(/^,Ep 1 · Scene 2,Not approved,draft,/); // unapproved cards have no order or file

    const { unzipSync, strFromU8 } = await import('fflate');
    const res = await fetch(`${base}/api/projects/${proj.id}/export/clips.zip`, { headers: { authorization: `Bearer ${tokens.viewer}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/cafe-noir-ep-1-approved-clips\.zip/);
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(['001-ep-1-scene-1-opening-steam.mp4', '002-ep-1-scene-1-the-confession.png', 'MISSING.txt', 'manifest.csv', 'script.md']);
    expect(Buffer.from(zip['001-ep-1-scene-1-opening-steam.mp4']).equals(bytes.a)).toBe(true);
    expect(Buffer.from(zip['002-ep-1-scene-1-the-confession.png']).equals(bytes.b)).toBe(true);
    expect(strFromU8(zip['MISSING.txt'])).toMatch(/003-ep-1-scene-2-street\.mp4: HTTP 404/);
    expect(strFromU8(zip['script.md'])).toContain('# Café “Noir” — Ep 1');
  });

  it('cannot export another project’s files', async () => {
    expect((await call('GET', `/projects/${'0'.repeat(8)}-0000-4000-8000-000000000000/export/script.md`, { as: 'user' })).status).toBe(404);
  });
});
