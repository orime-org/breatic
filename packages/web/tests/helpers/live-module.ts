// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The url a module is already loaded under, for a case that wants to call it.
 *
 * Vite serves each module under a versioned url, and importing the bare path
 * from inside the page evaluates a SECOND copy whose caches are empty: the
 * Yjs document that copy opens is not the one on screen, so a node written
 * through it never appears. What the page already loaded is the only copy
 * worth talking to, and `performance.getEntriesByType('resource')` is where
 * its url is written down.
 *
 * Resolving it here rather than inside each case's own `page.evaluate` is
 * what makes the failure one behaviour: this throws and names the module,
 * where the three copies this replaced threw two different messages and
 * returned an empty string.
 */
import type { Page } from 'playwright/test';

/** The canvas Space module, which is what every caller so far wants. */
export const CANVAS_SPACE = 'data/yjs/canvas-space.ts';

/** The manager behind it, for a caller that needs the document itself. */
export const YJS_MANAGER = 'data/yjs/manager.ts';

/**
 * A text node's body helpers, for a caller that seeds one with words.
 *
 * `@breatic/shared` ships them at their own entry, so the path names that
 * file rather than the package's main bundle, which does not carry them.
 */
export const TEXT_BODY = 'shared/dist/canvas/text-body.js';

/**
 * Finds the url one of the page's loaded modules is served under.
 * @param page - A page with the app running on it.
 * @param path - Part of the module's source path, as `CANVAS_SPACE` gives it.
 * @returns The versioned url, ready for `import()` inside the page.
 * @throws {Error} When the page has not loaded that module.
 */
export async function liveModuleUrl(page: Page, path: string): Promise<string> {
  const found = await page.evaluate(
    (want) =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => n.includes(want)) ?? null,
    path,
  );
  if (found === null) {
    throw new Error(
      `The page has not loaded ${path}, so there is no live copy to call. Open the Space this case works in before asking for it.`,
    );
  }
  return found;
}
