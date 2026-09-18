// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A20 for the two things a drag shows the reader.
 *
 * A11 asks for a row that lifts off the page and follows the pointer, and for
 * no frame left around where it came from (user 2026-09-17, replacing the
 * library's near-invisible clone). Both are delivered by `index.css` alone,
 * hanging off class names the library writes — `bn-drag-preview` on the clone
 * it appends to the body, and ProseMirror's own `ProseMirror-selectednode` on
 * the row `dragStart` selects. A rename on either side, ours or theirs, takes
 * both promises away with nothing to show for it, and a synthetic mouse cannot
 * drive a real drag image, so this is the assertion A20 asks for.
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
    expect(stylesheet()).toContain('.bn-drag-preview > * {\n  opacity: 0.6;');
  });

  it('withholds the outline from the row the drag selected', () => {
    expect(stylesheet()).toContain(
      'body:has(> .bn-drag-preview) .doc-body .ProseMirror-selectednode {\n  outline: none;',
    );
  });
});
