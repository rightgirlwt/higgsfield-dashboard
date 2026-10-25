import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { logger } from '../logger';
import { uploadFile, UPLOAD_TYPES, type HfConfig } from './higgsfield';

/**
 * Local copies of everything hosted on Higgsfield storage.
 *
 * Higgsfield removes uploaded files and generated outputs after about a week, but a project keeps pointing at the old links.
 * Every upload and every result is therefore also saved under `filesDir`, named by a hash of its link, and before a generation
 * any media link that has expired is re-uploaded from that copy.
 */
const MAX_COPY_BYTES = 600 * 1024 * 1024;
/** Which links are Higgsfield-hosted files (and so expire). An object so tests can point it at a fake host. */
export const hostedMedia = { pattern: /\.cloudfront\.net\//i };
const keyOf = (url: string) => crypto.createHash('sha256').update(url).digest('hex');
const filePath = (url: string) => path.join(config.filesDir, keyOf(url));

const EXT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', wav: 'audio/wav' };
const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

export async function saveLocalCopy(url: string, data: Buffer, contentType: string): Promise<void> {
  if (!config.localCopies || !isHttp(url) || data.length === 0 || data.length > MAX_COPY_BYTES) return;
  try {
    await fs.mkdir(config.filesDir, { recursive: true });
    await fs.writeFile(filePath(url), data);
    await fs.writeFile(`${filePath(url)}.type`, contentType);
  } catch (e) {
    logger.warn('could not save a local copy of a media file', { err: String(e) });
  }
}

/** Downloads a freshly generated result and keeps it. Never throws: a missing copy must not fail a generation. */
export async function saveLocalCopyFromUrl(url: string): Promise<void> {
  if (!config.localCopies || !isHttp(url)) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) return void logger.warn('could not download a result to keep a copy', { status: res.status });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() || EXT_TYPES[url.split('?')[0].split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
    await saveLocalCopy(url, Buffer.from(await res.arrayBuffer()), type);
  } catch (e) {
    logger.warn('could not download a result to keep a copy', { err: String(e) });
  }
}

export async function readLocalCopy(url: string): Promise<{ data: Buffer; contentType: string } | null> {
  try {
    const [data, type] = await Promise.all([fs.readFile(filePath(url)), fs.readFile(`${filePath(url)}.type`, 'utf8')]);
    return { data, contentType: type.trim() };
  } catch {
    return null;
  }
}

/** True only for the answers Higgsfield's storage gives for a removed file. A network error is not treated as expiry. */
export async function isExpired(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    return res.status === 403 || res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

type Media = Partial<Record<string, string[]>>;

/**
 * Before a generation: swaps every expired link for a fresh upload of the saved copy. If a link has expired and no copy exists
 * it stops with a plain message, before anything is sent to Higgsfield (so nothing is charged).
 */
export async function refreshExpiredMedia(cfg: HfConfig, media: Media | undefined): Promise<{ media: Media | undefined; rehosted: number }> {
  if (!media) return { media, rehosted: 0 };
  const urls = [...new Set(Object.values(media).flatMap((l) => (l ?? []).filter(isHttp)))];
  // Only links on Higgsfield's own storage can expire this way; leave anyone else's links alone.
  const hosted = urls.filter((u) => hostedMedia.pattern.test(u));
  const expired = (await Promise.all(hosted.map(async (u) => ((await isExpired(u)) ? u : null)))).filter((u): u is string => !!u);
  if (expired.length === 0) return { media, rehosted: 0 };

  const fresh = new Map<string, string>();
  const lost: string[] = [];
  for (const old of expired) {
    const copy = await readLocalCopy(old);
    if (!copy) {
      lost.push(old);
      continue;
    }
    const allowed = Object.keys(UPLOAD_TYPES).includes(copy.contentType) ? copy.contentType : 'application/octet-stream';
    fresh.set(old, await uploadFile(cfg, copy.data, allowed));
  }
  if (lost.length) {
    throw badRequest(
      `${lost.length === 1 ? 'A reference file has' : `${lost.length} reference files have`} expired at Higgsfield and no saved copy exists, so nothing was sent and nothing was charged. Upload ${lost.length === 1 ? 'it' : 'them'} again from the original${lost.length === 1 ? '' : 's'}. Expired: ${lost.map((u) => u.split('/').pop()).join(', ')}`,
    );
  }
  const out: Media = {};
  for (const [role, list] of Object.entries(media)) out[role] = (list ?? []).map((u) => fresh.get(u) ?? u);
  return { media: out, rehosted: fresh.size };
}
