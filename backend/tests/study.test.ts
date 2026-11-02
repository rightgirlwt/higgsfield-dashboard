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
import { checkLink, metaFrom, pacingOf, parseAnalysis, parseScript } from '../src/services/study';

// What Claude "answers": an analysis, a script or reel ideas, depending on what it was asked. Every call is written down.
const calls: { system: string; user: string; images: number }[] = [];
// yt-dlp is faked: it "downloads" a prepared video into the folder it is told to use and prints what the real one prints.
const yt = vi.hoisted(() => ({ source: '', info: {} as Record<string, unknown>, fail: '', seen: [] as string[][] }));
vi.mock('../src/services/exec', async (orig) => {
  const real = await orig<typeof import('../src/services/exec')>();
  return {
    ...real,
    run: async (cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => {
      if (cmd !== 'yt-dlp') return real.run(cmd, args, opts);
      const fs2 = await import('node:fs');
      yt.seen.push(args);
      if (yt.fail) throw new Error(yt.fail);
      if (!args.includes('--skip-download')) fs2.copyFileSync(yt.source, args[args.indexOf('-o') + 1].replace('%(id)s', 'abc').replace('%(ext)s', 'mp4'));
      return { stdout: Buffer.from(JSON.stringify(yt.info)), stderr: '' };
    },
  };
});
const ANALYSIS = {
  summary: 'A founder talks to camera about a mistake.',
  format: 'talking head with burned-in captions',
  hook: { said: 'You are losing money every Friday.', shown: 'Close-up, hand slams a laptop shut', technique: 'bold claim', why: 'It names a loss the viewer already feels.' },
  structure: [
    { at: 0, label: 'Hook', what: 'States the loss' },
    { at: 4, label: 'Proof', what: 'Shows the number' },
    { at: 11, label: 'Fix', what: 'One step' },
  ],
  pacing: 'A cut every second.',
  onScreenText: 'Big white words, centre.',
  audio: 'Voice only.',
  cta: 'Comment GUIDE',
  steal: ['Open on the loss', 'Cut every beat'],
  avoid: ['The founder is famous'],
  template: '0-3s [loss]. 3-10s [proof]. 10-15s [one fix].',
};
vi.mock('../src/services/secrets', async (orig) => ({ ...(await orig<typeof import('../src/services/secrets')>()), getSecret: async () => 'test-key' }));
vi.mock('../src/services/claude', () => ({
  runPrompt: async (_org: string, p: { model: string; system?: string; user: string; images?: unknown[] }) => {
    calls.push({ system: p.system ?? '', user: p.user, images: p.images?.length ?? 0 });
    const system = p.system ?? '';
    const text = /take apart a short social video/.test(system)
      ? JSON.stringify(ANALYSIS)
      : /new short-form video script/.test(system)
        ? JSON.stringify({ title: 'Your Friday leak', hook: 'You lose money every Friday — here is why.', beats: [{ say: 'Check your invoices.', onScreen: 'FRIDAY', shot: 'close-up', seconds: 4 }, { say: 'Send them today.', onScreen: '', shot: 'wide', seconds: 5 }], caption: 'Send the invoice before the weekend. DM INVOICE.', notes: 'Kept the loss-first hook.' })
        : JSON.stringify([{ title: 'Modeled reel', style: 'topic', hook: 'Hook', beats: [{ clip: 'c1', line: 'a', seconds: 2 }, { clip: 'c2', line: 'b', seconds: 2 }, { clip: 'c3', line: 'c', seconds: 2 }], caption: 'Cap', why: 'Because' }]);
    return { text, model: p.model, inputTokens: 1500, outputTokens: 400, costUsd: 0.01, latencyMs: 1, stopReason: 'end_turn', simulated: false };
  },
}));

describe('Study Session, in small pieces', () => {
  it('reads an analysis even with prose around it, and fills what is missing', () => {
    const a = parseAnalysis(`Here you go:\n${JSON.stringify({ summary: '  A  reel ', structure: [{ at: '2.26', label: 'Hook', what: 'x' }], steal: ['a', '', 'b'] })}\nThanks`);
    expect(a.summary).toBe('A reel');
    expect(a.structure).toEqual([{ at: 2.3, label: 'Hook', what: 'x' }]);
    expect(a.steal).toEqual(['a', 'b']);
    expect(a.hook.technique).toBe('');
    expect(() => parseAnalysis('no json here')).toThrow(/analysis/);
    expect(() => parseAnalysis('{"format":"x"}')).toThrow(/analysis/); // no summary: not an analysis
  });

  it('needs a script to have beats, and caps how long a beat can be', () => {
    const s = parseScript(JSON.stringify({ title: 'T', hook: 'H', beats: [{ say: 'hi', seconds: 99 }], caption: 'C' }));
    expect(s.beats[0].seconds).toBe(30);
    expect(() => parseScript(JSON.stringify({ title: 'T', beats: [] }))).toThrow(/script/);
  });

  it('only opens links from the places reels are posted', () => {
    expect(checkLink('https://www.instagram.com/p/DfC7ZDrA7Ne/').hostname).toBe('www.instagram.com');
    expect(checkLink('https://vm.tiktok.com/abc').hostname).toBe('vm.tiktok.com');
    expect(checkLink('https://youtu.be/abc').hostname).toBe('youtu.be');
    for (const bad of ['http://www.instagram.com/p/x', 'https://instagram.com.evil.com/p/x', 'https://evil.com/instagram.com', 'https://user:pw@www.instagram.com/p/x', 'https://localhost:4000/api', 'https://127.0.0.1/x', 'file:///c:/secret.mp4', 'not a link']) {
      expect(() => checkLink(bad), bad).toThrow();
    }
  });

  it('keeps the caption and the numbers, and leaves out what the site did not give', () => {
    const m = metaFrom({ extractor_key: 'Instagram', channel: 'viiolini', description: 'caption line 1\r\nline 2 ', timestamp: 1793207222, like_count: 351, comment_count: 264, view_count: null }, new Date('2026-11-02T00:00:00Z'));
    expect(m).toMatchObject({ platform: 'instagram', uploader: 'viiolini', caption: 'caption line 1\nline 2', likes: 351, comments: 264, views: null, fetchedAt: '2026-11-02T00:00:00.000Z' });
    expect(m.postedAt).toMatch(/^2026-/);
    expect(metaFrom({})).toMatchObject({ caption: '', likes: null, postedAt: null });
  });
  it('works pace out from the cuts', () => {
    expect(pacingOf(10, [2, 4, 6, 8])).toEqual({ shots: 5, averageShotSec: 2, cutsPer10s: 4, firstCutSec: 2 });
    expect(pacingOf(10, [])).toMatchObject({ shots: 1, averageShotSec: 10, firstCutSec: null });
    expect(pacingOf(null, [])).toMatchObject({ averageShotSec: null, cutsPer10s: null });
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('Study Session end to end', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let tmp = '';
  let reel: Buffer;
  let other: Buffer;
  const was = { study: config.studyDir, effects: config.effectsDir };
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const upload = (token: string, bytes: Buffer, name: string, type = 'video/mp4') =>
    fetch(`${base}/api/study/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: bytes });
  const ff = (...args: string[]) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  };
  /** Two seconds of red, then two of blue: one hard cut at 2 s. */
  const twoShots = (file: string, a: string, b: string) =>
    ff('-f', 'lavfi', '-i', `color=c=${a}:s=160x284:d=2:r=10`, '-f', 'lavfi', '-i', `color=c=${b}:s=160x284:d=2:r=10`, '-filter_complex', 'concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', file);

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'study-'));
    config.studyDir = path.join(tmp, 'study');
    config.effectsDir = path.join(tmp, 'no-effects'); // no transcriber here: the study goes ahead without spoken words
    twoShots(path.join(tmp, 'a.mp4'), 'red', 'blue');
    twoShots(path.join(tmp, 'b.mp4'), 'green', 'yellow');
    reel = fs.readFileSync(path.join(tmp, 'a.mp4'));
    other = fs.readFileSync(path.join(tmp, 'b.mp4'));
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
    admin = users.find((u) => u.role === 'admin')!.token;
  });
  afterAll(async () => {
    config.studyDir = was.study;
    config.effectsDir = was.effects;
    await new Promise((r) => server.close(r));
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let id = '';

  it('reads an uploaded reference for free: length, where it cuts, a poster', async () => {
    const res = await upload(admin, reel, 'my_fave reel.mp4');
    expect(res.status).toBe(201);
    const j = (await res.json()) as { id: string; duplicate: boolean; study: { title: string; durationSec: number; cuts: number[]; pacing: { shots: number }; poster: string; analysis: unknown } };
    id = j.id;
    expect(j.study.title).toBe('my fave reel');
    expect(j.study.durationSec).toBeCloseTo(4, 0);
    expect(j.study.cuts.length).toBe(1);
    expect(j.study.cuts[0]).toBeCloseTo(2, 0);
    expect(j.study.pacing.shots).toBe(2);
    expect(j.study.poster).toMatch(/^data:image\/jpeg;base64,/);
    expect(j.study.analysis).toBeNull();
    expect(calls).toHaveLength(0); // nothing went to Claude
  });

  it('catches the same video uploaded twice, and refuses what is not a video', async () => {
    const again = await upload(admin, reel, 'copy.mp4');
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string; duplicate: boolean }).duplicate).toBe(true);
    expect(((await (await call(admin, 'GET', '/study')).json()) as unknown[]).length).toBe(1);
    expect((await upload(admin, Buffer.from('not a video at all'), 'x.mp4')).status).toBe(400);
    expect((await upload(admin, reel, 'x.gif', 'image/gif')).status).toBe(415);
  });

  it('gives the page a signed link that plays the video, and no other way in', async () => {
    const { url } = (await (await call(admin, 'GET', `/study/${id}/stream-url`)).json()) as { url: string };
    const ok = await fetch(base + url);
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(reel.length);
    expect((await fetch(`${base}/api/study/video/${id}?exp=1&sig=nope`)).status).toBe(403);
    expect((await fetch(`${base}/api/study/${id}`)).status).toBe(401);
  });

  it('shows the price first and spends nothing until it is approved', async () => {
    const q = (await (await call(admin, 'POST', `/study/${id}/analyse`, { approved: false })).json()) as { approved: boolean; frames: number; estimateUsd: number; maxUsd: number; again: boolean };
    expect(q).toMatchObject({ approved: false, frames: 10, again: false });
    expect(q.estimateUsd).toBeGreaterThan(0);
    expect(q.maxUsd).toBeGreaterThanOrEqual(q.estimateUsd);
    expect(calls).toHaveLength(0);
  });

  it('studies the video: ten frames and the facts found by software go to Claude, and the analysis is kept', async () => {
    const res = await call(admin, 'POST', `/study/${id}/analyse`, { approved: true });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { costUsd: number; study: { analysis: typeof ANALYSIS; costUsd: number; transcribed: boolean } };
    expect(calls).toHaveLength(1);
    expect(calls[0].images).toBe(10);
    expect(calls[0].user).toMatch(/2 shots/);
    expect(calls[0].user).toMatch(/not set up/);
    expect(j.study.analysis.hook.technique).toBe('bold claim');
    expect(j.study.costUsd).toBeCloseTo(0.01);
    // kept: a fresh read of the list has it
    const listed = (await (await call(admin, 'GET', '/study')).json()) as { analysis: { summary: string } | null }[];
    expect(listed[0].analysis?.summary).toMatch(/founder/);
  });

  it('writes a script from the studied structure, in the account voice, after a price', async () => {
    const before = calls.length;
    const quote = (await (await call(admin, 'POST', `/study/${id}/script`, { topic: 'why invoices go out late', approved: false })).json()) as { approved: boolean; estimateUsd: number };
    expect(quote.approved).toBe(false);
    expect(calls).toHaveLength(before);
    expect((await call(admin, 'POST', `/study/${id}/script`, { topic: 'hi', approved: true })).status).toBe(400); // topic too short
    const res = await call(admin, 'POST', `/study/${id}/script`, { topic: 'why invoices go out late', approved: true });
    const j = (await res.json()) as { script: { id: string; hook: string; beats: unknown[]; tells: string[] } };
    expect(calls).toHaveLength(before + 1);
    expect(calls[before].user).toMatch(/why invoices go out late/);
    expect(calls[before].user).toMatch(/bold claim/); // the studied structure is in the prompt
    expect(calls[before].system).toMatch(/Do not reuse its words/);
    expect(j.script.beats).toHaveLength(2);
    // the anti-AI check flags the em dash in the hook instead of hiding it
    expect(j.script.tells.some((t) => /em dash/.test(t))).toBe(true);
    const stored = (await (await call(admin, 'GET', `/study/${id}`)).json()) as { scripts: { id: string }[] };
    expect(stored.scripts.map((s) => s.id)).toEqual([j.script.id]);
    expect((await call(admin, 'DELETE', `/study/${id}/scripts/${j.script.id}`)).status).toBe(204);
    expect(((await (await call(admin, 'GET', `/study/${id}`)).json()) as { scripts: unknown[] }).scripts).toHaveLength(0);
  });

  it('will not write from a video that has not been studied', async () => {
    const o = (await (await upload(admin, other, 'second.mp4')).json()) as { id: string };
    const res = await call(admin, 'POST', `/study/${o.id}/script`, { topic: 'something to say', approved: false });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Study this video first/);
    // keep a note on it
    const patched = (await (await call(admin, 'PATCH', `/study/${o.id}`, { note: 'love the first second', title: 'Second' })).json()) as { note: string; title: string };
    expect(patched).toMatchObject({ note: 'love the first second', title: 'Second' });
  });

  it('models Vault reel ideas on a studied reel, and says which', async () => {
    const ws = (await db.query<{ id: string; org_id: string }>('SELECT id, org_id FROM workspaces ORDER BY created_at LIMIT 1')).rows[0];
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO vault_clips (org_id, workspace_id, name, path, source, duration_sec, shot_at, shot_date, folder, tags, description, status, fingerprint)
         VALUES ($1,$2,$3,'x','upload',5,now(),current_date,'Desk',ARRAY['desk'],'a desk','sorted',$4)`,
        [ws.org_id, ws.id, `c${i}.mp4`, `f${i}`],
      );
    }
    const before = calls.length;
    const quote = (await (await call(admin, 'POST', '/vault/reels/suggest', { approved: false, count: 1, studyIds: [id] })).json()) as { estimateUsd: number };
    const plain = (await (await call(admin, 'POST', '/vault/reels/suggest', { approved: false, count: 1 })).json()) as { estimateUsd: number };
    expect(quote.estimateUsd).toBeGreaterThan(plain.estimateUsd); // the notes cost a few tokens
    expect(calls).toHaveLength(before);
    const made = (await (await call(admin, 'POST', '/vault/reels/suggest', { approved: true, count: 1, studyIds: [id] })).json()) as { reels: { modeledOn: string[] }[] };
    expect(calls[before].system).toMatch(/Model the structure on what she studied/);
    expect(calls[before].system).toMatch(/Open on the loss/);
    expect(made.reels[0].modeledOn).toEqual(['my fave reel']);
    const listed = (await (await call(admin, 'GET', '/vault/reels')).json()) as { modeledOn: string[] }[];
    expect(listed[0].modeledOn).toEqual(['my fave reel']);
    // a studied id that does not exist, or one never studied, is refused before anything is spent
    const none = await call(admin, 'POST', '/vault/reels/suggest', { approved: true, count: 1, studyIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(none.status).toBe(400);
  });

  it('opens a link: downloads the reel here with its caption and numbers, free, and tells Claude the caption', async () => {
    twoShots(path.join(tmp, 'c.mp4'), 'purple', 'orange');
    yt.source = path.join(tmp, 'c.mp4');
    yt.info = { extractor_key: 'Instagram', channel: 'viiolini', description: 'i built my own editing system. comment GUIDE', timestamp: 1793207222, like_count: 351, comment_count: 264 };
    const before = calls.length;
    const res = await call(admin, 'POST', '/study/from-link', { url: 'https://www.instagram.com/p/DfC7ZDrA7Ne/' });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { id: string; study: { title: string; sourceUrl: string; meta: { likes: number; comments: number; views: null; caption: string }; poster: string; pacing: { shots: number } } };
    expect(j.study.title).toMatch(/^viiolini: i built my own editing system/);
    expect(j.study.sourceUrl).toBe('https://www.instagram.com/p/DfC7ZDrA7Ne/');
    expect(j.study.meta).toMatchObject({ likes: 351, comments: 264, views: null });
    expect(j.study.poster).toMatch(/^data:image\/jpeg/);
    // pasting a link also studies it: one Claude call, with the caption and numbers, and the analysis is already saved
    expect(calls).toHaveLength(before + 1);
    expect(calls[before].images).toBe(10);
    expect((j as unknown as { costUsd: number; studyError: string }).costUsd).toBeGreaterThan(0);
    expect((j as unknown as { studyError: string }).studyError).toBe('');
    expect((j.study as unknown as { analysis: { summary: string } }).analysis.summary).toMatch(/founder/);
    const args = yt.seen[0];
    expect(args.slice(-2)).toEqual(['--', 'https://www.instagram.com/p/DfC7ZDrA7Ne/']); // the link can never be read as an option
    expect(args).toContain('--no-playlist');
    // the downloaded scratch folder is gone
    expect(fs.existsSync(path.join(config.studyDir, 'incoming')) ? fs.readdirSync(path.join(config.studyDir, 'incoming')) : []).toEqual([]);
    // the caption and numbers reach Claude when it studies the reel
    expect(calls[before].user).toMatch(/351 likes, 264 comments/);
    expect(calls[before].user).toMatch(/comment GUIDE/);
    // the same link again is the same reel, with fresh numbers
    yt.info = { ...yt.info, like_count: 400 };
    const again = await call(admin, 'POST', '/study/from-link', { url: 'https://www.instagram.com/p/DfC7ZDrA7Ne/' });
    expect(again.status).toBe(200);
    expect(calls).toHaveLength(before + 1); // already studied, so it is not paid for twice
    expect(((await again.json()) as { id: string; study: { meta: { likes: number } } }).study.meta.likes).toBe(400);
    // refresh reads the numbers again without downloading
    yt.info = { ...yt.info, like_count: 500 };
    const fresh = (await (await call(admin, 'POST', `/study/${j.id}/refresh`)).json()) as { meta: { likes: number } };
    expect(fresh.meta.likes).toBe(500);
    expect(yt.seen[yt.seen.length - 1]).toContain('--skip-download');
  });

  it('says plainly when a link cannot be opened, and refuses links that are not reels', async () => {
    yt.fail = 'ERROR: [Instagram] x: login required to view this content';
    const walled = await call(admin, 'POST', '/study/from-link', { url: 'https://www.instagram.com/p/private1/' });
    expect(walled.status).toBe(400);
    expect(((await walled.json()) as { error: { message: string } }).error.message).toMatch(/upload the file instead/);
    yt.fail = 'spawn yt-dlp ENOENT';
    expect((await call(admin, 'POST', '/study/from-link', { url: 'https://www.instagram.com/p/x/' })).status).toBe(501);
    yt.fail = '';
    const seen = yt.seen.length;
    expect((await call(admin, 'POST', '/study/from-link', { url: 'https://localhost:4000/api/settings' })).status).toBe(400);
    expect((await call(admin, 'POST', '/study/from-link', { url: 'http://www.instagram.com/p/x/' })).status).toBe(400);
    expect(yt.seen).toHaveLength(seen); // yt-dlp was never started for these
    // an uploaded reel has no link to read numbers from
    const up = (await (await upload(admin, fs.readFileSync(path.join(tmp, 'a.mp4')), 'solo.mp4')).json()) as { id: string };
    expect((await call(admin, 'POST', `/study/${up.id}/refresh`)).status).toBe(400);
  });
  it('removes the video and its file', async () => {
    const file = (await db.query<{ path: string }>('SELECT path FROM study_refs WHERE id=$1', [id])).rows[0].path;
    expect(fs.existsSync(file)).toBe(true);
    expect((await call(admin, 'DELETE', `/study/${id}`)).status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
    expect((await call(admin, 'GET', `/study/${id}`)).status).toBe(404);
  });
});

