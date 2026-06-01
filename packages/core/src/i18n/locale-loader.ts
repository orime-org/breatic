/**
 * Node-only i18n adapter for the back-end services (server / worker /
 * collab). Lives in `@breatic/core` — the node-side shared library all
 * three node services depend on — so any of them can load locales and
 * scope a per-request locale without re-implementing it. Crucially,
 * the web bundle never imports `@breatic/core`, so these `node:fs` /
 * `node:async_hooks` imports can never leak into the browser bundle
 * (the reason this used to live on a `@breatic/shared/i18n-node`
 * subpath — see memory `feedback_shared_barrel_browser_pull`; moving it
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
import { readFileSync, readdirSync } from "node:fs";
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
 * Load all locale JSON files from `localesDir` and register them with
 * the shared i18n engine. Defaults to the repo-root `locales/` directory,
 * anchored on `MONOREPO_ROOT` (which walks up to the pnpm-workspace.yaml,
 * with a Docker cwd fallback) rather than a relative `../../` hop —
 * the bundled output's directory depth differs between packages and
 * dev-vs-Docker, so a hard-coded relative path is fragile.
 *
 * Node service entry points should call this once at boot, before any
 * `t()` call runs.
 * @param localesDir - directory to scan for locale JSON files; defaults to the repo-root `locales/`
 */
export function loadLocales(localesDir?: string): void {
  const dir = localesDir ?? resolve(MONOREPO_ROOT, "locales");
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const locale = basename(file, ".json");
      const raw = readFileSync(resolve(dir, file), "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      setLocaleMessages(locale, data);
    }
  } catch {
    // locales dir may not exist in test environments
  }
}
