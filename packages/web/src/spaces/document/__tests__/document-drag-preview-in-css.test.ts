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
    expect(stylesheet()).toContain('.bn-drag-preview > * {\n  opacity: 0.6;');
  });
});
