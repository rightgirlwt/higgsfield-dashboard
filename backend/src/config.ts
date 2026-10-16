import dotenv from 'dotenv';
import crypto from 'node:crypto';

dotenv.config();

const env = process.env;
const nodeEnv = env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  nodeEnv,
  isProd,
  isTest: nodeEnv === 'test',
  port: Number(env.PORT ?? 4000),
  clientOrigins: (env.CLIENT_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** When unset, an embedded Postgres (PGlite) is used so the app runs with zero setup. */
  databaseUrl: env.DATABASE_URL || '',
  pgliteDir: env.PGLITE_DIR ?? './.data/pglite',
  databaseSsl: bool(env.DATABASE_SSL, false),

  /** `dev` = built-in seeded users (never allowed in production). `clerk` = verify Clerk session JWTs. */
  authProvider: (env.AUTH_PROVIDER ?? (isProd ? 'clerk' : 'dev')) as 'dev' | 'clerk',
  clerkSecretKey: env.CLERK_SECRET_KEY ?? '',
  clerkJwtKey: env.CLERK_JWT_KEY ?? '',

  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  higgsfieldApiKey: env.HIGGSFIELD_API_KEY ?? '',
  higgsfieldApiBase: env.HIGGSFIELD_API_BASE ?? '',
  elevenlabsApiKey: env.ELEVENLABS_API_KEY ?? '',

  secretsKey: env.SECRETS_ENCRYPTION_KEY ?? '',
  seedDemo: bool(env.SEED_DEMO_DATA, !isProd),
  queueConcurrency: Number(env.QUEUE_CONCURRENCY ?? 2),
  /** Parallel image/video generations (mostly idle polling, so this can be generous). */
  generationConcurrency: Number(env.GENERATION_CONCURRENCY ?? 8),
  /** How often to ask Higgsfield for status, and how long to wait before giving up. */
  studioPollMs: Number(env.STUDIO_POLL_MS ?? (nodeEnv === 'test' ? 15 : 4000)),
  studioDeadlineMs: Number(env.STUDIO_DEADLINE_MS ?? 600_000),
  logLevel: env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
};

/** Derive the 32-byte AES key. Dev falls back to a fixed key (with a warning); production must set one. */
export function secretsKeyBytes(): Buffer {
  if (config.secretsKey) {
    const raw = /^[0-9a-f]{64}$/i.test(config.secretsKey)
      ? Buffer.from(config.secretsKey, 'hex')
      : crypto.createHash('sha256').update(config.secretsKey).digest();
    return raw;
  }
  return crypto.createHash('sha256').update('higgsfield-dashboard-dev-only-key').digest();
}

export function assertProductionConfig(): void {
  const problems: string[] = [];
  if (config.isProd) {
    if (config.authProvider === 'dev') problems.push('AUTH_PROVIDER=dev is not allowed in production');
    if (!config.secretsKey) problems.push('SECRETS_ENCRYPTION_KEY is required in production');
    if (!config.databaseUrl) problems.push('DATABASE_URL is required in production');
    if (config.authProvider === 'clerk' && !config.clerkSecretKey && !config.clerkJwtKey) {
      problems.push('CLERK_SECRET_KEY (or CLERK_JWT_KEY) is required when AUTH_PROVIDER=clerk');
    }
  }
  if (problems.length) {
    throw new Error(`Invalid production configuration:\n - ${problems.join('\n - ')}`);
  }
}
