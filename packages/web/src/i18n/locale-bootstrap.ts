/**
 * Web i18n bootstrap — runs once at app startup, before React renders.
 *
 * Resolution chain (per inner DD rev 3
 * `2026-05-22-breatic-i18n-migration-rev-3-no-phasing.md`):
 *
 *   1. `localStorage["breatic.locale"]` — explicit user choice persists
 *      across machines + reloads
 *   2. `navigator.languages` / `navigator.language` — browser preference,
 *      first match against supported locales wins
 *   3. Hardcoded fallback `"en"` (English is the OSS default per maintainer
 *      decision 2026-05-22)
 *
 * No URL `?lang=` override — explicitly retired per the same decision
 * to keep the resolution chain simple and avoid bookmark-locale drift.
 *
 * Locale JSON is imported via the Vite `@locales` alias at build time
 * (vite.config.mts line 73 maps to repo-root `locales/`), so all four
 * locale files are bundled into the initial JS chunk. Switching locales
 * at runtime is therefore zero-RTT — no network fetch needed.
 */

import {
  setLocale,
  setLocaleMessages,
  type Locale,
} from '@breatic/shared/i18n';

// Vite resolves these via the `@locales` alias to repo-root locales/*.json.
// All four locales bundle into the initial JS chunk (~few KB each).
import en from '@locales/en.json';
import zhCN from '@locales/zh-CN.json';
import zhTW from '@locales/zh-TW.json';
import ja from '@locales/ja.json';

const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja'];
const FALLBACK_LOCALE: Locale = 'en';
const STORAGE_KEY = 'breatic.locale';

/**
 * Old localStorage keys that previous app versions used to persist
 * language preference. We delete them at bootstrap so the browser
 * devtools view stays clean and no stale reader can latch onto a
 * stranded value. Safe to remove this list a few releases later once
 * every active install has been visited at least once.
 */
const LEGACY_LANGUAGE_STORAGE_KEYS = ['Breatic-language', 'language'] as const;

/**
 * Initialize the i18n runtime. Must be called once at app startup,
 * before any component renders `useTranslation()`.
 */
export function bootstrapLocale(): void {
  // 1. Seed all locale message catalogs into the shared `t()` engine.
  setLocaleMessages('en', en as Record<string, unknown>);
  setLocaleMessages('zh-CN', zhCN as Record<string, unknown>);
  setLocaleMessages('zh-TW', zhTW as Record<string, unknown>);
  setLocaleMessages('ja', ja as Record<string, unknown>);

  // 2. Prune stale localStorage keys from older app versions so devtools
  //    doesn't show 3 conflicting "language" entries side by side.
  pruneLegacyLanguageKeys();

  // 3. Resolve the initial active locale.
  const initial = resolveInitialLocale();
  setLocale(initial);
}

function pruneLegacyLanguageKeys(): void {
  try {
    for (const key of LEGACY_LANGUAGE_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable; safe to ignore.
  }
}

/**
 * Change the active locale + persist the choice. Exposed for the
 * `<LangSwitcher>` component.
 */
export function changeLocale(locale: Locale): void {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage may be unavailable (private mode, quota); fall through.
  }
  setLocale(locale);
}

/** Get the list of locales the app supports. */
export function getSupportedLocales(): ReadonlyArray<Locale> {
  return SUPPORTED_LOCALES;
}

function resolveInitialLocale(): Locale {
  // 1. Persisted choice wins.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored)) {
      return stored as Locale;
    }
  } catch {
    // localStorage may be unavailable; fall through to browser pref.
  }

  // 2. Browser preferences — first supported match wins.
  const prefs = navigator.languages ?? [navigator.language];
  for (const pref of prefs) {
    // Exact match: `zh-CN`, `ja`.
    if (SUPPORTED_LOCALES.includes(pref)) return pref as Locale;
    // Prefix match: `en-US` → `en`, `zh-HK` → `zh-TW`.
    const prefix = pref.split('-')[0];
    if (prefix === 'en') return 'en';
    if (prefix === 'ja') return 'ja';
    if (prefix === 'zh') {
      // Differentiate simplified vs traditional by region; default to
      // zh-CN since it's the source language.
      const region = pref.split('-')[1]?.toUpperCase();
      if (region === 'TW' || region === 'HK' || region === 'MO') return 'zh-TW';
      return 'zh-CN';
    }
  }

  // 3. Hardcoded fallback.
  return FALLBACK_LOCALE;
}
