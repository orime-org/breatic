// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Dev-proxy targets for vite: where `/api`, `/uploads` and `/ws` go.
 *
 * Separate from `dev-ports.mts` because of who imports what. The default ports
 * come from `@breatic/shared`, so the core env schema and this config read ONE
 * declaration instead of two copies that drift (#1831) — but `@breatic/shared`
 * is ESM-only, and playwright loads its config through CJS `require()`. Keeping
 * the shared import out of `dev-ports.mts` is what lets playwright (which only
 * needs the dev-server port) load without tripping ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * Only vite imports this file, and vite loads configs as ESM.
 */
import { DEFAULT_API_PORT, DEFAULT_COLLAB_PORT } from '@breatic/shared';
import { loadRootEnv, parsePort } from './dev-ports.mjs';

/**
 * Resolve the backend targets the dev server proxies to.
 *
 * Derived from the backend's own `PORT` / `COLLAB_PORT` rather than separate
 * `VITE_*_TARGET` settings: one value per service means the frontend cannot
 * drift out of sync with the backend it is supposed to reach.
 * @param mode - Vite mode passed through to `loadEnv`.
 * @param dirname - Directory of the calling config file.
 * @returns Absolute API and collab WebSocket targets.
 */
export function resolveProxyTargets(
  mode: string,
  dirname: string,
): { apiTarget: string; wsTarget: string } {
  const env = loadRootEnv(mode, dirname);
  return {
    apiTarget: `http://localhost:${parsePort(env.PORT, DEFAULT_API_PORT)}`,
    wsTarget: `ws://localhost:${parsePort(env.COLLAB_PORT, DEFAULT_COLLAB_PORT)}`,
  };
}
