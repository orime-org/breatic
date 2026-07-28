// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Dev-server port resolution, shared by `vite.config.mts` and
 * `playwright.config.ts`.
 *
 * Both files need to answer the same question — "which port is the dev server
 * on?" — and each used to answer it with its own hard-coded 8000 (`port: 8000`
 * in the vite config, `baseURL: 'http://localhost:8000'` in the playwright
 * one). Two literals with no link between them: making the port configurable
 * meant either teaching both files to read the env var the same way, or
 * leaving a smoke run aimed at a port the dev server never bound — a failure
 * that reads as "the app is broken".
 *
 * One parser, one fallback, both callers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This module imports NOTHING from `@breatic/shared`, and that is load-bearing:
 * playwright compiles config files to CJS and `require()`s them, while
 * `@breatic/shared` is ESM-only (its `exports` map has no `require` condition).
 * Importing it from here makes `playwright test` die at config load with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The backend ports live in `proxy-targets.mts`,
 * which only vite (ESM) loads.
 */
import path from 'path';
import { loadEnv } from 'vite';

/**
 * Vite dev-server port when `VITE_DEV_PORT` is unset.
 *
 * Declared here rather than in `@breatic/shared`: this is the one port with a
 * single consumer. No backend process can even see `VITE_DEV_PORT`.
 */
export const DEFAULT_DEV_PORT = 8000;

/**
 * Read a port from the loaded env, falling back when unset, blank or unparsable.
 * @param raw - The raw env value, if present.
 * @param fallback - Port to use when `raw` yields no usable number.
 * @returns A positive integer port.
 */
export function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Load the monorepo-root `.env`.
 *
 * Third arg `''` loads unprefixed vars too, which is what lets the frontend
 * derive its proxy targets from the backend's own `PORT` / `COLLAB_PORT`
 * instead of duplicating them under `VITE_*` names that could drift.
 * @param mode - Vite mode passed through to `loadEnv`.
 * @param dirname - Directory of the calling config file.
 * @returns The raw env map.
 */
export function loadRootEnv(
  mode: string,
  dirname: string,
): Record<string, string> {
  return loadEnv(mode, path.resolve(dirname, '../..'), '');
}

/**
 * Resolve the vite dev-server port.
 * @param mode - Vite mode passed through to `loadEnv`.
 * @param dirname - Directory of the calling config file.
 * @returns The port the dev server will bind.
 */
export function resolveDevPort(mode: string, dirname: string): number {
  return parsePort(loadRootEnv(mode, dirname).VITE_DEV_PORT, DEFAULT_DEV_PORT);
}
