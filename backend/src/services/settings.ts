import { getDb } from '../ctx';
import { DEFAULT_MODEL } from '../lib/pricing';

export interface Defaults {
  model: string;
  maxTokens: number;
  temperature: number | null;
}

export interface StorageConfig {
  provider: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
}

const DEFAULTS: Defaults = { model: DEFAULT_MODEL, maxTokens: 1024, temperature: null };
const STORAGE: StorageConfig = { provider: 's3', endpoint: '', region: 'us-east-1', bucket: '', publicBaseUrl: '', forcePathStyle: false };

export async function getSetting<T>(orgId: string, key: string, fallback: T): Promise<T> {
  const { rows } = await getDb().query<{ value: T }>('SELECT value FROM org_settings WHERE org_id = $1 AND key = $2', [orgId, key]);
  return rows[0] ? { ...fallback, ...rows[0].value } : fallback;
}

export async function putSetting(orgId: string, key: string, value: unknown): Promise<void> {
  await getDb().query(
    `INSERT INTO org_settings (org_id, key, value) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [orgId, key, JSON.stringify(value)],
  );
}

export const getDefaults = (orgId: string) => getSetting<Defaults>(orgId, 'defaults', DEFAULTS);
export const getStorage = (orgId: string) => getSetting<StorageConfig>(orgId, 'storage', STORAGE);
