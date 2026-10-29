import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { cleanLabel, DEFAULT_LABEL, labelFilter, labelSchema, stepSchema } from '../src/services/effects';

let db: Db;
let server: http.Server;
let base = '';
let token = '';
const wasDir = config.effectsDir;

beforeAll(async () => {
  config.effectsDir = '/definitely/not/installed';
  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await (await fetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
  token = users.find((u) => u.role === 'user')!.token;
});
afterAll(async () => {
  config.effectsDir = wasDir;
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('the dramatization label', () => {
  it('is off unless asked for, and defaults to the standard wording', () => {
    expect(labelSchema.parse({}).enabled).toBe(false);
    expect(labelSchema.parse({}).text).toBe(DEFAULT_LABEL);
  });

  it('keeps only plain characters so the text cannot change the ffmpeg command', () => {
    expect(cleanLabel(`ACTOR PORTRAYAL - NOT AN ACTUAL CLIENT`)).toBe('ACTOR PORTRAYAL - NOT AN ACTUAL CLIENT');
    expect(cleanLabel(`x':drawbox=w=1;[a]%{pts} \\ "quoted"`)).not.toMatch(/[':;\\"%{}\[\]=]/);
    expect(cleanLabel('   ')).toBe(DEFAULT_LABEL);
    expect(labelFilter('DRAMATIZATION')).toContain("text='DRAMATIZATION'");
  });
});

describe('effect steps', () => {
  it('accepts an effect with text and options, and rejects odd option names', () => {
    expect(stepSchema.parse({ fx: 'backdrop-word', start: 1, end: 3, text: 'CLAUDE', options: { color: '#99577a' } }).options).toEqual({ color: '#99577a' });
    expect(() => stepSchema.parse({ fx: 'orbit', start: 1, end: 3, options: { 'bad key; rm': 1 } })).toThrow();
    expect(() => stepSchema.parse({ fx: '../etc', start: 1, end: 3 })).toThrow();
  });
});

describe('editing routes', () => {
  it('says plainly when the effects engine is not installed', async () => {
    const r = await (await call('GET', '/edit/effects')).json();
    expect(r.engine.ready).toBe(false);
    expect(r.engine.message).toMatch(/not set up/);
    expect(r.effects).toEqual([]);
  });

  it('refuses a preview or render without the engine, and unknown videos', async () => {
    const steps = [{ fx: 'orbit', start: 1, end: 3 }];
    const videoId = '11111111-1111-4111-8111-111111111111';
    expect((await call('POST', '/edit/preview', { videoId, steps, time: 2 })).status).toBe(400);
    expect((await call('POST', '/edit/render', { videoId, steps })).status).toBe(400);
  });

  it('lists uploaded videos per workspace (none yet) and only serves finished edits it made', async () => {
    expect(await (await call('GET', '/edit/videos')).json()).toEqual([]);
    expect((await fetch(base + '/api/edit/files/not-a-real-file.mp4')).status).toBe(404);
    expect((await fetch(base + '/api/edit/files/11111111-1111-4111-8111-111111111111.mp4')).status).toBe(404);
    expect((await fetch(base + '/api/edit/files/..%2F..%2Fsecret.mp4')).status).toBe(404);
  });
});
