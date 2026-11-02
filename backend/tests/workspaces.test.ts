import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { voiceFor } from '../src/services/vault';

const ws = (name: string, voice = '') => ({ id: 'x', name, voice, isDefault: false });

describe('how a workspace sounds', () => {
  it('keeps the built-in voices for the two starter accounts, adding her notes to them', () => {
    expect(voiceFor(ws('Greene Legal Group'))).toMatch(/DRAMATIZATION/);
    const withNotes = voiceFor(ws('Greene Legal Group', 'Always mention free case reviews.'));
    expect(withNotes).toMatch(/DRAMATIZATION/); // the legal rules are never replaced
    expect(withNotes).toMatch(/Also: Always mention free case reviews\./);
    expect(voiceFor(ws('Right Girl Media'))).toMatch(/bold, direct, expert and warm/);
  });

  it('gives any other workspace its own notes, or a neutral voice that does not borrow another account\'s', () => {
    expect(voiceFor(ws('Nya Studio', 'Soft, funny, all lowercase.'))).toBe('Soft, funny, all lowercase.');
    const plain = voiceFor(ws('Nya Studio'));
    expect(plain).not.toMatch(/Right Girl|Greene|DRAMATIZATION/);
    expect(plain).toMatch(/Never invent facts/);
  });
});

describe('adding, renaming and removing workspaces', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let member = '';
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T>(r: Response) => (await r.json()) as T;
  const list = async () => (await json<{ workspaces: { id: string; name: string; voice: string; isDefault: boolean }[] }>(await call(admin, 'GET', '/workspaces'))).workspaces;

  beforeAll(async () => {
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = await json<{ role: string; token: string }[]>(await fetch(base + '/api/dev/users'));
    admin = users.find((u) => u.role === 'admin')!.token;
    member = users.find((u) => u.role === 'user')!.token;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });

  let nya = '';

  it('starts with the two starter workspaces, and only an admin can add one', async () => {
    expect((await list()).map((w) => w.name)).toEqual(['Right Girl Media', 'Greene Legal Group']);
    expect((await call(member, 'POST', '/workspaces', { name: 'Nya Studio' })).status).toBe(403);
    const res = await call(admin, 'POST', '/workspaces', { name: '  Nya Studio ', voice: 'Soft and funny.' });
    expect(res.status).toBe(201);
    const made = await json<{ id: string; name: string; voice: string; isDefault: boolean }>(res);
    nya = made.id;
    expect(made).toMatchObject({ name: 'Nya Studio', voice: 'Soft and funny.', isDefault: false });
    expect((await list()).map((w) => w.name)).toEqual(['Right Girl Media', 'Greene Legal Group', 'Nya Studio']);
  });

  it('refuses a duplicate or empty name', async () => {
    const dup = await call(admin, 'POST', '/workspaces', { name: 'Nya Studio' });
    expect(dup.status).toBe(400);
    expect((await json<{ error: { message: string } }>(dup)).error.message).toMatch(/already a workspace called "Nya Studio"/);
    expect((await call(admin, 'POST', '/workspaces', { name: ' ' })).status).toBe(400);
  });

  it('renames a workspace and changes its voice notes', async () => {
    const r = await call(admin, 'PATCH', `/workspaces/${nya}`, { name: 'Nya', voice: 'Warm, all lowercase.' });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ name: 'Nya', voice: 'Warm, all lowercase.' });
    expect((await call(member, 'PATCH', `/workspaces/${nya}`, { name: 'Hacked' })).status).toBe(403);
    expect((await call(admin, 'PATCH', `/workspaces/${nya}`, { name: 'Greene Legal Group' })).status).toBe(400); // taken
    expect((await call(admin, 'PATCH', '/workspaces/00000000-0000-4000-8000-000000000000', { name: 'X1' })).status).toBe(404);
  });

  it('keeps the work separate: a connected account lands in the workspace it was connected in', async () => {
    const o = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
    await db.query(`INSERT INTO ad_accounts (org_id, workspace_id, account_id, name, token_cipher) VALUES ($1,$2,'act_1','Nya ads','x')`, [o, nya]);
    const inNya = await json<unknown[]>(await fetch(`${base}/api/metrics/ads/accounts`, { headers: { Authorization: `Bearer ${admin}`, 'X-Workspace': nya } }));
    const inFirst = await json<unknown[]>(await call(admin, 'GET', '/metrics/ads/accounts'));
    expect(inNya).toHaveLength(1);
    expect(inFirst).toHaveLength(0);
  });

  it('will not remove a workspace that still has content, or the first one, and says what is in it', async () => {
    const full = await call(admin, 'DELETE', `/workspaces/${nya}`);
    expect(full.status).toBe(400);
    expect((await json<{ error: { message: string } }>(full)).error.message).toMatch(/"Nya" still has 1 ad accounts/);
    const first = (await list())[0];
    const refused = await call(admin, 'DELETE', `/workspaces/${first.id}`);
    expect(refused.status).toBe(400);
    expect((await json<{ error: { message: string } }>(refused)).error.message).toMatch(/first workspace cannot be removed/);
    expect((await list()).map((w) => w.name)).toContain('Nya');
  });

  it('removes an empty workspace, admin only', async () => {
    await db.query('DELETE FROM ad_accounts');
    expect((await call(member, 'DELETE', `/workspaces/${nya}`)).status).toBe(403);
    expect((await call(admin, 'DELETE', `/workspaces/${nya}`)).status).toBe(204);
    expect((await list()).map((w) => w.name)).toEqual(['Right Girl Media', 'Greene Legal Group']);
  });
});
