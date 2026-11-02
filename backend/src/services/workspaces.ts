import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound, wrap } from '../lib/errors';

export interface Workspace {
  id: string;
  name: string;
  /** The first workspace. Content saved before workspaces existed (no workspace) belongs to it. */
  isDefault: boolean;
  /** How this account's content should sound, in her words. Used when writing reels, scripts and captions for it. */
  voice: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    workspace?: Workspace;
  }
}

const STARTERS = ['Right Girl Media', 'Greene Legal Group'];

/** Every workspace of the organization, creating the two starter ones for an organization that has none yet. */
export async function listWorkspaces(orgId: string): Promise<Workspace[]> {
  const read = () =>
    getDb().query<{ id: string; name: string; voice: string }>('SELECT id, name, voice FROM workspaces WHERE org_id=$1 ORDER BY position, created_at', [orgId]);
  let { rows } = await read();
  if (rows.length === 0) {
    for (const [i, name] of STARTERS.entries()) {
      await getDb().query('INSERT INTO workspaces (org_id, name, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [orgId, name, i]);
    }
    rows = (await read()).rows;
  }
  return rows.map((r, i) => ({ id: r.id, name: r.name, voice: r.voice ?? '', isDefault: i === 0 }));
}

/** The workspace named by the request, or the first one when none (or an unknown one) is named. */
export async function resolveWorkspace(orgId: string, requested: unknown): Promise<Workspace> {
  const all = await listWorkspaces(orgId);
  return all.find((w) => w.id === requested) ?? all[0];
}

/** Sets `req.workspace` from the `X-Workspace` header. Runs after authentication. */
export const attachWorkspace = wrap(async (req: Request, _res: Response, next: NextFunction) => {
  req.workspace = await resolveWorkspace(req.user!.orgId, req.headers['x-workspace']);
  next();
});

/**
 * SQL that limits rows to the workspace, adding its id to `params`. In the first workspace it also matches rows
 * saved before workspaces existed, which have none.
 */
export function inWorkspace(ws: Workspace, alias: string, params: unknown[]): string {
  params.push(ws.id);
  const col = `${alias}.workspace_id`;
  return ws.isDefault ? `(${col} = $${params.length} OR ${col} IS NULL)` : `${col} = $${params.length}`;
}

// ---- adding, renaming and removing workspaces ---------------------------------------------------------------

export const workspaceInput = z.object({
  name: z.string().trim().min(2, 'Give the workspace a name').max(60),
  voice: z.string().trim().max(1500).default(''),
});
export const workspacePatch = z.object({ name: z.string().trim().min(2).max(60).optional(), voice: z.string().trim().max(1500).optional() });

const taken = (e: unknown) => /unique|duplicate/i.test(e instanceof Error ? e.message : String(e));

export async function createWorkspace(orgId: string, input: z.infer<typeof workspaceInput>): Promise<Workspace> {
  await listWorkspaces(orgId); // makes sure the two starters exist first
  const { rows: pos } = await getDb().query<{ next: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM workspaces WHERE org_id=$1', [orgId]);
  try {
    await getDb().query('INSERT INTO workspaces (org_id, name, voice, position) VALUES ($1,$2,$3,$4)', [orgId, input.name, input.voice, pos[0].next]);
  } catch (e) {
    if (taken(e)) throw badRequest(`There is already a workspace called "${input.name}".`);
    throw e;
  }
  return (await listWorkspaces(orgId)).find((w) => w.name === input.name)!;
}

export async function updateWorkspace(orgId: string, id: string, p: z.infer<typeof workspacePatch>): Promise<Workspace> {
  const current = (await listWorkspaces(orgId)).find((w) => w.id === id);
  if (!current) throw notFound('Workspace not found');
  try {
    await getDb().query('UPDATE workspaces SET name=$3, voice=$4 WHERE id=$1 AND org_id=$2', [id, orgId, p.name ?? current.name, p.voice ?? current.voice]);
  } catch (e) {
    if (taken(e)) throw badRequest(`There is already a workspace called "${p.name}".`);
    throw e;
  }
  return (await listWorkspaces(orgId)).find((w) => w.id === id)!;
}

/** Every table that holds content for a workspace, and how many rows each has in this one. */
async function contentIn(workspaceId: string): Promise<{ table: string; rows: number }[]> {
  const { rows: tables } = await getDb().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' AND table_name <> 'workspaces' ORDER BY table_name`);
  const found: { table: string; rows: number }[] = [];
  for (const { table_name } of tables) {
    const { rows } = await getDb().query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table_name}" WHERE workspace_id=$1`, [workspaceId]);
    if (rows[0].n > 0) found.push({ table: table_name, rows: rows[0].n });
  }
  return found;
}

const FRIENDLY: Record<string, string> = {
  projects: 'projects', media_assets: 'media items', vault_clips: 'Vault files', vault_reels: 'reel ideas', study_refs: 'studied reels',
  ig_accounts: 'Instagram accounts', fb_pages: 'Facebook Pages', ad_accounts: 'ad accounts', prompts: 'prompts', workflows: 'workflows',
};

/** Only an empty workspace can go, and never the first: removing one with content would quietly move that content into the first workspace. */
export async function deleteWorkspace(orgId: string, id: string): Promise<void> {
  const all = await listWorkspaces(orgId);
  const ws = all.find((w) => w.id === id);
  if (!ws) throw notFound('Workspace not found');
  if (ws.isDefault) throw badRequest('The first workspace cannot be removed.');
  const used = await contentIn(id);
  if (used.length > 0) {
    throw badRequest(`"${ws.name}" still has ${used.map((u) => `${u.rows} ${FRIENDLY[u.table] ?? u.table.replace(/_/g, ' ')}`).join(', ')}. Remove or disconnect those first.`);
  }
  await getDb().query('DELETE FROM workspaces WHERE id=$1 AND org_id=$2', [id, orgId]);
}
