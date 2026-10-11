import { config } from '../config';
import { getSecret } from './secrets';

/**
 * Higgsfield integration boundary.
 *
 * IMPORTANT: the HTTP shape below is an ASSUMPTION — a minimal contract this app expects from
 * `${HIGGSFIELD_API_BASE}`. It has not been verified against Higgsfield's real API (no public spec
 * was available while building). Adjust `fetchGenerations` / `fetchUsage` to match the real endpoints.
 * With no API key + base URL configured, everything returns clearly-flagged simulated data.
 *
 *   GET {base}/generations?limit=N  -> { items: [{ id, type: 'photo'|'video', title, url, thumbUrl?, createdAt, tags?: string[] }] }
 *   GET {base}/usage?from=ISO&to=ISO -> { credits: number, costUsd: number }
 */
export interface HiggsfieldGeneration {
  id: string;
  type: 'photo' | 'video';
  title: string;
  url: string;
  thumbUrl?: string;
  createdAt: string;
  tags?: string[];
}

export interface HiggsfieldUsage {
  credits: number;
  costUsd: number;
  simulated: boolean;
}

async function creds(orgId: string): Promise<{ key: string; base: string } | null> {
  const key = await getSecret(orgId, 'higgsfield');
  if (!key || !config.higgsfieldApiBase) return null;
  return { key, base: config.higgsfieldApiBase.replace(/\/$/, '') };
}

export async function isLive(orgId: string): Promise<boolean> {
  return (await creds(orgId)) !== null;
}

export async function fetchGenerations(orgId: string, limit = 10): Promise<{ items: HiggsfieldGeneration[]; simulated: boolean }> {
  const c = await creds(orgId);
  if (!c) {
    const now = Date.now();
    return {
      simulated: true,
      items: Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
        id: `sim-${now}-${i}`,
        type: i % 2 ? 'video' : 'photo',
        title: `Simulated generation ${i + 1}`,
        url: '',
        createdAt: new Date(now - i * 60_000).toISOString(),
        tags: ['simulated'],
      })),
    };
  }
  const res = await fetch(`${c.base}/generations?limit=${limit}`, {
    headers: { Authorization: `Bearer ${c.key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Higgsfield API responded ${res.status}`);
  const body = (await res.json()) as { items?: HiggsfieldGeneration[] };
  return { items: body.items ?? [], simulated: false };
}

export async function fetchUsage(orgId: string, from: Date, to: Date): Promise<HiggsfieldUsage> {
  const c = await creds(orgId);
  if (!c) return { credits: 0, costUsd: 0, simulated: true };
  const res = await fetch(`${c.base}/usage?from=${from.toISOString()}&to=${to.toISOString()}`, {
    headers: { Authorization: `Bearer ${c.key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Higgsfield API responded ${res.status}`);
  const body = (await res.json()) as { credits?: number; costUsd?: number };
  return { credits: body.credits ?? 0, costUsd: body.costUsd ?? 0, simulated: false };
}
