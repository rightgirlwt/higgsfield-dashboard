import { config } from '../config';
import { getDb } from '../ctx';
import { decryptSecret, encryptSecret, last4 } from '../lib/crypto';

export const SECRET_NAMES = ['anthropic', 'higgsfield', 's3_access_key_id', 's3_secret_access_key'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const ENV_FALLBACK: Partial<Record<SecretName, string>> = {
  anthropic: config.anthropicApiKey,
  higgsfield: config.higgsfieldApiKey,
};

export async function setSecret(orgId: string, name: SecretName, value: string): Promise<void> {
  await getDb().query(
    `INSERT INTO secrets (org_id, name, ciphertext, last4) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, last4 = EXCLUDED.last4, updated_at = now()`,
    [orgId, name, encryptSecret(value), last4(value)],
  );
}

export async function deleteSecret(orgId: string, name: SecretName): Promise<void> {
  await getDb().query('DELETE FROM secrets WHERE org_id = $1 AND name = $2', [orgId, name]);
}

/** Org-stored key wins; environment variable is the fallback; undefined → feature runs in simulated mode. */
export async function getSecret(orgId: string, name: SecretName): Promise<string | undefined> {
  const { rows } = await getDb().query<{ ciphertext: string }>(
    'SELECT ciphertext FROM secrets WHERE org_id = $1 AND name = $2',
    [orgId, name],
  );
  if (rows[0]) return decryptSecret(rows[0].ciphertext);
  return ENV_FALLBACK[name] || undefined;
}

export interface SecretStatus {
  name: SecretName;
  configured: boolean;
  source: 'stored' | 'environment' | 'none';
  last4: string | null;
  updatedAt: string | null;
}

/** Never returns key material — only whether one is set and its last 4 characters. */
export async function listSecretStatus(orgId: string): Promise<SecretStatus[]> {
  const { rows } = await getDb().query<{ name: SecretName; last4: string; updated_at: Date }>(
    'SELECT name, last4, updated_at FROM secrets WHERE org_id = $1',
    [orgId],
  );
  const stored = new Map(rows.map((r) => [r.name, r]));
  return SECRET_NAMES.map((name) => {
    const s = stored.get(name);
    if (s) return { name, configured: true, source: 'stored', last4: s.last4, updatedAt: new Date(s.updated_at).toISOString() };
    if (ENV_FALLBACK[name]) return { name, configured: true, source: 'environment', last4: last4(ENV_FALLBACK[name]!), updatedAt: null };
    return { name, configured: false, source: 'none', last4: null, updatedAt: null };
  });
}
