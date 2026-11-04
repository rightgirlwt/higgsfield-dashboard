import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';

describe('moving a project to another workspace', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let member = '';
  let first = '';
  let nya = '';
  let projectId = '';
  const call = (token: string, method: string, url: string, body?: unknown, workspace?: string) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(workspace ? { 'X-Workspace': workspace } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T>(r: Response) => (await r.json()) as T;
  const projectsIn = async (ws: string) => (await json<{ id: string; name: string }[]>(await call(admin, 'GET', '/projects', undefined, ws))).map((p) => p.name);
  const mediaIn = async (ws: string) => (await json<{ items: { id: string }[] }>(await call(admin, 'GET', '/media?limit=100', undefined, ws))).items.map((m) => m.id);

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
    const ws = await json<{ workspaces: { id: string }[] }>(await call(admin, 'GET', '/workspaces'));
    first = ws.workspaces[0].id;
    nya = (await json<{ id: string }>(await call(admin, 'POST', '/workspaces', { name: 'Nya' }))).id;
    const made = await call(admin, 'POST', '/projects', { name: "Nya's Story", type: 'micro_drama' }, first);
    projectId = (await json<{ id: string }>(made)).id;
    await call(admin, 'POST', '/projects', { name: 'Stays here', type: 'micro_drama' }, first);
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });

  const orgOf = async () => (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
  const take = async (title: string, project: string | null, ws: string) => {
    const org = await orgOf();
    const meta = project ? { source: 'studio', projectId: project, itemId: 'i1' } : { source: 'studio' };
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata, workspace_id) VALUES ($1,'photo',$2,'https://x/y.png','https://x/y.png',ARRAY['studio'],$3::jsonb,$4) RETURNING id`,
      [org, title, JSON.stringify(meta), ws],
    );
    return rows[0].id;
  };

  it('moves the project and the media it generated, and nothing else', async () => {
    const mine1 = await take('shot 1', projectId, first);
    const mine2 = await take('shot 2', projectId, first);
    const other = await take('unrelated', null, first);
    const before = await json<{ project: { updatedAt: string } }>(await call(admin, 'GET', `/projects/${projectId}`, undefined, first));

    const res = await call(admin, 'POST', `/projects/${projectId}/move`, { workspaceId: nya }, first);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ movedMedia: 2, workspace: { name: 'Nya' } });

    expect(await projectsIn(nya)).toEqual(["Nya's Story"]);
    expect(await projectsIn(first)).not.toContain("Nya's Story");
    expect(await projectsIn(first)).toContain('Stays here');
    const inNya = await mediaIn(nya);
    expect(inNya).toEqual(expect.arrayContaining([mine1, mine2]));
    expect(inNya).not.toContain(other);
    expect(await mediaIn(first)).toContain(other);
    // moving is not editing: the "updated" time is untouched
    const after = await json<{ project: { updatedAt: string } }>(await call(admin, 'GET', `/projects/${projectId}`, undefined, nya));
    expect(after.project.updatedAt).toBe(before.project.updatedAt);
  });

  it('can be moved back, and refuses an unknown workspace, a missing project, or anyone who is not an admin', async () => {
    expect((await call(member, 'POST', `/projects/${projectId}/move`, { workspaceId: first }, nya)).status).toBe(403);
    expect((await call(admin, 'POST', `/projects/${projectId}/move`, { workspaceId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await call(admin, 'POST', '/projects/00000000-0000-4000-8000-000000000000/move', { workspaceId: first })).status).toBe(404);
    expect((await call(admin, 'POST', `/projects/${projectId}/move`, { workspaceId: 'not-an-id' })).status).toBe(400);
    expect((await call(admin, 'POST', `/projects/${projectId}/move`, { workspaceId: first }, nya)).status).toBe(200);
    expect(await projectsIn(first)).toContain("Nya's Story");
    expect(await projectsIn(nya)).toEqual([]);
  });
});
