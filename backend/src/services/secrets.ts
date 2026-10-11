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
  /** Shape check only (never the value): e.g. "ID 36 chars : secret 64 chars". */
  format?: string;
  formatOk?: boolean;
}

/** Higgsfield keys must be `ID:SECRET` - one colon-separated value with no spaces. */
export const HIGGSFIELD_KEY_RE = /^[^\s:]+:[^\s:]+$/;

export function describeHiggsfieldKey(key: string): { format: string; formatOk: boolean } {
  if (/\s/.test(key)) return { format: 'contains a space or line break', formatOk: false };
  if (/["'`<>{}\[\]\\]/.test(key)) return { format: 'contains stray characters such as quotes or brackets (copy only the value itself)', formatOk: false };
  const i = key.indexOf(':');
  if (i < 0) return { format: 'no ":" found - needs ID:SECRET', formatOk: false };
  const [id, secret] = [key.slice(0, i), key.slice(i + 1)];
  const cls = /^[0-9a-f]+$/i.test(secret) ? 'hex' : /^[A-Za-z0-9]+$/.test(secret) ? 'letters+digits' : /^[A-Za-z0-9._~+/=-]+$/.test(secret) ? 'letters/digits/symbols' : 'unusual characters';
  const extras = [secret.includes(':') ? 'secret contains another ":"' : '', secret.includes(id) ? 'secret contains the ID again' : ''].filter(Boolean);
  return { format: `ID ${id.length} chars : secret ${secret.length} chars (${cls})${extras.length ? '; ' + extras.join('; ') : ''}`, formatOk: HIGGSFIELD_KEY_RE.test(key) && extras.length === 0 };
}

/** Never returns key material — only whether one is set, its last 4 characters and (for Higgsfield) its shape. */
export async function listSecretStatus(orgId: string): Promise<SecretStatus[]> {
  const { rows } = await getDb().query<{ name: SecretName; last4: string; updated_at: Date }>(
    'SELECT name, last4, updated_at FROM secrets WHERE org_id = $1',
    [orgId],
  );
  const stored = new Map(rows.map((r) => [r.name, r]));
  const out: SecretStatus[] = SECRET_NAMES.map((name) => {
    const s = stored.get(name);
    if (s) return { name, configured: true, source: 'stored', last4: s.last4, updatedAt: new Date(s.updated_at).toISOString() };
    if (ENV_FALLBACK[name]) return { name, configured: true, source: 'environment', last4: last4(ENV_FALLBACK[name]!), updatedAt: null };
    return { name, configured: false, source: 'none', last4: null, updatedAt: null };
  });
  const hf = out.find((s) => s.name === 'higgsfield');
  if (hf?.configured) {
    const key = await getSecret(orgId, 'higgsfield');
    if (key) Object.assign(hf, describeHiggsfieldKey(key));
  }
  return out;
}
