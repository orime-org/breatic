/**
 * i18n — front-end & back-end shared internationalization (browser-safe).
 *
 * Engine: `intl-messageformat` (industry-standard ICU MessageFormat).
 * Supports plural / select / selectordinal / number / date / nested /
 * rich-text — all on day one (per inner DD rev 3
 * `2026-05-22-breatic-i18n-migration-rev-3-no-phasing.md`).
 *
 * **Loading messages**:
 *   - Web: `import { setLocaleMessages } from "@breatic/shared/i18n"`
 *     then call `setLocaleMessages("en", enJson)` for each bundled locale
 *     (typically via the web bootstrap entry).
 *   - Node services: `import { loadLocales } from "@breatic/core"` and
 *     call `loadLocales()` once at boot. The node-only loader lives in
 *     `@breatic/core` (the node-side shared lib, which the web bundle
 *     never imports) so this module stays free of `node:fs` imports
 *     and never drags Node builtins into the web bundle
 *     (see memory `feedback_shared_barrel_browser_pull`).
 *
 * **External API stays compatible** with the previous helper:
 *   - `t(key, params)` accepts the same call shape, so existing
 *     callers (e.g. server middleware/role.ts `t("server.error.forbidden")`)
 *     keep working unchanged.
 *   - Plural / select syntax in locale values is the only new capability
 *     for callers, e.g. `"items": "{count, plural, one {1 item} other {# items}}"`.
 */

import { IntlMessageFormat } from "intl-messageformat";

/** Supported locale codes. */
export type Locale = string;

const _locales = new Map<string, Record<string, unknown>>();
const _formatterCache = new Map<string, IntlMessageFormat>();
let _currentLocale: Locale = "en";

/**
 * Active-locale resolver hook. When set, `t()` calls
 * `_localeResolver()` first; only falls back to the process-global
 * `_currentLocale` when the resolver returns `undefined`.
 *
 * Wired by `@breatic/core`'s locale-loader at module load time so server
 * code paths read the per-request locale from an AsyncLocalStorage
 * store. The web bundle never installs a resolver, so `_currentLocale`
 * (driven by `setLocale()` from the locale-bootstrap) stays
 * authoritative there.
 */
let _localeResolver: (() => Locale | undefined) | null = null;

/**
 * Install a per-call locale resolver. Called once by the node-side
 * loader during boot — never by application code.
 */
export function setLocaleResolver(
  resolver: (() => Locale | undefined) | null,
): void {
  _localeResolver = resolver;
}

/** Resolve the effective locale for a single `t()` call. */
function activeLocale(): Locale {
  return _localeResolver?.() ?? _currentLocale;
}

/**
 * Set messages for a locale. Called by the web bootstrap with JSON
 * imported via the Vite `@locales` alias, and by the Node-only
 * `loadLocales()` loader on the server.
 */
export function setLocaleMessages(
  locale: Locale,
  messages: Record<string, unknown>,
): void {
  _locales.set(locale, messages);
  for (const key of _formatterCache.keys()) {
    if (key.startsWith(`${locale}|`)) _formatterCache.delete(key);
  }
}

/** Set the active locale. */
export function setLocale(locale: Locale): void {
  _currentLocale = locale;
  _notifyLocaleListeners();
}

/** Get the current locale. */
export function getLocale(): Locale {
  return _currentLocale;
}

/** Get all available locale codes that have been registered. */
export function getAvailableLocales(): Locale[] {
  return [..._locales.keys()];
}

/**
 * Translate a key with optional parameter interpolation. Supports
 * full ICU MessageFormat syntax: `{count, plural, one {…} other {…}}`,
 * `{gender, select, male {…} female {…} other {…}}`, nested, etc.
 *
 * Supports dot-notation keys: `t("server.auth.invalid_credentials")`
 * Falls back to English if the key is missing in the current locale,
 * then to the key itself.
 *
 * @param key - Dot-notation translation key
 * @param params - Optional parameter map for ICU placeholders
 * @returns Formatted string, or the key itself if not found
 */
export function t(
  key: string,
  params?: Record<string, string | number | Date>,
): string {
  const message = resolveMessage(key);
  if (message === undefined) return key;
  if (params === undefined || Object.keys(params).length === 0) {
    return message;
  }

  const locale = activeLocale();
  const cacheKey = `${locale}|${key}`;
  let formatter = _formatterCache.get(cacheKey);
  if (!formatter) {
    try {
      formatter = new IntlMessageFormat(message, locale);
      _formatterCache.set(cacheKey, formatter);
    } catch {
      // Malformed ICU — return the raw message so a typo in a locale
      // file doesn't break the UI; the message will be visible enough
      // for developers to notice and fix.
      return message;
    }
  }

  const formatted = formatter.format(params);
  return typeof formatted === "string" ? formatted : String(formatted);
}

/** Resolve a key against current locale → en fallback → undefined. */
function resolveMessage(key: string): string | undefined {
  const locale = activeLocale();
  const current = _locales.get(locale);
  const fallback = _locales.get("en");
  return (current ? resolveKey(current, key) : undefined)
    ?? (fallback ? resolveKey(fallback, key) : undefined);
}

/** Resolve a dot-notation key from a nested object. */
function resolveKey(obj: Record<string, unknown>, key: string): string | undefined {
  let current: unknown = obj;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/** Reset loaded locales (for testing). */
export function resetLocales(): void {
  _locales.clear();
  _formatterCache.clear();
  _currentLocale = "en";
  _localeResolver = null;
  _localeListeners.clear();
}

// ── Locale-change subscription (used by web useTranslation hook) ──

type LocaleListener = (locale: Locale) => void;
const _localeListeners = new Set<LocaleListener>();

/**
 * Subscribe to locale changes. Returns an unsubscribe function.
 * Used by the web `useTranslation()` hook to re-render components
 * when the active locale changes.
 */
export function onLocaleChange(listener: LocaleListener): () => void {
  _localeListeners.add(listener);
  return () => {
    _localeListeners.delete(listener);
  };
}

function _notifyLocaleListeners(): void {
  for (const listener of _localeListeners) {
    listener(_currentLocale);
  }
}
