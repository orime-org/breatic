// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The five shipped locale catalogs, plus the one way to read a key out of
 * them.
 *
 * Four suites had each imported the JSON by hand-counted relative path; two of
 * them carried byte-identical `readPath` helpers and a third inlined the same
 * walk into a loop. `vitest.setup.ts` wrote its own list too, named four of the
 * five, and never registered `ko` — anything rendered under `setLocale('ko')`
 * fell back to English and passed for the wrong reason, with nothing going red.
 * A hand-written list is a list that gets missed, and the miss is silent.
 *
 * This is the list for tests. Production keeps its own, in
 * `web/src/i18n/locale-bootstrap.ts` (imports, `SUPPORTED_LOCALES`, the
 * registration calls, and a prefix-matching `if` chain) and in the server's
 * `middleware/i18n.ts`. Adding a sixth locale still means editing those by
 * hand; collapsing them onto one source is tracked separately.
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
