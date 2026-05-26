import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Current user store — auth identity + role + loading flag.
 *
 * Session token used to live here as `token` + `setToken`, exposed
 * to JS so axios / SSE / WS could attach it as a Bearer / URL param.
 * Removed 2026-05-26 (cookie migration) — the token is now an
 * httpOnly cookie set by the server and never reachable from JS.
 * Authentication state from the frontend's perspective is now
 * binary: `user` is non-null after a successful `/auth/me` ping
 * (cookie was valid), or null otherwise.
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
  setUser: (user: CurrentUser | null) => void;
  setRole: (role: UserRole) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useCurrentUserStore = create<CurrentUserState>()(
  immer((set) => ({
    user: null,
    role: null,
    loading: false,
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
    clear: () =>
      set((s) => {
        s.user = null;
        s.role = null;
        s.loading = false;
      }),
  })),
);
