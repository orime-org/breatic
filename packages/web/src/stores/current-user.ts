import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Current user store — auth identity + role + bearer token + loading flag.
 *
 * Token is loaded synchronously at module init via `loadInitialAuth()` so
 * deep-link routes (e.g. `/project/<id>`) have auth on first render. Setting
 * the token here does NOT persist to localStorage; that is the auth layer's
 * job (avoids two writers).
 */
export type UserRole = 'owner' | 'edit' | 'view' | null;

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

interface CurrentUserState {
  user: CurrentUser | null;
  role: UserRole;
  token: string | null;
  loading: boolean;
  setUser: (user: CurrentUser | null) => void;
  setRole: (role: UserRole) => void;
  setToken: (token: string | null) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useCurrentUserStore = create<CurrentUserState>()(
  immer((set) => ({
    user: null,
    role: null,
    token: null,
    loading: false,
    setUser: (user) =>
      set((s) => {
        s.user = user;
      }),
    setRole: (role) =>
      set((s) => {
        s.role = role;
      }),
    setToken: (token) =>
      set((s) => {
        s.token = token;
      }),
    setLoading: (loading) =>
      set((s) => {
        s.loading = loading;
      }),
    clear: () =>
      set((s) => {
        s.user = null;
        s.role = null;
        s.token = null;
        s.loading = false;
      }),
  })),
);
