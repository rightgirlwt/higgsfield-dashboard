/**
 * Thin typed fetch wrapper. Adds the bearer token, normalises errors into ApiError,
 * and calls `onUnauthorized` once when the session is rejected so the app can sign out.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;
let onUnauthorized: () => void = () => undefined;

export function configureApi(opts: { getToken: TokenProvider; onUnauthorized: () => void }): void {
  tokenProvider = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const WORKSPACE_KEY = 'workspace';
/** The workspace this browser is working in. The server falls back to the first one when this is empty or unknown. */
export function getWorkspaceId(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setWorkspaceId(id: string): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    /* storage unavailable: the first workspace is used */
  }
}

async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const token = await tokenProvider();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const workspace = getWorkspaceId();
  if (workspace) headers['X-Workspace'] = workspace;
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server. Check that the backend is running.', 'network');
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let code = 'error';
    let details: unknown;
    try {
      const j = await res.json();
      msg = j?.error?.message ?? msg;
      code = j?.error?.code ?? code;
      details = j?.error?.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg, code, details);
  }
  return res;
}

async function json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await request(method, path, body, signal);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => json<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => json<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => json<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => json<T>('PATCH', path, body ?? {}),
  del: <T = void>(path: string) => json<T>('DELETE', path),

  /** Upload a raw file body (the server hosts it on Higgsfield and returns a public URL). */
  async upload<T>(path: string, file: File, contentType?: string): Promise<T> {
    const token = await tokenProvider();
    let res: Response;
    try {
      res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers: { 'Content-Type': contentType || file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(getWorkspaceId() ? { 'X-Workspace': getWorkspaceId() } : {}) }, body: file });
    } catch {
      throw new ApiError(0, 'Cannot reach the server. Check that the backend is running.', 'network');
    }
    if (res.status === 401) onUnauthorized();
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, j?.error?.message ?? `Upload failed (${res.status})`, j?.error?.code ?? 'error');
    return j as T;
  },

  /** Authenticated download (a plain <a href> can't send the bearer token). */
  async download(path: string, filename: string): Promise<void> {
    const res = await request('GET', path);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
