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
import { checkCutaways, composeBroll, cutawayFilter, placeReelBroll } from '../src/services/broll';
import { parseBrollPicks } from '../src/services/brollPlan';
import { describeChanges } from '../src/services/drafts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('cutaways', () => {
  it('are put in time order and trimmed to the video', () => {
    const out = checkCutaways(
      [
        { clipId: id(2), start: 8, end: 20, from: 0 },
        { clipId: id(1), start: 1, end: 3, from: 2 },
        { clipId: id(3), start: 30, end: 40, from: 0 },
      ],
      10,
    );
    expect(out.map((c) => [c.clipId, c.start, c.end])).toEqual([[id(1), 1, 3], [id(2), 8, 10]]);
  });

  it('refuse one that ends before it starts', () => {
    expect(() => checkCutaways([{ clipId: id(1), start: 5, end: 5, from: 0 }], 10)).toThrow(/end time/);
  });

  it('build a filter that fills the picture and shows each clip only in its own stretch', () => {
    const f = cutawayFilter([{ start: 1, end: 3 }, { start: 5.5, end: 7 }], 1080, 1920);
    expect(f).toContain('[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920');
    expect(f).toContain('setpts=PTS-STARTPTS+5.5/TB[b1]');
    expect(f).toContain("[0:v][b0]overlay=enable='between(t,1,3)':eof_action=pass[v0]");
    expect(f).toContain("[v0][b1]overlay=enable='between(t,5.5,7)':eof_action=pass[vout]");
  });
});

describe("placing a reel's clips on an edit", () => {
  const reel = [1, 2, 3, 4].map((n) => ({ clipId: id(n), seconds: 3 }));

  it('spreads them evenly over the video when it has no beats', () => {
    const out = placeReelBroll(reel, [], 40);
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.start)).toEqual([0.3, 10.3, 20.3, 30.3]);
    expect(out.every((c) => Math.abs(c.end - c.start - 3) < 0.011)).toBe(true);
  });

  it("puts one clip in each beat's slot, a moment in, and never beyond the slot", () => {
    const out = placeReelBroll(reel, [{ startSec: 0, endSec: 2 }, { startSec: 2, endSec: 10 }, { startSec: 10, endSec: 14 }, { startSec: 14, endSec: 15 }], 15);
    // slot 0 is 2s long: 0.3 lead leaves 1.7s; slot 3 is 1s long: too short, skipped
    expect(out.map((c) => [c.clipId, c.start, c.end])).toEqual([[id(1), 0.3, 2], [id(2), 2.3, 5.3], [id(3), 10.3, 13.3]]);
  });

  it('shares a beat between clips when the reel has more clips than the video has beats', () => {
    const out = placeReelBroll(reel, [{ startSec: 0, endSec: 9 }], 9);
    expect(out).toHaveLength(4);
    expect(out[0].start).toBe(0.3);
    expect(out[3].end).toBeLessThanOrEqual(9);
    expect(out.every((c, i) => i === 0 || c.start >= out[i - 1].end)).toBe(true);
  });

  it('returns nothing for an empty reel or a video with no length', () => {
    expect(placeReelBroll([], [], 10)).toEqual([]);
    expect(placeReelBroll(reel, [], 0)).toEqual([]);
  });
});

describe('reading the B-roll suggestions', () => {
  const beats = [{ startSec: 0, endSec: 6 }, { startSec: 6, endSec: 12 }, { startSec: 12, endSec: 14 }];
  const catalog = [{ key: 'c1', id: id(1), durationSec: 10 }, { key: 'c2', id: id(2), durationSec: 2 }, { key: 'c3', id: id(3), durationSec: null }];

  it('keeps picks that fit, and trims them to the beat and the clip', () => {
    const out = parseBrollPicks(
      JSON.stringify([
        { beat: 1, clip: 'c1', at: 0.5, seconds: 3, why: 'coffee' },
        { beat: 2, clip: 'C2', at: 1, seconds: 4, why: 'short clip' },
        { beat: 3, clip: 'c3', at: 1.5, seconds: 4 },
      ]),
      beats,
      catalog,
    );
    // the third is dropped: only half a second of its beat is left, and a cutaway needs at least a second
    expect(out.map((p) => [p.cutaway.clipId, p.cutaway.start, p.cutaway.end, p.beat])).toEqual([[id(1), 0.5, 3.5, 1], [id(2), 7, 9, 2]]);
  });

  it('drops invented beats and clips, repeated clips, and cutaways under a second', () => {
    const out = parseBrollPicks(
      JSON.stringify([
        { beat: 9, clip: 'c1' },
        { beat: 1, clip: 'c9' },
        { beat: 1, clip: 'c1', at: 0.4, seconds: 3 },
        { beat: 2, clip: 'c1', at: 0.4, seconds: 3 },
        { beat: 3, clip: 'c2', at: 1.6, seconds: 3 },
      ]),
      beats,
      catalog,
    );
    expect(out.map((p) => p.cutaway.clipId)).toEqual([id(1)]);
  });

  it('refuses an answer that is not a list', () => {
    expect(() => parseBrollPicks('Sure thing!', beats, catalog)).toThrow();
  });
});

describe('what changed between drafts', () => {
  const base = { steps: [], label: { enabled: false, text: '' } };
  const one = { clipId: id(1), start: 1, end: 3, from: 0 };
  it('says when B-roll was added, changed or removed', () => {
    expect(describeChanges(base, { ...base, broll: [one] })).toEqual(['Added B-roll (1 clip)']);
    expect(describeChanges({ ...base, broll: [one] }, { ...base, broll: [{ ...one, end: 4 }] })).toEqual(['Changed the B-roll']);
    expect(describeChanges({ ...base, broll: [one] }, base)).toEqual(['Removed the B-roll']);
    expect(describeChanges({ ...base, broll: [one] }, { ...base, broll: [one] })).toEqual(['Rendered again with the same settings']);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('B-roll, end to end', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let tmp = '';
  let clipId = '';
  const was = { vault: config.vaultDir, edit: config.editDir };
  const call = (method: string, url: string, body?: unknown) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const make = (file: string, color: string, seconds: number, audio: boolean) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=${seconds}:r=10`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest'] : []), '-pix_fmt', 'yuv420p', file]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  };
  /** The colour of the middle of the picture at a moment, as [r, g, b]. */
  const pixelAt = (file: string, t: number) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return [...r.stdout.subarray(0, 3)];
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-test-'));
    config.vaultDir = path.join(tmp, 'vault');
    config.editDir = path.join(tmp, 'edit');
    fs.mkdirSync(path.join(tmp, 'roll'));
    make(path.join(tmp, 'roll', 'blue.mp4'), 'blue', 2, false);
    make(path.join(tmp, 'talk.mp4'), 'red', 6, true);
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
    admin = users.find((u) => u.role === 'admin')!.token;
    const job = (await (await call('POST', '/vault/scan', { folder: path.join(tmp, 'roll') })).json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      if (((await (await call('GET', `/vault/jobs/${job.id}`)).json()) as { state: string }).state !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    clipId = ((await (await call('GET', '/vault/clips')).json()) as { items: { id: string }[] }).items[0].id;
  });
  afterAll(async () => {
    config.vaultDir = was.vault;
    config.editDir = was.edit;
    await new Promise((r) => server.close(r));
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('shows the clip only during its cutaway, then the video again, with the video sound kept', async () => {
    const out = path.join(tmp, 'out.mp4');
    await composeBroll({ base: path.join(tmp, 'talk.mp4'), out, cutaways: [{ clipId, start: 2, end: 4, from: 0 }] });
    const [r0, , b0] = pixelAt(out, 1); // before: the red video
    const [r1, , b1] = pixelAt(out, 3); // during: the blue clip
    const [r2, , b2] = pixelAt(out, 5); // after: red again
    expect(r0).toBeGreaterThan(150);
    expect(b0).toBeLessThan(100);
    expect(b1).toBeGreaterThan(150);
    expect(r1).toBeLessThan(100);
    expect(r2).toBeGreaterThan(150);
    expect(b2).toBeLessThan(100);
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).stdout.toString()) as { streams: { codec_type: string }[]; format: { duration: string } };
    expect(probe.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(Number(probe.format.duration)).toBeGreaterThan(5.5);
    expect(Number(probe.format.duration)).toBeLessThan(6.5);
  }, 60_000);

  it('repeats a clip that is shorter than its cutaway instead of leaving a gap', async () => {
    const out = path.join(tmp, 'out2.mp4');
    await composeBroll({ base: path.join(tmp, 'talk.mp4'), out, cutaways: [{ clipId, start: 1, end: 5, from: 0 }] }); // the clip is only 2s
    const [r, , b] = pixelAt(out, 4.2);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(100);
  }, 60_000);

  it('says plainly when a clip has left the Vault', async () => {
    await expect(composeBroll({ base: path.join(tmp, 'talk.mp4'), out: path.join(tmp, 'x.mp4'), cutaways: [{ clipId: id(99), start: 1, end: 2, from: 0 }] })).rejects.toThrow(/no longer in the Vault/);
  });

  it("sends a reel's clips to an edit, saves them in its plan, and the plan keeps them", async () => {
    const up = await fetch(`${base}/api/edit/videos?filename=talk.mp4`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'video/mp4' }, body: fs.readFileSync(path.join(tmp, 'talk.mp4')) });
    const video = (await up.json()) as { id: string };
    const org = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
    const beats = [{ clipId, line: 'a', seconds: 2 }, { clipId, line: 'b', seconds: 2 }];
    const reel = (await db.query<{ id: string }>(`INSERT INTO vault_reels (org_id, title, style, beats) VALUES ($1,'t','topic',$2::jsonb) RETURNING id`, [org, JSON.stringify(beats)])).rows[0].id;
    const res = await call('POST', `/vault/reels/${reel}/to-edit`, { videoId: video.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ placed: 2, videoId: video.id });
    const list = (await (await call('GET', '/edit/videos')).json()) as { id: string; plan?: { broll: { clipId: string; start: number; end: number }[] } }[];
    const plan = list.find((v) => v.id === video.id)!.plan!;
    expect(plan.broll).toHaveLength(2);
    expect(plan.broll[0]).toMatchObject({ clipId, start: 0.3 });
    // and the editor's own autosave accepts B-roll
    const saved = await call('PUT', `/edit/videos/${video.id}/plan`, { steps: [], label: { enabled: false }, broll: plan.broll });
    expect(saved.status).toBe(200);
    expect((await call('PUT', `/edit/videos/${video.id}/plan`, { steps: [], label: { enabled: false }, broll: [{ clipId: 'nope', start: 0, end: 1 }] })).status).toBe(400);
    // asking for suggestions without beats, or without a key, is a plain refusal rather than a charge
    expect((await call('POST', `/edit/videos/${video.id}/broll/suggest`)).status).toBe(400);
  });

  it('looks up clips by id for the editor', async () => {
    const r = (await (await call('GET', `/vault/clips?ids=${clipId},not-an-id`)).json()) as { items: { id: string }[]; total: number };
    expect(r.items.map((c) => c.id)).toEqual([clipId]);
  });
});
