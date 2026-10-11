import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config';
import { logger } from '../logger';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run `fn` inside a transaction; commits on resolve, rolls back on throw. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pglite' | 'pg';
}

/** The slice of the PGlite API we use (structural, so CJS/ESM type duplication can't bite). */
interface PgliteRunner {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; affectedRows?: number }>;
}
interface PgliteLike extends PgliteRunner {
  waitReady: Promise<void>;
  transaction<T>(fn: (tx: PgliteRunner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function createPglite(dir: string | undefined): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  let pg: PgliteLike;
  if (dir) {
    fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
    pg = new PGlite(path.resolve(dir)) as unknown as PgliteLike;
  } else {
    pg = new PGlite() as unknown as PgliteLike;
  }
  await pg.waitReady;

  const wrap = (runner: PgliteRunner): Omit<Db, 'tx' | 'close' | 'kind'> => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await runner.query(sql, params as any[]);
      // PGlite reports affectedRows = 0 for SELECT, so fall back to the row count (matches node-pg).
      return { rows: r.rows as T[], rowCount: r.affectedRows || r.rows.length };
    },
  });

  const db: Db = {
    kind: 'pglite',
    ...wrap(pg),
    async tx(fn) {
      return pg.transaction(async (t) => {
        const inner: Db = { ...db, ...wrap(t as any), tx: (f) => f(inner) };
        return fn(inner);
      });
    },
    async close() {
      await pg.close();
    },
  };
  return db;
}

async function createPg(url: string): Promise<Db> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  pool.on('error', (err) => logger.error('pg pool error', { err: String(err) }));

  const db: Db = {
    kind: 'pg',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pool.query(sql, params as any[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner: Db = {
          ...db,
          async query<T>(sql: string, params: unknown[] = []) {
            const r = await client.query(sql, params as any[]);
            return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
          },
          tx: (f) => f(inner),
        };
        const out = await fn(inner);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}

/** `memory` → ephemeral PGlite (tests); no URL → persistent PGlite on disk; URL → real Postgres. */
export async function createDb(opts: { url?: string; memory?: boolean } = {}): Promise<Db> {
  if (opts.memory) return createPglite(undefined);
  const url = opts.url ?? config.databaseUrl;
  if (url) return createPg(url);
  logger.warn('DATABASE_URL not set — using embedded PGlite (dev only)', { dir: config.pgliteDir });
  return createPglite(config.pgliteDir);
}

