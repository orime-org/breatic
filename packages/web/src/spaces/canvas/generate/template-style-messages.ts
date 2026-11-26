// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The template style words (inner#1817) live in their own catalogs,
 * `locales/template-styles/<locale>.json`, so the entry download stays within
 * its budget; they are fetched the first time a template menu opens or a
 * styled template applies, and merged into the locale already registered.
 * Only the template menu and `use-apply-template` import this module, which
 * keeps the catalogs out of the entry closure.
 */
import { captureException } from '@sentry/react';

import { mergeLocaleMessages, type Locale } from '@breatic/shared';

/** Downloads one locale's style catalog. */
type StyleCatalogLoader = () => Promise<{ default: unknown }>;

/** One chunk per locale, named `template-styles-<locale>` by the Vite config. */
const LOADERS: Partial<Record<Locale, StyleCatalogLoader>> = {
  en: () => import('@locales/template-styles/en.json'),
  'zh-CN': () => import('@locales/template-styles/zh-CN.json'),
  'zh-TW': () => import('@locales/template-styles/zh-TW.json'),
  ja: () => import('@locales/template-styles/ja.json'),
  ko: () => import('@locales/template-styles/ko.json'),
};

/**
 * Builds the loader over a table of catalogs.
 * @param loaders - Each locale's catalog download.
 * @returns A function that makes sure a locale's style words are merged in, answering whether they are.
 */
export function templateStyleMessagesLoader(
  loaders: Partial<Record<Locale, StyleCatalogLoader>>,
): (locale: Locale) => Promise<boolean> {
  // A failed download stays failed for the life of the page, as the browser
  // keeps it in its module map; the menu then asks the user to refresh.
  const loaded = new Map<Locale, Promise<boolean>>();
  return (locale) => {
    const known = loaded.get(locale);
    if (known !== undefined) return known;
    const load = loaders[locale];
    const pending =
      load === undefined
        ? Promise.resolve(false)
        : load().then(
          (catalog) => {
            mergeLocaleMessages(locale, catalog.default as Record<string, unknown>);
            return true;
          },
          (error: unknown) => {
            captureException(error, { tags: { error_boundary: 'template-styles-chunk', locale } });
            return false;
          },
        );
    loaded.set(locale, pending);
    return pending;
  };
}

/** Makes sure a locale's template style words are merged in, answering whether they are. */
export const ensureTemplateStyleMessages = templateStyleMessagesLoader(LOADERS);
