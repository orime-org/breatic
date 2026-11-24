// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Node-only i18n adapter for the back-end services (server / worker /
 * collab). Lives in `@breatic/core` — the node-side shared library all
 * three node services depend on — so any of them can load locales and
 * scope a per-request locale without re-implementing it. Crucially,
 * the web bundle never imports `@breatic/core`, so these `node:fs` /
 * `node:async_hooks` imports can never leak into the browser bundle
 * (the reason this used to live on a `@breatic/shared/i18n-node`
 * subpath, see packages/shared/AGENTS.md#browser-safe-dependencies-only; moving it
 * into core lets `@breatic/shared` stay 100% browser-safe and drop its
 * tsc-only build).
 *
 * The i18n ENGINE itself (`t()`, message catalog, ICU formatting, the
 * `setLocale*` hooks) stays in `@breatic/shared` and is shared by
 * both web and node — this module is only the node-side *adapter*
 * (how locales get loaded from disk + how the active locale is
 * resolved per request). One engine, two platform adapters.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  setLocaleMessages,
  setLocaleResolver,
  type Locale,
} from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

const _als = new AsyncLocalStorage<Locale>();

// Install the resolver at module load. Idempotent: re-importing the
// module just rebinds the same getter — harmless.
setLocaleResolver(() => _als.getStore());

/**
 * Run `fn` with the given locale pinned in the AsyncLocalStorage
 * store. The context propagates through `await` chains, so every
 * `t()` call inside `fn` (and any nested async service code) sees
 * the same locale. Returns whatever `fn` returns.
 *
 * Server middleware should wrap each request handler with this so
 * downstream errors thrown with `t("server.…")` carry the caller's
 * preferred language.
 * @param locale - the locale to pin for the duration of `fn`
 * @param fn - the function to run inside the locale-scoped store
 * @returns whatever `fn` returns
 */
export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return _als.run(locale, fn);
}

/**
 * Merge one catalog into another: nested objects merge key by key, and any
 * other value from `over` replaces the one in `base`.
 * @param base - The catalog loaded so far.
 * @param over - The catalog laid on top of it.
 * @returns A new catalog holding both.
 */
function mergeCatalogs(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const below = merged[key];
    merged[key] =
      isCatalog(below) && isCatalog(value) ? mergeCatalogs(below, value) : value;
  }
  return merged;
}

/**
 * Whether a value is a nested catalog rather than a message.
 * @param value - The value.
 * @returns True for a plain object.
 */
function isCatalog(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load all locale JSON files and register them with the shared i18n engine.
 * Defaults to the repo-root `locales/` directory, anchored on
 * `MONOREPO_ROOT` (which walks up to the pnpm-workspace.yaml, with a Docker
 * cwd fallback) rather than a relative `../../` hop — the bundled output's
 * directory depth differs between packages and dev-vs-Docker, so a
 * hard-coded relative path is fragile.
 *
 * Several directories are laid on top of one another in order, so a service
 * that adds its own catalogs (the billing service) keeps the product's keys
 * and adds or overrides only its own.
 *
 * Node service entry points should call this once at boot, before any
 * `t()` call runs.
 * @param localesDirs - the directory, or directories in order, to scan for locale JSON files; defaults to the repo-root `locales/`
 */
export function loadLocales(localesDirs?: string | readonly string[]): void {
  const dirs = localesDirs === undefined ? [resolve(MONOREPO_ROOT, "locales")] : typeof localesDirs === "string" ? [localesDirs] : localesDirs;
  const catalogs = new Map<string, Record<string, unknown>>();
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const locale = basename(file, ".json");
        const data = JSON.parse(readFileSync(resolve(dir, file), "utf-8")) as Record<string, unknown>;
        catalogs.set(locale, mergeCatalogs(catalogs.get(locale) ?? {}, data));
      }
      // The template style words (inner#1817) sit in their own catalogs so the
      // web entry stays small; here they join the same locales.
      const styles = resolve(dir, "template-styles");
      if (!existsSync(styles)) continue;
      for (const file of readdirSync(styles)) {
        if (!file.endsWith(".json")) continue;
        const locale = basename(file, ".json");
        const base = catalogs.get(locale);
        if (base === undefined) continue;
        const data = JSON.parse(readFileSync(resolve(styles, file), "utf-8")) as Record<string, unknown>;
        catalogs.set(locale, mergeCatalogs(base, data));
      }
    } catch {
      // locales dir may not exist in test environments
    }
  }
  for (const [locale, messages] of catalogs) setLocaleMessages(locale, messages);
}
