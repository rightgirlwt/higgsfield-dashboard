import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { api, ApiError, configureApi, errorMessage } from '../lib/api';
import type { Me, Role } from '../lib/types';
import { Badge, Button, Card, ErrorState, Spinner } from '../components/ui';
import { AuthContext } from './context';

const ClerkAuth = lazy(() => import('./ClerkAuth'));
const TOKEN_KEY = 'hf_dev_token';

interface Health {
  auth: 'dev' | 'clerk';
}
interface DevUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  token: string;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Decides at runtime (from the server's /health) whether to use built-in dev login or Clerk. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Health['auth'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(() => {
    setError(null);
    api
      .get<Health>('/health')
      .then((h) => setMode(h.auth))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(probe, [probe]);

  if (error) return <div className="mx-auto mt-24 max-w-md p-4"><ErrorState message={error} onRetry={probe} /></div>;
  if (!mode) return <div className="grid min-h-screen place-items-center"><Spinner label="Connecting" /></div>;
  if (mode === 'clerk') {
    return (
      <Suspense fallback={<div className="grid min-h-screen place-items-center"><Spinner /></div>}>
        <ClerkAuth>{children}</ClerkAuth>
      </Suspense>
    );
  }
  return <DevAuth>{children}</DevAuth>;
}

function DevAuth({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(readToken);
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!token);
  const [retry, setRetry] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    setToken(null);
    setMe(null);
  }, []);

  useEffect(() => {
    configureApi({ getToken: async () => token, onUnauthorized: signOut });
    if (!token) {
      setChecking(false);
      return;
    }
    setChecking(true);
    setServerError(null);
    api
      .get<Me>('/me')
      .then(setMe)
      .catch((e) => {
        // Only a rejected session signs you out. A server hiccup (restart, 5xx, network) keeps your session and offers a retry.
        if (e instanceof ApiError && e.status === 401) signOut();
        else setServerError(errorMessage(e));
      })
      .finally(() => setChecking(false));
  }, [token, signOut, retry]);

  const value = useMemo(() => (me ? { me, signOut, getToken: async () => token } : null), [me, signOut, token]);

  if (checking) return <div className="grid min-h-screen place-items-center"><Spinner label="Signing in" /></div>;
  if (serverError && token && !me) {
    return (
      <div className="mx-auto mt-24 max-w-md p-4">
        <ErrorState message={`The server isn’t responding (${serverError}). Your session is kept; try again in a moment.`} onRetry={() => setRetry((n) => n + 1)} />
      </div>
    );
  }
  if (!value) {
    return (
      <DevLogin
        onPick={(t) => {
          try {
            localStorage.setItem(TOKEN_KEY, t);
          } catch {
            /* storage unavailable: session lasts until reload */
          }
          setToken(t);
        }}
      />
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const roleTone = { admin: 'violet', user: 'cyan', viewer: 'slate' } as const;
const roleBlurb: Record<Role, string> = {
  admin: 'Full access: settings, API keys, team and billing',
  user: 'Create and run prompts and workflows',
  viewer: 'Read-only access',
};

function DevLogin({ onPick }: { onPick: (token: string) => void }) {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api.get<DevUser[]>('/dev/users').then(setUsers).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-violet-500 text-lg font-bold text-white">H</div>
          <div>
            <h1 className="text-xl font-semibold">Higgsfield Studio</h1>
            <p className="text-sm text-slate-400">Development sign-in</p>
          </div>
        </div>
        <p className="mb-4 flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Dev mode: pick a seeded demo account. Production deployments use Clerk (<code>AUTH_PROVIDER=clerk</code>) and never expose this screen.
          </span>
        </p>
        {error && <ErrorState message={error} onRetry={load} />}
        {!users && !error && <Spinner />}
        <ul className="space-y-2">
          {users?.map((u) => (
            <li key={u.id}>
              <Button variant="secondary" className="h-auto w-full justify-between px-4 py-3 text-left" onClick={() => onPick(u.token)}>
                <span>
                  <span className="block text-sm font-medium">{u.name}</span>
                  <span className="block text-xs font-normal text-slate-400">{roleBlurb[u.role]}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={roleTone[u.role]}>{u.role}</Badge>
                  <LogIn className="h-4 w-4" aria-hidden />
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
