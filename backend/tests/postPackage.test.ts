import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { blockers, checkPackage, cleanTags, parsePackage, postText } from '../src/services/postPackage';
import { findTells, voiceRules } from '../src/services/voices';

// What Claude "answers": the queue first, then `answer`
let answer = '';
const queue: string[] = [];
vi.mock('../src/services/secrets', async (orig) => ({ ...(await orig<typeof import('../src/services/secrets')>()), getSecret: async () => 'test-key' }));
vi.mock('../src/services/claude', () => ({
  runPrompt: async (_org: string, p: { model: string; system?: string; user: string }) => {
    seen.push(p);
    return { text: queue.length ? queue.shift()! : answer, model: p.model, inputTokens: 900, outputTokens: 150, costUsd: 0.0123, latencyMs: 5, stopReason: 'end_turn', simulated: false };
  },
}));
const seen: { model: string; system?: string; user: string }[] = [];

describe('the writing rules copied from the skills', () => {
  it('give every account the hook, caption and anti-AI rules', () => {
    const rules = voiceRules('Right Girl Media');
    expect(rules).toContain('Viral Hooks');
    expect(rules).toContain('Social Media Captions');
    expect(rules).toContain('negative parallelism');
    expect(rules).not.toContain('ABA Model Rule 7.1');
  });
  it('add the legal advertising rules for the law firm', () => {
    expect(voiceRules('Greene Legal Group')).toContain('ABA Model Rule 7.1');
    expect(voiceRules('Greene Legal Group')).toContain('Prior results do not guarantee a similar outcome');
  });
  it('leave out the parts that are not for captions', () => {
    expect(voiceRules('Right Girl Media')).not.toContain('Email Copy');
    expect(voiceRules('Right Girl Media')).not.toContain('BLOG POST');
  });
});

describe('machine-sounding lines', () => {
  const rules = (t: string) => findTells(t).map((x) => x.rule.split(':')[0]);
  it('are found: em dashes, banned words, dead openings, bait and "not X, it\'s Y"', () => {
    expect(rules('Adjusters are trained — every word protects them.')).toEqual(['em dash']);
    expect(rules('Unlock your settlement.')).toEqual(['banned word "Unlock"']);
    expect(rules("In today's world people get hurt.")).toEqual(['dead opening']);
    expect(rules('Let that sink in.')).toEqual(['engagement bait']);
    expect(rules("It's not about the prompt. It's about the context.")[0]).toMatch(/not X/);
    expect(rules('Stop hoping, start documenting.')[0]).toMatch(/not X/);
  });
  it('leave plain writing, and the hashtag row, alone', () => {
    expect(findTells('You said the wrong thing to the adjuster.\nHere is how to fix it.\nSave this.\n\n#rights #atlanta')).toEqual([]);
  });
});

describe('hashtags', () => {
  it('are cleaned to #word, each once', () => {
    expect(cleanTags(['#Law', 'law', 'car crash!', '', '#', 'Atlanta']).join(' ')).toBe('#Law #carcrash #Atlanta');
  });
});

describe("Claude's answer", () => {
  it('is read, with at most five tags and the cover second kept inside the video', () => {
    const p = parsePackage('Sure:\n{"hook":"H","caption":"H\\nbody","hashtags":["a","b","c","d","e","f"],"coverSec":99,"firstComment":""}', 12);
    expect(p.hashtags).toHaveLength(5);
    expect(p.coverSec).toBe(11.8);
    expect(parsePackage('{"caption":"x","coverSec":-3}', null).coverSec).toBe(0);
  });
  it('is refused when it is not a caption', () => {
    expect(() => parsePackage('no json', 10)).toThrow(/caption/);
    expect(() => parsePackage('{"hook":"x"}', 10)).toThrow(/caption/);
  });
});

describe('the checklist', () => {
  const ok = { workspaceName: 'Greene Legal Group', labelOn: true, approved: true };
  const tags = ['#a', '#b', '#c'];
  const fails = (caption: string, ctx = ok) => blockers(checkPackage({ caption, hashtags: tags }, ctx)).map((c) => c.id);

  it('passes clean law-firm copy', () => {
    expect(fails('You said the wrong thing to the adjuster.\nHere is how to fix it.\nSave this.')).toEqual([]);
  });
  it('stops dollar amounts, superlatives and guarantees', () => {
    expect(fails('We got $50,000 for her')).toEqual(['money']);
    expect(fails('We got her 2 million')).toEqual(['money']);
    expect(fails("Atlanta's best injury lawyer")).toEqual(['superlative']);
    expect(fails('We guarantee you win')).toEqual(['guarantee']);
  });
  it('wants the results disclaimer only when the post talks about results', () => {
    expect(fails('The insurance company offered little. We won her case.')).toEqual(['prior']);
    expect(fails('We won her case. Prior results do not guarantee a similar outcome.')).toEqual([]);
  });
  it('wants the on-screen label on, since the video may be dramatized', () => {
    expect(fails('Know your rights', { ...ok, labelOn: false })).toEqual(['label']);
  });
  it('holds Right Girl Media to the plain tips only', () => {
    const c = checkPackage({ caption: 'We won big, best in town', hashtags: tags }, { workspaceName: 'Right Girl Media', labelOn: false, approved: false });
    expect(blockers(c)).toEqual([]);
    expect(c.find((x) => x.id === 'approved')?.ok).toBe(false);
  });
  it('sets out the post text for the scheduler', () => {
    expect(postText({ caption: 'Line one\nLine two ', hashtags: ['#a', '#b'] })).toBe('Line one\nLine two\n\n#a #b');
  });
});

describe('a draft post package, over the API', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let token = '';
  let admin = '';
  let dir = '';
  const wasDir = config.editDir;
  const videoId = '11111111-1111-4111-8111-111111111111';
  const outId = '22222222-2222-4222-8222-222222222222';

  const call = (method: string, p: string, body?: unknown, as = token) =>
    fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
    config.editDir = dir;
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
    token = users.find((u) => u.role === 'user')!.token;
    admin = users.find((u) => u.role === 'admin')!.token;
    fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    const made = (file: string) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', file]);
    expect(made(path.join(dir, 'videos', `${videoId}.mp4`)).status).toBe(0);
    expect(made(path.join(dir, 'out', `${outId}.mp4`)).status).toBe(0);
    const plan = { steps: [], label: { enabled: false, text: 'DRAMATIZATION' }, broll: [] };
    const record = {
      id: videoId, name: 'tips.mp4', durationSec: 3, workspaceId: null, createdAt: new Date().toISOString(), kind: 'source',
      drafts: [{ n: 1, fileName: `${outId}.mp4`, createdAt: new Date().toISOString(), createdBy: 'Milo', status: 'draft', note: '', plan, changes: [] }],
    };
    fs.writeFileSync(path.join(dir, 'videos', `${videoId}.json`), JSON.stringify(record));
    fs.writeFileSync(path.join(dir, 'videos', `${videoId}.words.json`), JSON.stringify([{ w: 'Three', s: 0, e: 0.4 }, { w: 'mistakes', s: 0.4, e: 1 }]));
  });
  afterAll(async () => {
    config.editDir = wasDir;
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is written by Claude, stored on the draft, and checked', async () => {
    answer = JSON.stringify({ hook: 'Three mistakes cost you', caption: 'Three mistakes cost you\nAvoid them.\nSave this.', hashtags: ['rights', 'atlanta', 'injury'], coverSec: 1.5, firstComment: 'Which one surprised you?' });
    const res = await call('POST', `/edit/videos/${videoId}/drafts/1/package/write`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { package: { caption: string; hashtags: string[]; coverSec: number; checks: { id: string; ok: boolean }[] }; costUsd: number };
    expect(j.costUsd).toBe(0.0123);
    expect(j.package.hashtags).toEqual(['#rights', '#atlanta', '#injury']);
    expect(j.package.checks.find((c) => c.id === 'approved')?.ok).toBe(false);
    expect(seen.at(-1)?.user).toContain('Three mistakes');
    // kept with the draft
    const videos = (await (await call('GET', '/edit/videos')).json()) as { id: string; drafts: { package?: { caption: string } }[] }[];
    expect(videos.find((v) => v.id === videoId)?.drafts[0].package?.caption).toContain('Save this');
  });

  it('is sent the skills as its rules, and rewritten once when the first draft reads machine-written', async () => {
    const bad = { hook: 'H', caption: 'Adjusters are trained — every word protects them.\nSave this.', hashtags: ['a', 'b', 'c'], coverSec: 1, firstComment: '' };
    const good = { ...bad, caption: 'Adjusters are trained. Every word protects them.\nSave this.' };
    queue.push(JSON.stringify(bad), JSON.stringify(good));
    const before = seen.length;
    const j = (await (await call('POST', `/edit/videos/${videoId}/drafts/1/package/write`)).json()) as { package: { caption: string; checks: { id: string; ok: boolean }[] }; costUsd: number };
    expect(seen.length - before).toBe(2);
    expect(seen[before].system).toContain('ANTI-AI WRITING');
    expect(seen[before + 1].user).toContain('em dash');
    expect(j.package.caption).toBe(good.caption);
    expect(j.package.checks.find((c) => c.id === 'aitells')?.ok).toBe(true);
    expect(j.costUsd).toBeCloseTo(0.0246, 4); // both calls are paid for and shown
  });

  it('is asked for once only when the first draft is already clean', async () => {
    answer = JSON.stringify({ hook: 'H', caption: 'Clean line one.\nSave this.', hashtags: ['a', 'b', 'c'], coverSec: 1, firstComment: '' });
    const before = seen.length;
    await call('POST', `/edit/videos/${videoId}/drafts/1/package/write`);
    expect(seen.length - before).toBe(1);
  });

  it('is edited by hand and the checklist is worked out again', async () => {
    const res = await call('PUT', `/edit/videos/${videoId}/drafts/1/package`, { caption: 'We won it all. Save this.', hashtags: ['law', 'atl', 'rights'], coverSec: 2, firstComment: '', hook: '' });
    const p = (await res.json()) as { checks: { id: string; ok: boolean }[] };
    expect(res.status).toBe(200);
    expect(p.checks.find((c) => c.id === 'tags')?.ok).toBe(true); // three tags now
    expect(p.checks.some((c) => c.id === 'prior')).toBe(false); // this is the first workspace (Right Girl Media): no law-firm rules
    expect((await call('PUT', `/edit/videos/${videoId}/drafts/1/package`, { caption: 'x'.repeat(2300) })).status).toBe(400);
  });

  it('shows a cover frame at a second', async () => {
    const res = await call('POST', `/edit/videos/${videoId}/drafts/1/cover`, { time: 1 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { image: string }).image.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('follows approval: the checklist ticks once the admin approves', async () => {
    expect((await call('POST', `/edit/videos/${videoId}/drafts/1/submit`)).status).toBe(200);
    expect((await call('POST', `/edit/videos/${videoId}/drafts/1/approve`, {}, admin)).status).toBe(200);
    const videos = (await (await call('GET', '/edit/videos')).json()) as { id: string; drafts: { package: { checks: { id: string; ok: boolean }[] } }[] }[];
    expect(videos.find((v) => v.id === videoId)?.drafts[0].package.checks.find((c) => c.id === 'approved')?.ok).toBe(true);
  });

  it('downloads as one zip: video, cover, caption, checklist', async () => {
    const res = await call('GET', `/edit/videos/${videoId}/drafts/1/package.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('tips-v1.zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['caption.txt', 'checklist.txt', 'tips-v1-cover.jpg', 'tips-v1.mp4']);
    expect(new TextDecoder().decode(files['caption.txt'])).toBe('We won it all. Save this.\n\n#law #atl #rights');
    expect(files['tips-v1.mp4'].length).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(files['checklist.txt'])).toContain('[x] This version has been approved');
  });

  it('refuses a zip before the caption is written, and an unknown draft', async () => {
    expect((await call('GET', `/edit/videos/${videoId}/drafts/9/package.zip`)).status).toBe(404);
    expect((await call('POST', `/edit/videos/${videoId}/drafts/9/package/write`)).status).toBe(404);
  });
});
