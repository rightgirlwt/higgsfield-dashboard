import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth as useClerkAuth } from '@clerk/clerk-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, configureApi, errorMessage } from '../lib/api';
import type { Me } from '../lib/types';
import { ErrorState, Spinner } from '../components/ui';
import { AuthContext } from './context';

/**
 * Clerk integration (loaded only when the server reports AUTH_PROVIDER=clerk).
 * Needs VITE_CLERK_PUBLISHABLE_KEY at build time. The Clerk session JWT is sent as the bearer token;
 * roles live in our own database (first sign-in bootstraps an org + admin, or links an invited email).
 *
 * NOTE: this path has not been exercised against a live Clerk instance in this repo's tests.
 */
export default function ClerkAuth({ children }: { children: ReactNode }) {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  if (!key) {
    return (
      <div className="mx-auto mt-24 max-w-md p-4">
        <ErrorState message="The server uses Clerk, but VITE_CLERK_PUBLISHABLE_KEY is not set for this frontend build." />
      </div>
    );
  }
  return (
    <ClerkProvider publishableKey={key} appearance={{ variables: { colorPrimary: '#99577A', colorBackground: '#ffffff', colorText: '#21191F' } }}>
      <SignedOut>
        <main className="grid min-h-screen place-items-center p-4">
          <SignIn routing="hash" />
        </main>
      </SignedOut>
      <SignedIn>
        <Bridge>{children}</Bridge>
      </SignedIn>
    </ClerkProvider>
  );
}

function Bridge({ children }: { children: ReactNode }) {
  const { getToken, signOut } = useClerkAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    configureApi({ getToken: () => getToken(), onUnauthorized: () => undefined });
    api.get<Me>('/me').then(setMe).catch((e) => setError(errorMessage(e)));
  }, [getToken]);

  const value = useMemo(() => (me ? { me, signOut: () => signOut(), getToken: () => getToken() } : null), [me, signOut, getToken]);
  if (error) return <div className="mx-auto mt-24 max-w-md p-4"><ErrorState message={error} /></div>;
  if (!value) return <div className="grid min-h-screen place-items-center"><Spinner label="Signing in" /></div>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
