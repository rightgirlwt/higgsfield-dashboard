import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { parseSuggested, requestToAdjustments } from '../src/services/beats';

let db: Db;
let server: http.Server;
let base = '';
const tokens: Record<string, string> = {};
let dir = '';
const wasDir = config.editDir;
let videoId = '';

async function call(method: string, p: string, as: string, body?: unknown) {
  const res = await fetch(base + '/api' + p, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[as]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beats-'));
  config.editDir = dir;
  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
  for (const u of users) tokens[u.role] = u.token;
  // Any bytes will do: beats only need the video to exist
  const up = await fetch(base + '/api/edit/videos?filename=clip.mp4', { method: 'POST', headers: { 'content-type': 'video/mp4', authorization: `Bearer ${tokens.user}` }, body: Buffer.from('not really a video') });
  videoId = (await up.json()).id;
});
afterAll(async () => {
  config.editDir = wasDir;
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('beats', () => {
  it('turns each line of a change request into a checklist item', () => {
    const items = requestToAdjustments('- Adjust caption timing\n2. Shorten the b-roll clip; Hold the card longer\n\n');
    expect(items.map((i) => i.text)).toEqual(['Adjust caption timing', 'Shorten the b-roll clip', 'Hold the card longer']);
    expect(items.every((i) => !i.done && i.id)).toBe(true);
  });

  it('reads Claude\'s suggested beats, dropping bad ranges and trimming to the video length', () => {
    const text = 'Here you go:\n```json\n[{"title":"Hook","startSec":0,"endSec":4,"youSay":"Hi"},{"title":"Bad","startSec":6,"endSec":6},{"title":"Tip","startSec":4,"endSec":99,"youSay":"x"}]\n```';
    expect(parseSuggested(text, 10)).toEqual([
      { title: 'Hook', startSec: 0, endSec: 4, youSay: 'Hi' },
      { title: 'Tip', startSec: 4, endSec: 10, youSay: 'x' },
    ]);
    expect(() => parseSuggested('no beats here', 10)).toThrow();
  });

  it('lets the team add beats, lists them in time order, and rejects a beat that ends before it starts', async () => {
    expect((await call('POST', `/edit/videos/${videoId}/beats`, 'user', { title: 'Tip 1', startSec: 5, endSec: 9 })).status).toBe(201);
    expect((await call('POST', `/edit/videos/${videoId}/beats`, 'user', { title: 'Hook', startSec: 0, endSec: 5, youSay: 'Here are three things' })).status).toBe(201);
    expect((await call('POST', `/edit/videos/${videoId}/beats`, 'user', { title: 'Bad', startSec: 4, endSec: 4 })).status).toBe(400);
    const list = (await call('GET', `/edit/videos/${videoId}/beats`, 'user')).json;
    expect(list.map((b: { title: string }) => b.title)).toEqual(['Hook', 'Tip 1']);
    expect(list[0]).toMatchObject({ status: 'draft', youSay: 'Here are three things', adjustments: [] });
  });

  it('knows nothing about a video that does not exist', async () => {
    expect((await call('GET', '/edit/videos/11111111-1111-4111-8111-111111111111/beats', 'user')).status).toBe(404);
  });

  it('review: only the admin approves or sends a beat back; the team resolves the checklist and resubmits', async () => {
    const [hook] = (await call('GET', `/edit/videos/${videoId}/beats`, 'user')).json;
    expect((await call('POST', `/edit/beats/${hook.id}/approve`, 'user')).status).toBe(403);
    expect((await call('POST', `/edit/beats/${hook.id}/request-changes`, 'user', { request: 'x' })).status).toBe(403);
    expect((await call('POST', `/edit/beats/${hook.id}/request-changes`, 'admin', { request: '   ' })).status).toBe(400);

    const asked = (await call('POST', `/edit/beats/${hook.id}/request-changes`, 'admin', { request: 'Adjust caption timing\nShorten broll clip' })).json;
    expect(asked.status).toBe('changes_needed');
    expect(asked.adjustments.map((a: { text: string }) => a.text)).toEqual(['Adjust caption timing', 'Shorten broll clip']);

    const done = (await call('PATCH', `/edit/beats/${hook.id}/adjustments/${asked.adjustments[0].id}`, 'user', { done: true })).json;
    expect(done.adjustments[0].done).toBe(true);
    expect(done.adjustments[1].done).toBe(false);

    expect((await call('POST', `/edit/beats/${hook.id}/submit`, 'user')).json.status).toBe('in_review');
    const ok = (await call('POST', `/edit/beats/${hook.id}/approve`, 'admin')).json;
    expect(ok.status).toBe('approved');
    expect(ok.changeRequest).toBe('');
  });

  it('puts an approved beat back to draft when it is edited, because the approval was for the old version', async () => {
    const [hook] = (await call('GET', `/edit/videos/${videoId}/beats`, 'user')).json;
    expect(hook.status).toBe('approved');
    const edited = (await call('PATCH', `/edit/beats/${hook.id}`, 'user', { onScreen: '3 THINGS I DID TO NEGOTIATE' })).json;
    expect(edited).toMatchObject({ status: 'draft', onScreen: '3 THINGS I DID TO NEGOTIATE' });
    expect((await call('PATCH', `/edit/beats/${hook.id}`, 'user', { startSec: 6, endSec: 2 })).status).toBe(400);
  });

  it('keeps the chosen effects and label with the video so both editors see the same edit', async () => {
    const plan = { steps: [{ fx: 'backdrop-word', start: 0, end: 3, text: 'NEGOTIATE', options: { color: '#99577a' } }], label: { enabled: true, text: 'DRAMATIZATION' } };
    expect((await call('PUT', `/edit/videos/${videoId}/plan`, 'user', plan)).status).toBe(200);
    const videos = (await call('GET', '/edit/videos', 'admin')).json as { id: string; plan?: typeof plan }[];
    expect(videos.find((v) => v.id === videoId)?.plan).toEqual({ ...plan, broll: [] }); // no B-roll chosen, so an empty list is kept
  });

  it('lists each video with its beat roll-up, who added it, and lets the team rename it', async () => {
    const before = (await call('GET', '/edit/videos', 'user')).json.find((v: { id: string }) => v.id === videoId);
    expect(before.beats.total).toBe(2);
    expect(before.beats.draft + before.beats.approved + before.beats.in_review + before.beats.changes_needed).toBe(2);
    expect(before.addedBy).toBeTruthy();
    const renamed = (await call('PATCH', `/edit/videos/${videoId}`, 'user', { title: '  Milo   negotiation tips ' })).json;
    expect(renamed.title).toBe('Milo negotiation tips');
  });

  it('deletes a beat', async () => {
    const list = (await call('GET', `/edit/videos/${videoId}/beats`, 'user')).json;
    expect((await call('DELETE', `/edit/beats/${list[1].id}`, 'user')).status).toBe(204);
    expect((await call('GET', `/edit/videos/${videoId}/beats`, 'user')).json).toHaveLength(1);
  });
});
