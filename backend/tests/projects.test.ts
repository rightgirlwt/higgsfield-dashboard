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
