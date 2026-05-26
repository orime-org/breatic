/**
 * Per-request locale middleware.
 *
 * Reads the browser's Accept-Language header, negotiates against the
 * locales the server actually has translations for, and pins the
 * winning locale into an AsyncLocalStorage store via
 * `@breatic/shared/i18n-node`'s `runWithLocale`. Every `t("server.…")`
 * inside the request handler (or any service it calls) then resolves
 * messages in the caller's language. Falls back to English when no
 * supported locale appears in the header.
 *
 * Why AsyncLocalStorage rather than a global `setLocale()`:
 *   The shared i18n engine is a module-level singleton; mutating
 *   `_currentLocale` per request would race between concurrent
 *   handlers (request A sets `zh-CN`, request B fires `setLocale("en")`
 *   one microtask later — A's pending await chain now reads `en`).
 *   ALS gives each request its own store keyed by the async resource
 *   tree, so locales never cross.
 *
 * Mounted before `errorHandler` in `app.ts` so error responses also
 * pick up the negotiated locale.
 */

import type { MiddlewareHandler } from "hono";
import { runWithLocale } from "@breatic/shared/i18n-node";

/** Locales for which the server has translation files in `locales/`. */
const SUPPORTED: ReadonlyArray<string> = ["en", "zh-CN", "zh-TW", "ja"];
const DEFAULT_LOCALE = "en";

/**
 * Pick the best supported locale from an Accept-Language header.
 * Exact match wins; if none, fall back to a prefix match
 * (`zh-HK` → `zh-CN`); if still none, return the default.
 *
 * Quality factors (`;q=0.8`) are dropped — the order in the header
 * already reflects priority for every browser worth supporting, and
 * a strict q-sort would add weight for negligible accuracy.
 */
function negotiateLocale(header: string | undefined): string {
  if (!header) return DEFAULT_LOCALE;
  const requested = header
    .split(",")
    .map((s) => s.split(";")[0]?.trim())
    .filter((s): s is string => Boolean(s));
  for (const r of requested) {
    if (SUPPORTED.includes(r)) return r;
    const prefix = r.split("-")[0];
    if (!prefix) continue;
    const prefixMatch = SUPPORTED.find((s) => s.startsWith(prefix + "-") || s === prefix);
    if (prefixMatch) return prefixMatch;
  }
  return DEFAULT_LOCALE;
}

/** Hono middleware factory — install once per app via `app.use("*", localeMiddleware)`. */
export const localeMiddleware: MiddlewareHandler = (c, next) => {
  const locale = negotiateLocale(c.req.header("Accept-Language"));
  return runWithLocale(locale, next);
};
