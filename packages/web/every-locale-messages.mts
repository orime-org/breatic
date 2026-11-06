// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The every-locale wordings the web build carries beside the one catalog a
 * reader downloads (#1374).
 *
 * The app ships English and the reader's own catalog only, but
 * `tInEveryLocale` reads a few keys back in every language: a prompt may have
 * been filled in by a collaborator in another one. Those keys of every locale
 * reach the page as the `__EVERY_LOCALE_MESSAGES__` define, set by both
 * `vite.config.mts` and `vitest.config.mts`. It is computed when the config
 * loads, so a dev server shows a locale edit after a restart, as every other
 * catalog does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EVERY_LOCALE_KEYS } from '@breatic/shared';

/**
 * Pick {@link EVERY_LOCALE_KEYS} out of every catalog in `locales/`.
 * @param localesDir - Absolute path of the repository's `locales/` directory.
 * @returns Per locale, a nested object holding only those keys.
 * @throws {Error} When a catalog lacks one of the keys.
 */
export function everyLocaleMessages(
  localesDir: string,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json'))) {
    const locale = file.slice(0, -'.json'.length);
    const catalog = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8')) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of EVERY_LOCALE_KEYS) {
      const parts = key.split('.');
      let from: unknown = catalog;
      for (const part of parts) from = (from as Record<string, unknown> | undefined)?.[part];
      if (typeof from !== 'string') throw new Error(`${file} has no string at ${key}`);
      let to = picked;
      for (const part of parts.slice(0, -1)) {
        to[part] ??= {};
        to = to[part] as Record<string, unknown>;
      }
      to[parts[parts.length - 1]] = from;
    }
    out[locale] = picked;
  }
  return out;
}
