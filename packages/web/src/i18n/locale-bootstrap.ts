// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * English ships in the entry: `t()` falls back to it for any key the active
 * catalog lacks. Every other catalog is its own `import()` chunk, downloaded
 * at startup when it is the initial locale and otherwise on the first switch
 * to it (#1374). The few keys `tInEveryLocale` reads back in every language
 * travel separately, as the `__EVERY_LOCALE_MESSAGES__` define.
 */

import { captureException } from '@sentry/react';
import {
  getAvailableLocales,
  setEveryLocaleMessages,
  setLocale,
  setLocaleMessages,
  type Locale,
} from '@breatic/shared';

// Vite resolves this via the `@locales` alias to repo-root locales/en.json.
import en from '@locales/en.json';

import { STORAGE_KEYS } from '@web/lib/storage-keys';

/** Every locale's wording of `EVERY_LOCALE_KEYS`, set by the Vite and vitest configs. */
declare const __EVERY_LOCALE_MESSAGES__: Record<string, Record<string, string>>;

const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];
const FALLBACK_LOCALE: Locale = 'en';
const STORAGE_KEY = STORAGE_KEYS.locale;

/** The catalogs downloaded on demand, one chunk each. */
const CATALOG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'zh-CN': () => import('@locales/zh-CN.json'),
  'zh-TW': () => import('@locales/zh-TW.json'),
  ja: () => import('@locales/ja.json'),
  ko: () => import('@locales/ko.json'),
};

/** How a {@link changeLocale} call ended. */
export type LocaleSwitch = 'switched' | 'superseded' | 'failed';

/** The locale the most recent {@link changeLocale} call asked for. */
let latestRequest: Locale | undefined;

/**
 * Initialize the i18n runtime. Must be awaited once at app startup, before
 * any component renders `useTranslation()`; it settles in English when the
 * initial locale's catalog cannot be downloaded.
 * @returns Resolves once the initial locale is active.
 */
export async function bootstrapLocale(): Promise<void> {
  setLocaleMessages('en', en as Record<string, unknown>);
  for (const [locale, messages] of Object.entries(__EVERY_LOCALE_MESSAGES__)) {
    setEveryLocaleMessages(locale, messages);
  }
  const initial = resolveInitialLocale();
  if (await ensureCatalog(initial)) {
    setLocale(initial);
  } else {
    // The stored choice stays, so the next page load tries again.
    setLocale(FALLBACK_LOCALE);
  }
}

/**
 * Change the active locale + persist the choice, downloading its catalog
 * first when it has none yet. Exposed for the `<LangSwitcher>` component.
 *
 * The latest call wins: a download that lands after a later call asked for
 * another locale switches nothing and reports `'superseded'`.
 * @param locale - The locale to activate; ignored if not in `SUPPORTED_LOCALES`.
 * @returns `'switched'` once it is active, `'superseded'` when a later call
 * took over, `'failed'` when it is unsupported or its catalog did not download.
 */
export async function changeLocale(locale: Locale): Promise<LocaleSwitch> {
  if (!SUPPORTED_LOCALES.includes(locale)) return 'failed';
  latestRequest = locale;
  if (!getAvailableLocales().includes(locale)) {
    const loaded = await ensureCatalog(locale);
    if (latestRequest !== locale) return 'superseded';
    if (!loaded) return 'failed';
  }
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage may be unavailable (private mode, quota); fall through.
  }
  setLocale(locale);
  return 'switched';
}

/**
 * Get the list of locales the app supports.
 * @returns The supported locales in priority order.
 */
export function getSupportedLocales(): ReadonlyArray<Locale> {
  return SUPPORTED_LOCALES;
}

/**
 * Make sure a locale's catalog is registered, downloading it when needed.
 *
 * A failed download stays failed for the life of the page (the browser keeps
 * it in its module map), which is why the language menu tells the user to
 * refresh.
 * @param locale - A supported locale.
 * @returns Whether its catalog is registered now.
 */
async function ensureCatalog(locale: Locale): Promise<boolean> {
  const load = CATALOG_LOADERS[locale];
  if (load === undefined || getAvailableLocales().includes(locale)) return true;
  try {
    const catalog = await load();
    setLocaleMessages(locale, catalog.default as Record<string, unknown>);
    return true;
  } catch (error) {
    captureException(error, { tags: { error_boundary: 'locale-chunk', locale } });
    return false;
  }
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
