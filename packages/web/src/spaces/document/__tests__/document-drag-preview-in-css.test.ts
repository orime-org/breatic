// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A20 for the lift a drag shows the reader.
 *
 * A11 asks for the row's content to lift off the page and follow the pointer
 * (user 2026-09-17, replacing the library's near-invisible clone). It is
 * delivered by `index.css` alone, hanging off `bn-drag-preview`, the class the
 * library puts on the clone it appends to the body. A rename on either side,
 * ours or theirs, takes the promise away with nothing to show for it, and a
 * synthetic mouse cannot drive a real drag image, so this is the assertion A20
 * asks for.
 *
 * The other half of what A11 asks — nothing drawn around where the row came
 * from — is `document-no-block-frame-in-css.test.ts`, since this Space draws
 * no frame around a node-selected block at all.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/** The stylesheet, read per case so a rule rename cannot pass unseen. */
function stylesheet(): string {
  return readFileSync(
    resolve(import.meta.dirname, '../../../index.css'),
    'utf8',
  );
}

describe('what a drag shows', () => {
  it('lifts the clone by making its contents translucent', () => {
    // The child, not the clone itself: Chrome ignores `opacity` on the element
    // handed to `setDragImage`.
    expect(stylesheet()).toMatch(/\.bn-drag-preview > \* \{\s*opacity: 0\.6;/);
  });

  it('draws a table in the preview the way the body draws it', () => {
    // The table's lines, collapse and cell widths hang off `.bn-editor` and
    // `.ProseMirror` in BlockNote and prosemirror-tables, classes the preview
    // cannot carry (inner#1350 §4), so they are given to it here.
    const css = stylesheet();
    expect(css).toMatch(/\.bn-drag-preview \[data-content-type='table'\] table \{[^}]*border-collapse: collapse;[^}]*table-layout: fixed;/);
    expect(css).toMatch(/\.bn-drag-preview \[data-content-type='table'\] td \{[^}]*border-width: 1px;[^}]*border-style: solid;/);
    expect(css).toMatch(/\.bn-drag-preview \[data-content-type='table'\] td:not\(\[colwidth\]\)[^{]*\{[^}]*min-width: var\(--default-cell-min-width\);/);
  });
});
