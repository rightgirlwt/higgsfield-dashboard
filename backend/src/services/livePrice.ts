import { createHash } from 'node:crypto';
import { config } from '../config';
import { estimate, getHfConfig } from './higgsfield';

interface Entry {
  at: number;
  usd: number | null;
}

/** Ten minutes: long enough that a cost dialog and the click that follows see the same number, short enough to follow a price change. */
const TTL_MS = 10 * 60_000;
const cache = new Map<string, Entry>();

/**
 * Higgsfield's own price for one request (USD), or null when it can't be had (not connected, a variable-priced model that only
 * returns a written description, or any error). Callers fall back to the snapshot price, so a failed lookup never blocks work.
 */
export async function livePrice(orgId: string, path: string, body: Record<string, unknown>): Promise<number | null> {
  const key = createHash('sha256').update(`${orgId}|${path}|${JSON.stringify(body)}`).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.usd;
  const cfg = await getHfConfig(orgId);
  if (!cfg) return null;
  let usd: number | null = null;
  try {
    const e = await Promise.race([estimate(cfg, path, body), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('estimate timed out')), config.isTest ? 2000 : 8000).unref())]);
    usd = e.kind === 'price' ? e.usd : null;
  } catch {
    usd = null;
  }
  cache.set(key, { at: Date.now(), usd });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
  return usd;
}

export const clearLivePriceCache = () => cache.clear();

/** Run several lookups a few at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
