import { createContext, useContext } from 'react';
import type { Me, Role } from '../lib/types';

export interface AuthValue {
  me: Me;
  signOut: () => void | Promise<void>;
  getToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside an auth provider');
  return v;
}

const RANK: Record<Role, number> = { viewer: 1, user: 2, admin: 3 };

/** UI-level permission check; the server enforces the same rules independently. */
export function useCan(min: Role): boolean {
  return RANK[useAuth().me.role] >= RANK[min];
}
