import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

describe('a take whose video is kept on this computer', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let tmp = '';
  let projectId = '';
  let takeId = '';
  const was = config.filesDir;
  const key = crypto.createHash('sha256').update('https://example.invalid/original.mp4').digest('hex');
  const bytes = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251));
  const call = (token: string, url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const json = async <T>(r: Response) => (await r.json()) as T;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-media-'));
    config.filesDir = tmp;
    fs.writeFileSync(path.join(tmp, key), bytes);
    fs.writeFileSync(path.join(tmp, `${key}.type`), 'video/mp4');
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = await json<{ role: string; token: string }[]>(await fetch(base + '/api/dev/users'));
    admin = users.find((u) => u.role === 'admin')!.token;
    projectId = (await json<{ id: string }>(await call(admin, '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Local', type: 'micro_drama' }) }))).id;
    const item = (await json<{ id: string }[]>(await call(admin, `/api/projects/${projectId}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'S1', group: 'Ep 1 · Scene 1' }) })))[0];
    const org = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
    takeId = (
      await db.query<{ id: string }>(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata) VALUES ($1,'video','S1 · recovered','local:file','data:image/jpeg;base64,AAAA',ARRAY['studio','recovered'],$2::jsonb) RETURNING id`,
        [org, JSON.stringify({ source: 'studio', projectId, itemId: item.id, localKey: key })],
      )
    ).rows[0].id;
    // an ordinary take keeps its own address
    await db.query(`INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata) VALUES ($1,'video','plain','https://cdn.example/x.mp4','data:image/jpeg;base64,AAAA',ARRAY['studio'],$2::jsonb)`, [org, JSON.stringify({ source: 'studio', projectId, itemId: item.id })]);
  });
  afterAll(async () => {
    config.filesDir = was;
    await new Promise((r) => server.close(r));
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('shows the shot a signed address instead of the stored marker, and leaves ordinary takes alone', async () => {
    const snap = await json<{ items: { takes: { id: string; url: string; title: string }[] }[] }>(await call(admin, `/api/projects/${projectId}`));
    const takes = snap.items[0].takes;
    const mine = takes.find((t) => t.id === takeId)!;
    expect(mine.url).toMatch(new RegExp(`^/api/media/local/${takeId}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    expect(takes.find((t) => t.title === 'plain')!.url).toBe('https://cdn.example/x.mp4');
    expect(JSON.stringify(snap)).not.toContain(key); // the file's name on disk is not handed to the page
  });

  it('plays the file through that address, including the partial requests a video player makes', async () => {
    const snap = await json<{ items: { takes: { id: string; url: string }[] }[] }>(await call(admin, `/api/projects/${projectId}`));
    const url = snap.items[0].takes.find((t) => t.id === takeId)!.url;
    const full = await fetch(base + url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);
    const part = await fetch(base + url, { headers: { Range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);
  });

  it('refuses a changed, expired or borrowed link, and a take with no file', async () => {
    const snap = await json<{ items: { takes: { id: string; url: string }[] }[] }>(await call(admin, `/api/projects/${projectId}`));
    const url = snap.items[0].takes.find((t) => t.id === takeId)!.url;
    expect((await fetch(base + url.replace(/sig=./, 'sig=0'))).status).toBe(403);
    expect((await fetch(base + url.replace(/exp=\d+/, 'exp=1'))).status).toBe(403);
    expect((await fetch(`${base}/api/media/local/${takeId}`)).status).toBe(403); // no signature at all
    const ordinary = (await db.query<{ id: string }>(`SELECT id FROM media_assets WHERE title='plain'`)).rows[0].id;
    const { signMediaLink } = await import('../src/services/sourceLinks');
    expect((await fetch(base + signMediaLink(ordinary))).status).toBe(404); // a valid link for an item that has no local file
    fs.rmSync(path.join(tmp, key));
    expect((await fetch(base + url)).status).toBe(404); // the file went missing
  });

  it('also gives the Media page a playable address', async () => {
    fs.writeFileSync(path.join(tmp, key), bytes);
    const list = await json<{ items: { id: string; url: string }[] }>(await call(admin, '/api/media?limit=100'));
    expect(list.items.find((m) => m.id === takeId)!.url).toMatch(/^\/api\/media\/local\//);
  });

  it('never serves a file outside the saved copies, whatever the stored name says', async () => {
    const org = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
    const evil = (await db.query<{ id: string }>(`INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata) VALUES ($1,'video','evil','x','x',ARRAY['x'],$2::jsonb) RETURNING id`, [org, JSON.stringify({ localKey: '..\\..\\..\\Windows\\win.ini' })])).rows[0].id;
    const { signMediaLink } = await import('../src/services/sourceLinks');
    expect((await fetch(base + signMediaLink(evil))).status).toBe(404);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('a picture for a take whose video is kept on this computer', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let tmp = '';
  let projectId = '';
  let videoTake = '';
  let photoTake = '';
  const was = config.filesDir;
  const json = async <T>(r: Response) => (await r.json()) as T;
  const call = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const keyFor = (name: string) => crypto.createHash('sha256').update(name).digest('hex');

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-thumb-'));
    config.filesDir = tmp;
    const vkey = keyFor('video'), pkey = keyFor('photo');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=270x480:d=3:r=10', '-pix_fmt', 'yuv420p', '-f', 'mp4', path.join(tmp, vkey)]);
    if (made.status !== 0) throw new Error(String(made.stderr));
    fs.writeFileSync(path.join(tmp, `${vkey}.type`), 'video/mp4');
    const photo = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', path.join(tmp, pkey)]);
    if (photo.status !== 0) throw new Error(String(photo.stderr));
    fs.writeFileSync(path.join(tmp, `${pkey}.type`), 'image/jpeg');
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = (await json<{ role: string; token: string }[]>(await fetch(base + '/api/dev/users'))).find((u) => u.role === 'admin')!.token;
    projectId = (await json<{ id: string }>(await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Thumbs', type: 'micro_drama' }) }))).id;
    const item = (await json<{ id: string }[]>(await call(`/api/projects/${projectId}/items`, { method: 'POST', body: JSON.stringify({ title: 'S1', group: 'Ep 1 · Scene 1' }) })))[0];
    const org = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
    const row = async (type: string, key: string) =>
      (await db.query<{ id: string }>(`INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata) VALUES ($1,$2,'t','local:x','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',ARRAY['x'],$3::jsonb) RETURNING id`, [org, type, JSON.stringify({ projectId, itemId: item.id, localKey: key })])).rows[0].id;
    videoTake = await row('video', vkey);
    photoTake = await row('photo', pkey);
  });
  afterAll(async () => {
    config.filesDir = was;
    await new Promise((r) => server.close(r));
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('hands the page a signed thumbnail address instead of the stored generic picture', async () => {
    const snap = await json<{ items: { takes: { id: string; thumbUrl: string }[] }[] }>(await call(`/api/projects/${projectId}`));
    for (const id of [videoTake, photoTake]) {
      expect(snap.items[0].takes.find((t) => t.id === id)!.thumbUrl).toMatch(new RegExp(`^/api/media/local/${id}/thumb\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    }
  });

  it('makes a real picture from the video once, keeps it, and gives a photo back as itself', async () => {
    const snap = await json<{ items: { takes: { id: string; thumbUrl: string }[] }[] }>(await call(`/api/projects/${projectId}`));
    const url = snap.items[0].takes.find((t) => t.id === videoTake)!.thumbUrl;
    const res = await fetch(base + url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // a JPEG
    expect(fs.existsSync(path.join(tmp, `${keyFor('video')}.thumb.jpg`))).toBe(true); // kept for next time
    expect((await fetch(base + url)).status).toBe(200);
    const photoUrl = snap.items[0].takes.find((t) => t.id === photoTake)!.thumbUrl;
    expect(Buffer.from(await (await fetch(base + photoUrl)).arrayBuffer()).equals(fs.readFileSync(path.join(tmp, keyFor('photo'))))).toBe(true);
  });

  it('refuses a changed or missing signature, and the video link is not a thumbnail link', async () => {
    const snap = await json<{ items: { takes: { id: string; url: string; thumbUrl: string }[] }[] }>(await call(`/api/projects/${projectId}`));
    const take = snap.items[0].takes.find((t) => t.id === videoTake)!;
    expect((await fetch(base + take.thumbUrl.replace(/sig=./, 'sig=0'))).status).toBe(403);
    expect((await fetch(`${base}/api/media/local/${videoTake}/thumb`)).status).toBe(403);
    // a signature made for playing the video does not open the picture route
    const play = new URL(base + take.url);
    expect((await fetch(`${base}/api/media/local/${videoTake}/thumb${play.search}`)).status).toBe(403);
  });
});