import crypto from 'node:crypto';
import { config } from '../config';
import { placeholderImage } from '../lib/placeholder';
import { getSecret } from './secrets';
import { getSetting } from './settings';

/**
 * Higgsfield generation platform client.
 *
 * Contract (taken from how the open-source studio github.com/wide-trace/open-higgsfield talks to the
 * platform; not an official spec, so verify against your account's API docs):
 *   POST {base}/{model-path}                 body = model-specific JSON  -> { request_id, status, ... }
 *   GET  {base}/requests/{id}/status                                      -> { status, images:[{url}], video:{url}, error }
 *   Header  Authorization: Key <id:secret>
 *   status values seen: completed | failed | nsfw | canceled; anything else = still working.
 *
 * With no key or no base URL configured this module runs in SIMULATED mode: it fabricates a request,
 * "finishes" it after a couple of polls and returns placeholder media. Everything is flagged simulated.
 */
export interface HfConfig {
  baseUrl: string;
  key: string;
}

export interface HfStatus {
  status: string;
  images: string[];
  video: string | null;
  error: string | null;
}

export class HiggsfieldError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MODEL_PATH = /^[a-z0-9][a-z0-9._/-]*$/i;
export const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);

/** Validates an admin-supplied API base URL. HTTPS is mandatory in production. */
export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must start with http:// or https://');
  if (url.username || url.password) throw new Error('Base URL must not contain credentials');
  if (config.isProd && url.protocol !== 'https:') throw new Error('Base URL must use https in production');
  // Higgsfield's docs show full model URLs ("send requests to https://api.higgsfield.ai/higgsfield-ai/soul/...").
  // The base is only the host; drop any pasted path so every model URL isn't doubled (which 404s).
  if (url.hostname === 'higgsfield.ai' || url.hostname.endsWith('.higgsfield.ai')) return url.origin;
  return url.toString().replace(/\/+$/, '');
}

export async function getBaseUrl(orgId: string): Promise<string> {
  const stored = await getSetting<{ baseUrl: string }>(orgId, 'higgsfield', { baseUrl: '' });
  return stored.baseUrl || config.higgsfieldApiBase.replace(/\/+$/, '');
}

/** null → simulated mode. */
export async function getHfConfig(orgId: string): Promise<HfConfig | null> {
  const [key, baseUrl] = await Promise.all([getSecret(orgId, 'higgsfield'), getBaseUrl(orgId)]);
  return key && baseUrl ? { key, baseUrl } : null;
}

async function call(cfg: HfConfig, method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Key ${cfg.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Network failure / timeout: never leak internals (or the key), just say what happened.
    throw new HiggsfieldError(502, (err as Error)?.name === 'TimeoutError' ? 'Higgsfield did not respond in time' : 'Could not reach the Higgsfield API. Check the API address in Settings → Higgsfield.');
  }
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    // Surface whatever the platform says (string detail, structured detail, or raw text) without ever echoing our key.
    const detail =
      typeof payload?.detail === 'string' ? payload.detail
      : typeof payload === 'string' ? payload.slice(0, 200)
      : payload ? JSON.stringify(payload.detail ?? payload.error ?? payload).slice(0, 300)
      : '';
    throw new HiggsfieldError(res.status, `Higgsfield API responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return payload;
}

export async function submit(cfg: HfConfig, modelPath: string, body: Record<string, unknown>): Promise<{ requestId: string; status: string }> {
  if (!MODEL_PATH.test(modelPath) || modelPath.includes('..')) throw new HiggsfieldError(400, 'Invalid model path');
  // Higgsfield recommends an Idempotency-Key on every submission so a retry can't create a duplicate.
  const r = await call(cfg, 'POST', `/${modelPath}`, body, { 'Idempotency-Key': crypto.randomUUID() });
  if (!r || typeof r.request_id !== 'string' || !r.request_id) throw new HiggsfieldError(502, 'Higgsfield response was missing request_id');
  return { requestId: r.request_id, status: typeof r.status === 'string' ? r.status : 'queued' };
}

export async function getStatus(cfg: HfConfig, requestId: string): Promise<HfStatus> {
  if (!requestId) throw new HiggsfieldError(400, 'Missing request id');
  const r = await call(cfg, 'GET', `/requests/${encodeURIComponent(requestId)}/status`);
  const images: string[] = Array.isArray(r?.images) ? r.images.map((i: any) => i?.url).filter((u: unknown): u is string => typeof u === 'string') : [];
  return {
    status: typeof r?.status === 'string' ? r.status : 'unknown',
    images,
    video: typeof r?.video?.url === 'string' ? r.video.url : null,
    error: r?.error === undefined || r?.error === null ? null : typeof r.error === 'string' ? r.error : JSON.stringify(r.error).slice(0, 300),
  };
}

// ---- uploads ----------------------------------------------------------------------------------
export const UPLOAD_TYPES: Record<string, { kind: 'image' | 'video' | 'audio'; maxBytes: number }> = {
  'image/jpeg': { kind: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/jpg': { kind: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/png': { kind: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/webp': { kind: 'image', maxBytes: 20 * 1024 * 1024 },
  'image/gif': { kind: 'image', maxBytes: 20 * 1024 * 1024 },
  'video/mp4': { kind: 'video', maxBytes: 100 * 1024 * 1024 },
  'audio/wav': { kind: 'audio', maxBytes: 30 * 1024 * 1024 },
  'audio/x-wav': { kind: 'audio', maxBytes: 30 * 1024 * 1024 },
};

/**
 * Hosts a local file on Higgsfield storage so it can be used as a generation input:
 *   POST /files/generate-upload-url {content_type} -> {public_url, upload_url, upload_headers}
 *   PUT  upload_url (only upload_headers, never our credentials)
 * Files are tagged retention=temporary by the platform, so don't treat them as permanent storage.
 */
export async function uploadFile(cfg: HfConfig, data: Buffer, contentType: string): Promise<string> {
  const r = await call(cfg, 'POST', '/files/generate-upload-url', { content_type: contentType });
  const uploadUrl: unknown = r?.upload_url;
  const publicUrl: unknown = r?.public_url;
  if (typeof uploadUrl !== 'string' || typeof publicUrl !== 'string' || !/^https:\/\//i.test(uploadUrl) || !/^https?:\/\//i.test(publicUrl)) {
    throw new HiggsfieldError(502, 'Higgsfield returned an unexpected upload response');
  }
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (r.upload_headers && typeof r.upload_headers === 'object') for (const [k, v] of Object.entries(r.upload_headers)) if (typeof v === 'string') headers[k] = v;
  let put: Response;
  try {
    put = await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(data), signal: AbortSignal.timeout(180_000) });
  } catch {
    throw new HiggsfieldError(502, 'Could not reach Higgsfield storage to upload the file. Try again.');
  }
  if (!put.ok) throw new HiggsfieldError(502, `Upload to Higgsfield storage failed (${put.status})`);
  return publicUrl;
}

// ---- characters (Soul ID) ---------------------------------------------------------------------
export interface Character {
  id: string;
  name: string;
  status: string;
  thumbnailUrl: string | null;
}

const asCharacter = (x: any): Character | null => {
  const id = x?.id ?? x?.reference_id;
  if (typeof id !== 'string') return null;
  const thumb = x.thumbnail_url ?? x.preview_url ?? x.image_url ?? x.images?.[0]?.url ?? x.input_images?.[0]?.image_url ?? null;
  return { id, name: typeof x.name === 'string' && x.name ? x.name : 'Untitled character', status: typeof x.status === 'string' ? x.status : 'unknown', thumbnailUrl: typeof thumb === 'string' ? thumb : null };
};

export async function listCharacters(cfg: HfConfig): Promise<Character[]> {
  const r = await call(cfg, 'GET', '/v1/custom-references/list?page=1&page_size=50');
  const rows: unknown[] = Array.isArray(r) ? r : (r?.items ?? r?.data ?? r?.results ?? r?.references ?? r?.custom_references ?? []);
  return rows.map(asCharacter).filter((c): c is Character => c !== null);
}

export async function getCharacter(cfg: HfConfig, id: string): Promise<Character> {
  const c = asCharacter(await call(cfg, 'GET', `/v1/custom-references/${encodeURIComponent(id)}`));
  if (!c) throw new HiggsfieldError(502, 'Unexpected character response from Higgsfield');
  return c;
}

/** Starts Soul ID training for Soul 2 (billed by Higgsfield per request - see their pricing). */
export async function createCharacter(cfg: HfConfig, name: string, imageUrls: string[]): Promise<Character> {
  const r = await call(cfg, 'POST', '/v1/custom-references', {
    name,
    model_version: 'v2',
    input_images: imageUrls.map((u) => ({ type: 'image_url', image_url: u })),
  });
  const c = asCharacter(r);
  if (!c) throw new HiggsfieldError(502, 'Higgsfield did not return a character id');
  return c;
}

// ---- simulated mode ---------------------------------------------------------------------------
interface SimRequest {
  surface: 'image' | 'video';
  title: string;
  polls: number;
}
const sims = new Map<string, SimRequest>();
const SAMPLE_VIDEO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

export function simSubmit(surface: 'image' | 'video', title: string): { requestId: string; status: string } {
  const requestId = `sim-${crypto.randomUUID()}`;
  sims.set(requestId, { surface, title, polls: 0 });
  if (sims.size > 500) sims.delete(sims.keys().next().value as string);
  return { requestId, status: 'queued' };
}

export function simStatus(requestId: string): HfStatus {
  const s = sims.get(requestId);
  if (!s) return { status: 'failed', images: [], video: null, error: 'Unknown simulated request' };
  s.polls++;
  if (s.polls < 3) return { status: s.polls === 1 ? 'queued' : 'in_progress', images: [], video: null, error: null };
  return s.surface === 'image'
    ? { status: 'completed', images: [placeholderImage(s.title, 'photo', requestId)], video: null, error: null }
    : { status: 'completed', images: [], video: SAMPLE_VIDEO, error: null };
}
