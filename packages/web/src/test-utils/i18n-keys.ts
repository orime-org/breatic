// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * For functions that hand a caller an i18n key as data instead of calling
 * `t()` themselves — `relativeTime` in the conversation list and in the
 * activity feed both do this.
 *
 * Nothing static can see those keys: the repo-lint guard reads `t("literal")`
 * call shapes, and a key named as a return value never appears in one. That is
 * how `chat.relative.isoDate` shipped with no catalog answering it.
 */

import { expect } from 'vitest';
import { setLocale, t } from '@breatic/shared';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/** One branch's output: the key it names, and the params it names with it. */
export interface NamedKey {
  key: string;
  params?: Record<string, string | number | Date>;
}

/**
 * Assert every branch resolves to real text in every locale we ship.
 *
 * Two questions per locale, because neither one alone is enough:
 *
 * Does the catalog carry the key? Asked of the catalog directly, never through
 * `t()` — `resolveMessage` falls back to the English catalog when the active
 * locale has no answer (packages/shared/src/i18n/index.ts), so a key missing
 * from `ko` alone renders English and would sail past a render-only check.
 *
 * Does it render? Asked through `t()`, because existence is not the failure
 * that hurts most: `t()` guards `new IntlMessageFormat(...)` but calls
 * `format(params)` unguarded, so a catalog whose placeholder was renamed
 * (`{date}` to `{iso}`) throws out of the component's render rather than
 * degrading to an ugly string.
 *
 * Registration is not this function's business — `vitest.setup.ts` registers
 * every catalog in `LOCALE_CATALOGS` before any suite runs. Registering here
 * would leave the worker in a state the setup file never produced, visible
 * only to whichever files happen to run afterwards.
 * @param branches - Every key the function under test can name, with the
 *   params it names alongside each one.
 */
export function expectEveryLocaleRenders(
  branches: readonly NamedKey[],
): void {
  const problems: string[] = [];
  try {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      setLocale(tag);
      for (const branch of branches) {
        if (typeof readPath(catalog, branch.key) !== 'string') {
          problems.push(`${tag}: ${branch.key} — not in this catalog`);
          // Rendering it now would only prove English answers it.
          continue;
        }
        let rendered: string;
        try {
          rendered = t(branch.key, branch.params);
        } catch (err) {
          problems.push(
            `${tag}: ${branch.key} — threw: ${(err as Error).message}`,
          );
          continue;
        }
        // `t()` echoes the key back when nothing resolves, so this is what a
        // locale that was never registered looks like — without it the render
        // half reports zero problems in exactly the state it exists to catch.
        if (rendered === branch.key) {
          problems.push(`${tag}: ${branch.key} — resolved to the key itself`);
        } else if (rendered.trim() === '') {
          problems.push(`${tag}: ${branch.key} — empty`);
        }
      }
    }
  } finally {
    // Back to the locale `vitest.setup.ts` selects, so the rest of this file
    // and the next file in this worker are unaffected.
    setLocale('en');
  }
  expect(problems).toEqual([]);
}
