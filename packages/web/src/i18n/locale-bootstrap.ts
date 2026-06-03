// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Web i18n bootstrap — runs once at app startup, before React renders.
 *
 * Resolution chain (per the i18n-migration DD, rev 3):
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
} from '@breatic/shared';

// Vite resolves these via the `@locales` alias to repo-root locales/*.json.
// All five locales bundle into the initial JS chunk (~few KB each).
import en from '@locales/en.json';
import zhCN from '@locales/zh-CN.json';
import zhTW from '@locales/zh-TW.json';
import ja from '@locales/ja.json';
import ko from '@locales/ko.json';

const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];
const FALLBACK_LOCALE: Locale = 'en';
const STORAGE_KEY = 'breatic.locale';

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
  setLocaleMessages('ko', ko as Record<string, unknown>);

  // 2. Resolve the initial active locale.
  const initial = resolveInitialLocale();
  setLocale(initial);
}

/**
 * Change the active locale + persist the choice. Exposed for the
 * `<LangSwitcher>` component.
 * @param locale - The locale to activate; ignored if not in `SUPPORTED_LOCALES`.
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

/**
 * Get the list of locales the app supports.
 * @returns The supported locales in priority order.
 */
export function getSupportedLocales(): ReadonlyArray<Locale> {
  return SUPPORTED_LOCALES;
}

/**
 * Resolve the initial active locale from persisted choice, then browser
 * preferences, then the hardcoded fallback.
 * @returns The first supported locale matched by the resolution chain.
 */
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
