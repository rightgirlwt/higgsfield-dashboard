import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { exifTime, kindOfFile, sortTokens, targetPath } from '../src/services/vault';

// What Claude "answers" when sorting: the folder follows the file's name, and every call is written down.
const calls: { user: string; images: number }[] = [];
vi.mock('../src/services/secrets', async (orig) => ({ ...(await orig<typeof import('../src/services/secrets')>()), getSecret: async () => 'test-key' }));
vi.mock('../src/services/claude', () => ({
  runPrompt: async (_org: string, p: { model: string; user: string; images?: unknown[] }) => {
    calls.push({ user: p.user, images: p.images?.length ?? 0 });
    const name = /File: (.*)/.exec(p.user)?.[1] ?? '';
    const folder = /selfie/.test(name) ? 'Selfies & portraits' : /shot/.test(name) ? 'Screenshots' : /dated/.test(name) ? 'Outdoors' : name.startsWith('a.') ? 'Desk' : 'Studio';
    return { text: JSON.stringify({ folder, tags: ['test'], description: `A test file called ${name}` }), model: p.model, inputTokens: 700, outputTokens: 60, costUsd: 0.0002, latencyMs: 1, stopReason: 'end_turn', simulated: false };
  },
}));

describe('photos in the Vault, in small pieces', () => {
  it('tells a photo from a video by the file ending, and ignores everything else', () => {
    expect(kindOfFile('C:\\x\\IMG_1.JPG')).toBe('photo');
    expect(kindOfFile('/x/a.heic')).toBe('photo');
    expect(kindOfFile('/x/clip.MOV')).toBe('video');
    expect(kindOfFile('/x/notes.txt')).toBeNull();
  });

  it('reads the day a photo was taken from its EXIF text, as the local time it was taken', () => {
    const t = exifTime({ DateTimeOriginal: '2026:09:14 17:30:05' });
    expect(t?.day).toBe('2026-09-14');
    expect(t?.at.getHours()).toBe(17);
    expect(exifTime({ DateTime: '2026:01:02 03:04:05' })?.day).toBe('2026-01-02');
    expect(exifTime({ DateTimeOriginal: '0000:00:00 00:00:00' })).toBeNull();
    expect(exifTime({ Make: 'Apple' })).toBeNull();
    expect(exifTime(undefined)).toBeNull();
  });

  it('prices a photo as one picture and a video as three', () => {
    expect(sortTokens('photo')).toBeLessThan(sortTokens('video'));
  });

  it('builds the on-disk tree: Photos or Videos, then the folder, then the file', () => {
    expect(targetPath(path.join('d', 'Sorted'), 'photo', 'Desk', 'a.jpg')).toBe(path.join('d', 'Sorted', 'Photos', 'Desk', 'a.jpg'));
    expect(targetPath(path.join('d', 'Sorted'), 'video', 'Studio', '..\\..\\evil.mp4')).toBe(path.join('d', 'Sorted', 'Videos', 'Studio', 'evil.mp4'));
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('photos and videos from a folder, sorted and put in folders on the computer', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let member = '';
  let tmp = '';
  let roll = '';
  const wasDir = config.vaultDir;
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ff = (...args: string[]) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  };
  const video = (file: string, color: string) => ff('-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=2:r=10`, '-pix_fmt', 'yuv420p', file);
  const photo = (file: string, color: string) => ff('-f', 'lavfi', '-i', `color=c=${color}:s=96x64`, '-frames:v', '1', file);
  /** A JPEG that carries a date the way a camera writes it (EXIF "DateTime", tag 0x0132). */
  const photoWithDate = (file: string, color: string, when: string) => {
    photo(file, color);
    const jpeg = fs.readFileSync(file);
    const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x32, 0x01, 2, 0, 20, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(`${when}\0`, 'latin1')]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 2 + 6 + tiff.length]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
    fs.writeFileSync(file, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
  };
  const finish = async (jobId: string) => {
    for (let i = 0; i < 150; i++) {
      const j = (await (await call(admin, 'GET', `/vault/jobs/${jobId}`)).json()) as { state: string; added: number; done: number; failed: number; duplicates: number; note: string; log: { id: string; folder: string }[]; logged: number };
      if (j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('job did not finish');
  };
  const list = async (query: string) => (await (await call(admin, 'GET', `/vault/clips?${query}`)).json()) as { items: { id: string; name: string; kind: string; folder: string; sorted: boolean; durationSec: number | null; hasSound: boolean; shotDate: string }[]; total: number };
  const listing = (dir: string) => fs.readdirSync(dir).sort();

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-photos-'));
    config.vaultDir = path.join(tmp, 'vault');
    roll = path.join(tmp, 'camera roll');
    fs.mkdirSync(path.join(roll, 'trip'), { recursive: true });
    video(path.join(roll, 'a.mp4'), 'red');
    video(path.join(roll, 'b.mp4'), 'blue');
    photo(path.join(roll, 'selfie1.jpg'), 'orange');
    photo(path.join(roll, 'trip', 'selfie1.jpg'), 'purple'); // same name, different picture
    photo(path.join(roll, 'shot1.png'), 'green');
    fs.copyFileSync(path.join(roll, 'shot1.png'), path.join(roll, 'shot1 copy.png'));
    photoWithDate(path.join(roll, 'dated.jpg'), 'yellow', '2026:09:14 17:30:05');
    fs.writeFileSync(path.join(roll, 'notes.txt'), 'not media');
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

  it('reads photos and videos together, catches the copy, and keeps the two apart', async () => {
    const res = await call(admin, 'POST', '/vault/scan', { folder: roll });
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: string; total: number; note: string };
    expect(job.total).toBe(7); // 2 videos + 5 photos (one is a copy); the .txt is ignored
    expect(job.note).toMatch(/2 videos and 5 photos/);
    expect(await finish(job.id)).toMatchObject({ state: 'done', added: 6, duplicates: 1, failed: 0 });
    expect(((await (await call(admin, 'GET', '/vault/stats')).json()) as object)).toMatchObject({ clips: 6, photos: 4, videos: 2, sortedVideos: 0, duplicates: 1, unsorted: 6 });
    const photos = await list('kind=photo');
    expect(photos.total).toBe(4);
    expect(photos.items.every((p) => p.kind === 'photo' && p.durationSec === null && !p.hasSound)).toBe(true);
    expect((await list('kind=video')).items.map((c) => c.name).sort()).toEqual(['a.mp4', 'b.mp4']);
    // every photo gets a picture to show (a JPEG, a PNG and one with EXIF), not just a name
    expect(photos.items.every((p) => /^data:image\/jpeg;base64,/.test((p as unknown as { thumb: string }).thumb))).toBe(true);
  });

  it('uses the date inside a photo, and gives photos a thumbnail the page can show', async () => {
    const dated = (await list('q=dated')).items[0];
    expect(dated.shotDate).toBe('2026-09-14');
    const days = (await (await call(admin, 'GET', '/vault/days')).json()) as { day: string; clips: number; videos: number; thumbs: string[] }[];
    const sep = days.find((d) => d.day === '2026-09-14')!;
    expect(sep).toMatchObject({ clips: 1, videos: 0 });
    expect(sep.thumbs[0]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('opens a photo through a signed link as an image', async () => {
    const id = (await list('q=selfie1')).items[0].id;
    const { url } = (await (await call(admin, 'GET', `/vault/clips/${id}/stream-url`)).json()) as { url: string };
    const ok = await fetch(base + url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/image\/jpeg/);
  });

  it('sorts photos with one picture and videos with three, and logs each file as it lands in its folder', async () => {
    const quote = (await (await call(member, 'POST', '/vault/sort', { approved: false })).json()) as { clips: number };
    expect(quote.clips).toBe(6);
    const res = await call(member, 'POST', '/vault/sort', { approved: true });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { id: string };
    const done = await finish(started.id);
    expect(done).toMatchObject({ state: 'done', done: 6, failed: 0 });
    expect(done.logged).toBe(6);
    expect(done.log.map((l) => l.folder).sort()).toEqual(['Desk', 'Outdoors', 'Screenshots', 'Selfies & portraits', 'Selfies & portraits', 'Studio']);
    // only the entries after `since` come back
    const tail = (await (await call(member, 'GET', `/vault/jobs/${started.id}?since=4`)).json()) as { log: unknown[]; logged: number };
    expect(tail.log).toHaveLength(2);
    expect(tail.logged).toBe(6);
    const photoCalls = calls.filter((c) => /Type: photo/.test(c.user));
    const videoCalls = calls.filter((c) => /Type: video/.test(c.user));
    expect(photoCalls).toHaveLength(4);
    expect(photoCalls.every((c) => c.images === 1)).toBe(true);
    expect(videoCalls).toHaveLength(2);
    expect(videoCalls.every((c) => c.images === 3)).toBe(true);
    expect(((await (await call(admin, 'GET', '/vault/stats')).json()) as object)).toMatchObject({ unsorted: 0, sortedVideos: 2 });
  });

  it('never offers a photo as footage for reels', async () => {
    // six files are sorted but only two are videos, so there is not enough footage to plan from
    const r = await call(member, 'POST', '/vault/reels/suggest', { approved: false });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error?: { message?: string }; message?: string }).error?.message ?? '').toMatch(/at least 3/);
  });

  describe('putting the files in folders on this computer', () => {
    let copyTo = '';
    let moveTo = '';
    beforeAll(() => {
      copyTo = path.join(tmp, 'sorted copy');
      moveTo = path.join(tmp, 'sorted move');
    });
    const organize = (body: object, token = admin) => call(token, 'POST', '/vault/organize', body);

    it('is only for the admin login, and wants a real folder that is not a whole drive', async () => {
      expect((await organize({ destRoot: copyTo }, member)).status).toBe(403);
      expect((await organize({ destRoot: 'relative/path' })).status).toBe(400);
      expect((await organize({ destRoot: path.parse(tmp).root })).status).toBe(400);
      expect((await call(member, 'POST', '/vault/organize/00000000-0000-4000-8000-000000000000/undo')).status).toBe(403);
    });

    it('says exactly what it would do first, and touches nothing', async () => {
      const q = (await (await organize({ destRoot: copyTo, mode: 'copy' })).json()) as { approved: boolean; files: number; photos: number; videos: number; skippedDuplicates: number; skippedUnsorted: number; folders: { folder: string; n: number }[] };
      expect(q).toMatchObject({ approved: false, files: 6, photos: 4, videos: 2, skippedDuplicates: 1, skippedUnsorted: 0 });
      expect(q.folders).toContainEqual({ folder: 'Selfies & portraits', n: 2 });
      expect(fs.existsSync(copyTo)).toBe(false);
    });

    it('copies into Photos/<folder> and Videos/<folder>, leaves the originals alone, and never overwrites a file with the same name', async () => {
      const job = (await (await organize({ destRoot: copyTo, mode: 'copy', approved: true })).json()) as { id: string };
      expect(await finish(job.id)).toMatchObject({ state: 'done', added: 6, failed: 0 });
      expect(listing(path.join(copyTo, 'Photos'))).toEqual(['Outdoors', 'Screenshots', 'Selfies & portraits']);
      expect(listing(path.join(copyTo, 'Videos'))).toEqual(['Desk', 'Studio']);
      expect(listing(path.join(copyTo, 'Photos', 'Selfies & portraits'))).toEqual(['selfie1 (2).jpg', 'selfie1.jpg']);
      const a = fs.readFileSync(path.join(copyTo, 'Photos', 'Selfies & portraits', 'selfie1.jpg'));
      const b = fs.readFileSync(path.join(copyTo, 'Photos', 'Selfies & portraits', 'selfie1 (2).jpg'));
      expect(Buffer.compare(a, b)).not.toBe(0);
      expect(fs.existsSync(path.join(roll, 'a.mp4'))).toBe(true);
      expect(fs.existsSync(path.join(roll, 'trip', 'selfie1.jpg'))).toBe(true);
    });

    it('does not make a second copy when run again', async () => {
      const job = (await (await organize({ destRoot: copyTo, mode: 'copy', approved: true })).json()) as { id: string };
      const done = await finish(job.id);
      expect(done).toMatchObject({ added: 0, failed: 0 });
      expect(done.note).toMatch(/6 already in place/);
      expect(listing(path.join(copyTo, 'Photos', 'Selfies & portraits'))).toEqual(['selfie1 (2).jpg', 'selfie1.jpg']);
    });

    it('moves files when asked, keeps the Vault pointing at them, and can put every one back', async () => {
      expect(((await (await call(admin, 'GET', '/vault/organize/last')).json()) as unknown)).toBeNull();
      const job = (await (await organize({ destRoot: moveTo, mode: 'move', approved: true })).json()) as { id: string };
      expect(await finish(job.id)).toMatchObject({ state: 'done', added: 6, failed: 0 });
      expect(fs.existsSync(path.join(roll, 'a.mp4'))).toBe(false);
      expect(fs.existsSync(path.join(roll, 'trip', 'selfie1.jpg'))).toBe(false);
      expect(fs.existsSync(path.join(moveTo, 'Videos', 'Desk', 'a.mp4'))).toBe(true);
      // the twin of shot1.png (whichever the Vault read second) was not part of it: duplicates stay where they are
      const twin = (await list('duplicates=only')).items[0].name;
      expect(['shot1.png', 'shot1 copy.png']).toContain(twin);
      expect(fs.existsSync(path.join(roll, twin))).toBe(true);
      // the Vault still plays the moved file
      const id = (await list('q=a.mp4')).items[0].id;
      const { url } = (await (await call(admin, 'GET', `/vault/clips/${id}/stream-url`)).json()) as { url: string };
      expect((await fetch(base + url)).status).toBe(200);

      const last = (await (await call(admin, 'GET', '/vault/organize/last')).json()) as { id: string; files: number };
      expect(last).toMatchObject({ id: job.id, files: 6 });
      const undone = (await (await call(admin, 'POST', `/vault/organize/${last.id}/undo`)).json()) as { restored: number; skipped: number };
      expect(undone).toEqual({ restored: 6, skipped: 0 });
      expect(fs.existsSync(path.join(roll, 'a.mp4'))).toBe(true);
      expect(fs.existsSync(path.join(roll, 'trip', 'selfie1.jpg'))).toBe(true);
      expect(fs.existsSync(path.join(moveTo, 'Photos'))).toBe(false); // the empty folders it made are tidied away
      expect(fs.existsSync(moveTo)).toBe(true);
      expect((await fetch(base + url)).status).toBe(200);
      expect(((await (await call(admin, 'GET', '/vault/organize/last')).json()) as unknown)).toBeNull();
      expect((await call(admin, 'POST', `/vault/organize/${last.id}/undo`)).status).toBe(404);
    });
  });
});
