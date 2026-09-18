// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A20 for the landing line a text drag draws.
 *
 * The colour comes from `index.css` alone: the extension is configured with
 * none of its own (`build-document-editor.ts`), and `DropCursor.ts:121` writes
 * an inline colour only when it was given one. Which class it puts on the
 * element depends on where the drop would land —
 * `applyOrientationClasses` (`DropCursor/utils.ts:141-170`) marks a text drop
 * `-inline`, a drop beside a column `-vertical`, and a drop between blocks
 * `-block` — and the library's own stylesheet gives the first two transitions
 * and no colour. So a selector naming one of the three leaves the other two
 * invisible, which is what shipped until 2026-09-18 and what nothing caught:
 * a browser cannot be driven into a real text drag (round 3), so this is the
 * assertion A20 asks for.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/** Every orientation the extension can mark the element with. */
const ORIENTATIONS = [
  'prosemirror-dropcursor-block',
  'prosemirror-dropcursor-inline',
  'prosemirror-dropcursor-vertical',
];

/** The token the line is painted with, shared with the block being carried. */
const TOKEN = 'var(--color-status-selected)';

/** The stylesheet, read per case so a rule rename cannot pass unseen. */
function stylesheet(): string {
  return readFileSync(
    resolve(import.meta.dirname, '../../../index.css'),
    'utf8',
  );
}

/**
 * The declaration block that follows a selector list holding the given class.
 * @param css - The stylesheet.
 * @param className - The class to find a rule for.
 * @returns What that rule declares, or undefined when nothing names it.
 */
function ruleFor(css: string, className: string): string | undefined {
  const at = css.indexOf(`.${className}`);
  if (at === -1) return undefined;
  const opens = css.indexOf('{', at);
  const closes = css.indexOf('}', opens);
  if (opens === -1 || closes === -1) return undefined;
  return css.slice(opens + 1, closes);
}

describe('the drop cursor’s paint', () => {
  it('names every orientation the extension can apply', () => {
    const css = stylesheet();

    for (const orientation of ORIENTATIONS) {
      expect(css, orientation).toContain(`.${orientation}`);
    }
  });

  it('paints each of them with the token', () => {
    const css = stylesheet();

    for (const orientation of ORIENTATIONS) {
      expect(ruleFor(css, orientation), orientation).toContain(
        `background-color: ${TOKEN}`,
      );
    }
  });
});
