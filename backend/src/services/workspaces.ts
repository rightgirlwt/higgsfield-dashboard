import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../ctx';
import { wrap } from '../lib/errors';

export interface Workspace {
  id: string;
  name: string;
  /** The first workspace. Content saved before workspaces existed (no workspace) belongs to it. */
  isDefault: boolean;
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
    getDb().query<{ id: string; name: string }>('SELECT id, name FROM workspaces WHERE org_id=$1 ORDER BY position, created_at', [orgId]);
  let { rows } = await read();
  if (rows.length === 0) {
    for (const [i, name] of STARTERS.entries()) {
      await getDb().query('INSERT INTO workspaces (org_id, name, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [orgId, name, i]);
    }
    rows = (await read()).rows;
  }
  return rows.map((r, i) => ({ id: r.id, name: r.name, isDefault: i === 0 }));
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
