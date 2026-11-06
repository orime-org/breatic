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
 * @returns Per locale, each of those keys' message by its dotted name.
 * @throws {Error} When a catalog lacks one of the keys.
 */
export function everyLocaleMessages(
  localesDir: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json'))) {
    const catalog: unknown = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    out[file.slice(0, -'.json'.length)] = Object.fromEntries(EVERY_LOCALE_KEYS.map((key) => {
      const message: unknown = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], catalog);
      if (typeof message !== 'string') throw new Error(`${file} has no string at ${key}`);
      return [key, message];
    }));
  }
  return out;
}
