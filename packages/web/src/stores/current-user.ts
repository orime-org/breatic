import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Current user store — auth identity + role + boot/loading flags.
 *
 * Session token used to live here as `token` + `setToken`, exposed
 * to JS so axios / SSE / WS could attach it as a Bearer / URL param.
 * Removed 2026-05-26 (cookie migration) — the token is now an
 * httpOnly cookie set by the server and never reachable from JS.
 * Authentication state from the frontend's perspective is now
 * binary: `user` is non-null after a successful `/auth/me` ping
 * (cookie was valid), or null otherwise.
 *
 * `bootstrapped` distinguishes "we haven't pinged `/auth/me` yet"
 * from "we pinged and the user is unauthenticated". ProtectedRoute
 * shows a loading shell while `!bootstrapped` and only redirects
 * to `/login` once the boot ping has completed — otherwise a fresh
 * page load would briefly flash the login page before the cookie
 * check returned.
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
  loading: boolean;
  bootstrapped: boolean;
  setUser: (user: CurrentUser | null) => void;
  setRole: (role: UserRole) => void;
  setLoading: (loading: boolean) => void;
  setBootstrapped: (bootstrapped: boolean) => void;
  clear: () => void;
}

export const useCurrentUserStore = create<CurrentUserState>()(
  immer((set) => ({
    user: null,
    role: null,
    loading: false,
    bootstrapped: false,
    setUser: (user) =>
      set((s) => {
        s.user = user;
      }),
    setRole: (role) =>
      set((s) => {
        s.role = role;
      }),
    setLoading: (loading) =>
      set((s) => {
        s.loading = loading;
      }),
    setBootstrapped: (bootstrapped) =>
      set((s) => {
        s.bootstrapped = bootstrapped;
      }),
    clear: () =>
      set((s) => {
        s.user = null;
        s.role = null;
        s.loading = false;
        // bootstrapped intentionally preserved — see store docstring.
      }),
  })),
);
