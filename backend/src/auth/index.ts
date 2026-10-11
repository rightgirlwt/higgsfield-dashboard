import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { getDb } from '../ctx';
import { forbidden, unauthorized, wrap } from '../lib/errors';
import { logger } from '../logger';

export type Role = 'admin' | 'user' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, user: 2, admin: 3 };

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: Role;
}
const toUser = (r: UserRow): AuthUser => ({ id: r.id, orgId: r.org_id, email: r.email, name: r.name, role: r.role });

async function resolveDev(token: string): Promise<AuthUser> {
  // Dev tokens look like `dev:<user-uuid>`; only ever accepted when AUTH_PROVIDER=dev.
  if (!token.startsWith('dev:')) throw unauthorized('Invalid dev token');
  const id = token.slice(4);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw unauthorized('Invalid dev token');
  const { rows } = await getDb().query<UserRow>('SELECT id, org_id, email, name, role FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw unauthorized('Unknown user');
  return toUser(rows[0]);
}

async function resolveClerk(token: string): Promise<AuthUser> {
  const { verifyToken, createClerkClient } = await import('@clerk/backend');
  let sub: string;
  try {
    const claims = await verifyToken(token, {
      secretKey: config.clerkSecretKey || undefined,
      jwtKey: config.clerkJwtKey || undefined,
    });
    sub = claims.sub;
  } catch (err) {
    logger.warn('clerk token rejected', { err: String(err) });
    throw unauthorized('Invalid or expired session');
  }

  const db = getDb();
  const existing = await db.query<UserRow>('SELECT id, org_id, email, name, role FROM users WHERE clerk_id = $1', [sub]);
  if (existing.rows[0]) return toUser(existing.rows[0]);

  // First sign-in: fetch profile from Clerk, then link to an invited row or bootstrap a new org.
  const clerk = createClerkClient({ secretKey: config.clerkSecretKey });
  const cu = await clerk.users.getUser(sub);
  const email = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)?.emailAddress ?? cu.emailAddresses[0]?.emailAddress;
  if (!email) throw unauthorized('Clerk account has no email address');
  const name = [cu.firstName, cu.lastName].filter(Boolean).join(' ') || email;

  const invited = await db.query<UserRow>(
    'UPDATE users SET clerk_id = $1, name = $2 WHERE lower(email) = lower($3) AND clerk_id IS NULL RETURNING id, org_id, email, name, role',
    [sub, name, email],
  );
  if (invited.rows[0]) return toUser(invited.rows[0]);

  return db.tx(async (t) => {
    const org = await t.query<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [`${name}'s workspace`]);
    const u = await t.query<UserRow>(
      `INSERT INTO users (org_id, clerk_id, email, name, role) VALUES ($1,$2,$3,$4,'admin')
       RETURNING id, org_id, email, name, role`,
      [org.rows[0].id, sub, email, name],
    );
    return toUser(u.rows[0]);
  });
}

export async function resolveToken(token: string): Promise<AuthUser> {
  return config.authProvider === 'dev' ? resolveDev(token) : resolveClerk(token);
}

export const authenticate = wrap(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/i.exec(header);
  if (!m) throw unauthorized();
  req.user = await resolveToken(m[1]);
  next();
});

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (RANK[req.user.role] < RANK[min]) return next(forbidden(`Requires ${min} role`));
    next();
  };
}

/** Viewers are read-only: any non-GET request needs at least the `user` role. */
export function writesRequireUser(req: Request, _res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.user?.role === 'viewer') {
    return next(forbidden('Viewers have read-only access'));
  }
  next();
}
