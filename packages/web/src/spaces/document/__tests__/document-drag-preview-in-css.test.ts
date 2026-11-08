// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #113 A20 for the lift a drag shows the user.
 *
 * A11 asks for the row's content to lift off the page and follow the pointer
 * (user 2026-09-17, replacing the library's near-invisible clone). It is
 * delivered by `index.css` alone, hanging off the class `mountDragImage`
 * puts on every editor's drag image (`lib/drag-image.ts`). A rename on either
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

import { DRAG_IMAGE_CLASS } from '@web/lib/drag-image';

/** The stylesheet, read per case so a rule rename cannot pass unseen. */
function stylesheet(): string {
  return readFileSync(
    resolve(import.meta.dirname, '../../../index.css'),
    'utf8',
  );
}

describe('what a drag shows', () => {
  it('draws the image at full strength: no rule on a drag image sets an opacity (inner#1515)', () => {
    const rules = [...stylesheet().matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, selector]) =>
      selector!.includes(`.${DRAG_IMAGE_CLASS}`),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter(([, , body]) => /opacity/.test(body!))).toEqual([]);
  });

  it('keeps the preview opaque and fixed in the viewport for the image to be taken', () => {
    // Firefox and WebKit draw the root's own opacity into the image, and Safari
    // cancels a drag whose image is wholly off screen (inner#1350 design §4).
    const rule = new RegExp(`\\.${DRAG_IMAGE_CLASS} \\{([^}]*)\\}`).exec(stylesheet())?.[1] ?? '';
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
    expect(sheet).toContain(`.${DRAG_IMAGE_CLASS} * {\n    pointer-events: none !important;\n  }`);
  });
});
