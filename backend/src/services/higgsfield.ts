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

async function call(cfg: HfConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Key ${cfg.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const detail = typeof payload?.detail === 'string' ? payload.detail : typeof payload === 'string' ? payload.slice(0, 200) : '';
    throw new HiggsfieldError(res.status, `Higgsfield API responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return payload;
}

export async function submit(cfg: HfConfig, modelPath: string, body: Record<string, unknown>): Promise<{ requestId: string; status: string }> {
  if (!MODEL_PATH.test(modelPath) || modelPath.includes('..')) throw new HiggsfieldError(400, 'Invalid model path');
  const r = await call(cfg, 'POST', `/${modelPath}`, body);
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
