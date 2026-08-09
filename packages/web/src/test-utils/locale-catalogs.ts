// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The five shipped locale catalogs, plus the one way to read a key out of
 * them.
 *
 * Five files had each written the list out by hand — four suites importing the
 * JSON by hand-counted relative path, three of them also carrying a `readPath`
 * (two byte-identical, the third inlined into a loop), plus `vitest.setup.ts`,
 * which named four of the five and never registered `ko`. That last one is why
 * this is a single list rather than a convention: a hand-written list is a list
 * that gets missed, and the miss is silent — anything rendered under
 * `setLocale('ko')` fell back to English and passed for the wrong reason.
 * Adding a sixth locale should mean editing this array and nothing else.
 */

import type { Locale } from '@breatic/shared';

import en from '@locales/en.json';
import zhCN from '@locales/zh-CN.json';
import zhTW from '@locales/zh-TW.json';
import ja from '@locales/ja.json';
import ko from '@locales/ko.json';

/**
 * Every locale we ship, paired with its parsed catalog.
 *
 * Ordered with `en` first because it is the source language: a diff against
 * English is the usual reason to walk this list.
 *
 * `satisfies` rather than a type annotation, because `Locale` is declared as
 * plain `string`: annotating the constant would widen each tag back to
 * `string` and make the `as const` inert, which costs real checks — a
 * `filter(([tag]) => tag !== 'em')` typo would then compile clean instead of
 * failing with TS2367.
 */
export const LOCALE_CATALOGS = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['ko', ko],
] as const satisfies ReadonlyArray<readonly [Locale, unknown]>;

/** The tags above, as a union — a mistyped locale is a compile error. */
export type LocaleTag = (typeof LOCALE_CATALOGS)[number][0];

/**
 * The catalog for one locale, for suites that assert about a single language.
 * @param locale - A locale tag from {@link LocaleTag}.
 * @returns That locale's parsed catalog.
 * @throws {Error} never, for a caller that typechecks — `LocaleTag` is derived
 *   from the list, so the lookup always hits. The branch exists because `find`
 *   is typed as possibly missing, and a named error beats a non-null assertion
 *   if the parameter type is ever bypassed.
 */
export function catalogFor(locale: LocaleTag): unknown {
  const found = LOCALE_CATALOGS.find(([tag]) => tag === locale);
  if (!found) throw new Error(`no such locale: ${locale}`);
  return found[1];
}

/**
 * Resolve a dotted key path against a parsed locale catalog.
 * @param catalog - Parsed locale JSON.
 * @param path - Dotted key path (e.g. `studio.container.badge.roleOwner`).
 * @returns The value at the path, or undefined if any segment is missing.
 */
export function readPath(catalog: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      catalog,
    );
}
