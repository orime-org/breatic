/**
 * i18n — front-end & back-end shared internationalization.
 *
 * Loads translations from `locales/*.json` at the project root.
 * Supports parameter interpolation with `{param}` syntax.
 * Falls back to English for missing keys.
 *
 * Frontend: imports JSON at build time via Vite @locales alias.
 * Backend: loads JSON at runtime via fs.readFileSync.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

/** Supported locale codes. */
export type Locale = string;

const _locales = new Map<string, Record<string, unknown>>();
let _currentLocale: Locale = "en";
let _loaded = false;

/**
 * Load all locale JSON files from the locales/ directory.
 *
 * Called lazily on first `t()` call. Can also be called explicitly
 * at startup with a custom path.
 *
 * @param localesDir - Path to the locales directory
 */
export function loadLocales(localesDir?: string): void {
  const dir = localesDir ?? resolve(import.meta.dirname, "../../../../locales");
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const locale = basename(file, ".json");
      const raw = readFileSync(resolve(dir, file), "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      _locales.set(locale, data);
    }
  } catch {
    // locales dir may not exist in test environments
  }
  _loaded = true;
}

/** Set the active locale. */
export function setLocale(locale: Locale): void {
  _currentLocale = locale;
}

/** Get the current locale. */
export function getLocale(): Locale {
  return _currentLocale;
}

/** Get all available locale codes. */
export function getAvailableLocales(): Locale[] {
  if (!_loaded) loadLocales();
  return [..._locales.keys()];
}

/**
 * Translate a key with optional parameter interpolation.
 *
 * Supports dot-notation keys: `t("server.auth.invalid_credentials")`
 * Supports parameters: `t("server.error.insufficient_credits", { required: 10, available: 5 })`
 * Falls back to English if the key is missing in the current locale.
 *
 * @param key - Dot-notation translation key
 * @param params - Optional parameter map for `{param}` interpolation
 * @returns Translated string, or the key itself if not found
 */
export function t(key: string, params?: Record<string, string | number>): string {
  if (!_loaded) loadLocales();

  const current = _locales.get(_currentLocale);
  const fallback = _locales.get("en");

  let text = (current ? resolveKey(current, key) : undefined)
    ?? (fallback ? resolveKey(fallback, key) : undefined)
    ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }

  return text;
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
  _loaded = false;
  _currentLocale = "en";
}
