import { spawnSync } from 'node:child_process';
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
import { signSourceLink, signVaultLink, sourceLinkValid, vaultLinkValid } from '../src/services/sourceLinks';
import { localDay, parseReels, parseSort, playedSize, shotTime } from '../src/services/vault';

describe('when a clip was filmed', () => {
  it('uses the iPhone local time, so an evening clip stays on its own day', () => {
    const t = shotTime({ 'com.apple.quicktime.creationdate': '2026-10-28T21:45:10-0400', creation_time: '2026-10-29T01:45:10.000000Z' });
    expect(t?.day).toBe('2026-10-28');
    expect(t?.at.toISOString()).toBe('2026-10-29T01:45:10.000Z');
  });

  it('falls back to creation_time, and ignores a zeroed one', () => {
    expect(shotTime({ creation_time: '2026-10-28T15:00:00.000000Z' })?.at.toISOString()).toBe('2026-10-28T15:00:00.000Z');
    expect(shotTime({ creation_time: '1970-01-01T00:00:00.000000Z' })).toBeNull();
    expect(shotTime({})).toBeNull();
    expect(shotTime(undefined)).toBeNull();
  });

  it('writes days as YYYY-MM-DD', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('swaps the size of a sideways-stored portrait clip', () => {
    expect(playedSize(1920, 1080, -90)).toEqual({ width: 1080, height: 1920 });
    expect(playedSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('reading what Claude said', () => {
  it('turns a sort answer into one of the Vault folders, with clean tags', () => {
    expect(parseSort('Sure! {"folder":"desk","tags":[" Laptop ","laptop","COFFEE"],"description":" Types at a desk. "}')).toEqual({ folder: 'Desk', tags: ['laptop', 'coffee'], description: 'Types at a desk.' });
    expect(parseSort('{"folder":"Beach day","tags":[],"description":""}')?.folder).toBe('Other');
    expect(parseSort('no json here')).toBeNull();
    expect(parseSort('{"folder":5}')).toBeNull();
  });

  const catalog = [
    { key: 'c1', id: 'id-1', durationSec: 10 },
    { key: 'c2', id: 'id-2', durationSec: 2 },
    { key: 'c3', id: 'id-3', durationSec: 30 },
    { key: 'c4', id: 'id-4', durationSec: null },
  ];
  const reel = (beats: unknown[], extra: object = {}) => JSON.stringify([{ title: 'A day', style: 'vlog', day: '2026-10-28', hook: 'Hook', beats, caption: 'Cap', why: 'Why', ...extra }]);

  it('keeps only beats that name a real clip, and never longer than the clip', () => {
    const [r] = parseReels(reel([{ clip: 'c1', line: 'one', seconds: 5 }, { clip: 'c9', line: 'ghost', seconds: 3 }, { clip: 'C2', line: 'two', seconds: 6 }, { clip: 'c3', line: 'three', seconds: 20 }, { clip: 'c4', line: 'four', seconds: 3 }]), catalog);
    expect(r.beats.map((b) => b.clipId)).toEqual(['id-1', 'id-2', 'id-3', 'id-4']);
    expect(r.beats.map((b) => b.seconds)).toEqual([5, 2, 8, 3]);
    expect(r.day).toBe('2026-10-28');
  });

  it('drops a reel with fewer than three real beats, and a topic reel carries no day', () => {
    expect(parseReels(reel([{ clip: 'c1' }, { clip: 'c2' }, { clip: 'c7' }]), catalog)).toEqual([]);
    const [t] = parseReels(reel([{ clip: 'c1' }, { clip: 'c2' }, { clip: 'c3' }], { style: 'topic' }), catalog);
    expect(t.style).toBe('topic');
    expect(t.day).toBeNull();
  });

  it('refuses an answer that is not a list of reels', () => {
    expect(() => parseReels('Here you go!', catalog)).toThrow();
    expect(() => parseReels('[{"title":1}]', catalog)).toThrow();
  });
});

describe('vault links', () => {
  it('never open the other kind of video', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const q = (l: string) => new URL(l, 'http://x').searchParams;
    const v = q(signVaultLink(id));
    expect(vaultLinkValid(id, v.get('exp'), v.get('sig'))).toBe(true);
    expect(sourceLinkValid(id, v.get('exp'), v.get('sig'))).toBe(false);
    const e = q(signSourceLink(id));
    expect(vaultLinkValid(id, e.get('exp'), e.get('sig'))).toBe(false);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('the Vault, end to end', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let member = '';
  let tmp = '';
  let folder = '';
  const wasDir = config.vaultDir;
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const clip = (file: string, color: string, seconds: number, created?: string) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=${seconds}:r=10`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest', ...(created ? ['-metadata', `creation_time=${created}`] : []), '-pix_fmt', 'yuv420p', file]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  };
  const finish = async (jobId: string) => {
    for (let i = 0; i < 100; i++) {
      const j = (await (await call(admin, 'GET', `/vault/jobs/${jobId}`)).json()) as { state: string; added: number; duplicates: number; failed: number };
      if (j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('scan did not finish');
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
    config.vaultDir = path.join(tmp, 'vault');
    folder = path.join(tmp, 'camera roll');
    fs.mkdirSync(path.join(folder, 'trip'), { recursive: true });
    clip(path.join(folder, 'a.mp4'), 'red', 2, '2026-10-27T15:00:00Z');
    fs.copyFileSync(path.join(folder, 'a.mp4'), path.join(folder, 'trip', 'a copy.mp4'));
    clip(path.join(folder, 'b.mp4'), 'blue', 3, '2026-10-28T15:00:00Z');
    clip(path.join(folder, 'trip', 'c.mp4'), 'green', 4, '2026-10-28T18:00:00Z');
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a video');
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
    admin = users.find((u) => u.role === 'admin')!.token;
    member = users.find((u) => u.role === 'user')!.token;
  });
  afterAll(async () => {
    config.vaultDir = wasDir;
    await new Promise((r) => server.close(r));
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('only the admin login can read a folder on this computer', async () => {
    expect((await call(member, 'POST', '/vault/scan', { folder })).status).toBe(403);
    expect((await call(admin, 'POST', '/vault/scan', { folder: 'relative/path' })).status).toBe(400);
    expect((await call(admin, 'POST', '/vault/scan', { folder: path.join(tmp, 'nope') })).status).toBe(400);
  });

  it('reads every video in a folder and its sub-folders, and catches the copy', async () => {
    const res = await call(admin, 'POST', '/vault/scan', { folder });
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: string; total: number };
    expect(job.total).toBe(4); // the .txt file is ignored
    expect(await finish(job.id)).toMatchObject({ state: 'done', added: 3, duplicates: 1, failed: 0 });

    const stats = (await (await call(admin, 'GET', '/vault/stats')).json()) as { clips: number; duplicates: number; unsorted: number; days: number };
    expect(stats).toMatchObject({ clips: 3, duplicates: 1, unsorted: 3, days: 2 });

    // scanning again adds nothing: every file is already known
    const again = (await (await call(admin, 'POST', '/vault/scan', { folder })).json()) as { id: string; total: number };
    expect(again.total).toBe(0);
  });

  it('groups clips by the day they were filmed and keeps the file name, length and thumbnail', async () => {
    const days = (await (await call(admin, 'GET', '/vault/days')).json()) as { day: string; clips: number; thumbs: string[] }[];
    expect(days.map((d) => [d.day, d.clips])).toEqual([['2026-10-28', 2], ['2026-10-27', 1]]); // newest day first
    expect(days[0].thumbs[0]).toMatch(/^data:image\/jpeg;base64,/);
    const list = (await (await call(admin, 'GET', `/vault/clips?day=${days[0].day}`)).json()) as { items: { name: string; durationSec: number; hasSound: boolean; width: number; height: number }[]; total: number };
    expect(list.total).toBe(2);
    expect(list.items.map((c) => c.name).sort()).toEqual(['b.mp4', 'c.mp4']);
    expect(list.items[0]).toMatchObject({ hasSound: true, width: 160, height: 90 });
    const dupes = (await (await call(admin, 'GET', '/vault/clips?duplicates=only')).json()) as { items: { name: string }[] };
    expect(dupes.items.map((c) => c.name)).toEqual(['a copy.mp4']);
  });

  it('files a clip by hand, which also counts as sorted, and finds it by search', async () => {
    const list = (await (await call(admin, 'GET', '/vault/clips?q=b.mp4')).json()) as { items: { id: string }[] };
    expect(list.items).toHaveLength(1);
    const id = list.items[0].id;
    expect((await call(admin, 'PATCH', `/vault/clips/${id}`, { folder: 'Beach' })).status).toBe(400);
    const done = await call(admin, 'PATCH', `/vault/clips/${id}`, { folder: 'Desk', tags: ['Laptop', 'laptop', 'Coffee'], description: 'Opens the laptop' });
    expect(await done.json()).toMatchObject({ folder: 'Desk', tags: ['laptop', 'coffee'], sorted: true });
    const found = (await (await call(admin, 'GET', '/vault/clips?q=coffee')).json()) as { total: number };
    expect(found.total).toBe(1);
    expect(((await (await call(admin, 'GET', '/vault/stats')).json()) as { folders: unknown[] }).folders).toEqual([{ folder: 'Desk', n: 1 }]);
  });

  it('quotes the price of sorting and of reel ideas without spending, and does not run on a missing key', async () => {
    const q = (await (await call(member, 'POST', '/vault/sort', { approved: false })).json()) as { approved: boolean; clips: number; estimateUsd: number; maxUsd: number; model: string };
    expect(q).toMatchObject({ approved: false, clips: 2, model: 'claude-haiku-5-5' });
    expect(q.estimateUsd).toBeGreaterThan(0);
    expect(q.maxUsd).toBeGreaterThanOrEqual(q.estimateUsd);
    const key = ((await (await call(member, 'POST', '/vault/sort', { approved: false })).json()) as { keyMissing: boolean }).keyMissing;
    if (key) expect((await call(member, 'POST', '/vault/sort', { approved: true })).status).toBe(400);
    // only one clip is sorted, so there is not enough to plan reels from
    expect((await call(member, 'POST', '/vault/reels/suggest', { approved: false })).status).toBe(400);
  });

  it('signs a link that plays the clip, and refuses a forged one', async () => {
    const list = (await (await call(admin, 'GET', '/vault/clips?q=c.mp4')).json()) as { items: { id: string }[] };
    const id = list.items[0].id;
    const { url } = (await (await call(admin, 'GET', `/vault/clips/${id}/stream-url`)).json()) as { url: string };
    const ok = await fetch(base + url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/video/);
    expect((await fetch(base + url.replace(/sig=\w{4}/, 'sig=0000'))).status).toBe(403);
    expect((await fetch(`${base}/api/vault/clip/${id}`)).status).toBe(403);
  });

  it('removing a clip from a scanned folder never deletes the file', async () => {
    const list = (await (await call(admin, 'GET', '/vault/clips?q=c.mp4')).json()) as { items: { id: string }[] };
    expect((await call(admin, 'DELETE', `/vault/clips/${list.items[0].id}`)).status).toBe(204);
    expect(fs.existsSync(path.join(folder, 'trip', 'c.mp4'))).toBe(true);
    expect((await call(admin, 'DELETE', `/vault/clips/${list.items[0].id}`)).status).toBe(404);
  });

  it('takes an upload, using the browser\'s last-modified time when the video has none, and catches a re-upload', async () => {
    const file = path.join(tmp, 'up.mp4');
    clip(file, 'yellow', 2);
    const body = fs.readFileSync(file);
    const send = () => fetch(`${base}/api/vault/upload?filename=up.mp4&modified=${Date.UTC(2026, 5, 15, 16, 0, 0)}`, { method: 'POST', headers: { Authorization: `Bearer ${member}`, 'Content-Type': 'video/mp4' }, body });
    const first = await send();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ duplicate: false });
    expect(await (await send()).json()).toMatchObject({ duplicate: true });
    const bad = await fetch(`${base}/api/vault/upload?filename=x.pdf`, { method: 'POST', headers: { Authorization: `Bearer ${member}`, 'Content-Type': 'application/pdf' }, body: Buffer.from('x') });
    expect(bad.status).toBe(415);
    const june = (await (await call(member, 'GET', '/vault/clips?day=2026-06-15')).json()) as { items: { name: string; source: string }[] };
    expect(june.items).toMatchObject([{ name: 'up.mp4', source: 'upload' }]);
  });
});
