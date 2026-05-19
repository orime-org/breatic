import { DEV_USER_ID } from '@breatic/shared';

import { useCurrentUserStore } from '@/stores';

/**
 * Dev-only fixed identity for local development.
 *
 * When `LOGIN_MODE=NoAccount` is set on the backend (server +
 * collab), authentication is bypassed and any request is treated as
 * `DEV_USER_ID`. This file mirrors that on the frontend by seeding
 * `useCurrentUserStore` with the same id + a placeholder token so
 * UI code that reads the current user (e.g. axios Bearer header,
 * MembersStack avatar, etc.) sees a valid identity instead of null.
 *
 * **Dev only** — the bootstrap is guarded by `import.meta.env.DEV` so
 * production bundles never auto-inject. Real login flow ships in a
 * later PR (covering `/login`, OAuth, session refresh, logout).
 */
export const DEV_TOKEN = 'dev-fixed-token';

const DEV_USER = {
  id: DEV_USER_ID,
  email: 'dev@localhost',
  name: 'Dev User',
};

/** Seed the current-user store with the dev identity. Idempotent. */
export function injectDevUser(): void {
  const state = useCurrentUserStore.getState();
  if (state.user?.id === DEV_USER_ID && state.token === DEV_TOKEN) return;
  state.setUser(DEV_USER);
  state.setRole('owner');
  state.setToken(DEV_TOKEN);
}
