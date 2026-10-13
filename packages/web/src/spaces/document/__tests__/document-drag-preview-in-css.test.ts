// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A20 for the lift a drag shows the reader.
 *
 * A11 asks for the row's content to lift off the page and follow the pointer
 * (user 2026-09-17, replacing the library's near-invisible clone). It is
 * delivered by `index.css` alone, hanging off `doc-drag-preview`, the class
 * `buildDragPreview` puts on every preview (inner#1350). A rename on either
 * side takes the promise away with nothing to show for it, and a synthetic
 * mouse cannot drive a real drag image, so this is the assertion A20 asks for.
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
    expect(stylesheet()).toMatch(/\.doc-drag-preview > \* \{\s*opacity: 0\.6;/);
  });

  it('keeps the preview opaque and fixed in the viewport for the image to be taken', () => {
    // Firefox and WebKit draw the root's own opacity into the image, and Safari
    // cancels a drag whose image is wholly off screen (inner#1350 design §4).
    const rule = /\.doc-drag-preview \{([^}]*)\}/.exec(stylesheet())?.[1] ?? '';
    expect(rule).toMatch(/position: fixed;/);
    expect(rule).toMatch(/top: 0;/);
    expect(rule).toMatch(/left: 0;/);
    expect(rule).toMatch(/z-index: 2147483647;/);
    expect(rule).toMatch(/pointer-events: none;/);
    expect(rule).not.toMatch(/opacity/);
  });

  it('lays out and draws nothing of the copies its content sits in, and takes no pointer anywhere', () => {
    // The copies of what the content sits in in the body
    // (`document-preview-styles.ts`): rules match through them and values are
    // inherited through them, and they are no box. A preview over the pointer
    // as the drag starts would end it in Chromium.
    const sheet = stylesheet();
    expect(sheet).toMatch(/\.doc-preview-shell \{\s*display: contents !important;\s*\}/);
    expect(sheet).toMatch(/\.doc-preview-shell::before,\s*\.doc-preview-shell::after \{\s*content: none !important;\s*\}/);
    expect(sheet).toMatch(/\.doc-drag-preview \* \{\s*pointer-events: none !important;\s*\}/);
  });
});
