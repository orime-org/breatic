/**
 * Node-only loader for locale JSON files. Kept on its own subpath
 * (`@breatic/shared/i18n-node`) so the web bundle never has to follow
 * `node:fs` / `node:path` imports — see `feedback_shared_barrel_browser_pull`.
 *
 * Also installs the AsyncLocalStorage-backed locale resolver so
 * server request handlers can scope `t()` to a per-request locale via
 * `runWithLocale()`. Importing this module from a server entry point
 * is the install signal — `_localeResolver` becomes non-null and
 * future `t()` calls prefer the ALS store over the process-global
 * `_currentLocale` (which on the server stays `"en"` and acts as the
 * fallback when no request context is on the stack — log lines /
 * boot-time messages).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { setLocaleMessages, setLocaleResolver, type Locale } from "./index.js";

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
 */
export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return _als.run(locale, fn);
}

/**
 * Load all locale JSON files from `localesDir` and register them with
 * the shared i18n engine. Defaults to the repo-root `locales/` directory
 * resolved relative to this file's location in `node_modules`.
 *
 * Server entry points should call this once at boot, before any `t()`
 * call runs.
 */
export function loadLocales(localesDir?: string): void {
  const dir = localesDir ?? resolve(import.meta.dirname, "../../../../locales");
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
