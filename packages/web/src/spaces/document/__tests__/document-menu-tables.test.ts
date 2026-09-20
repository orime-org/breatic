// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A4, A13 and A15: what each of the two menus holds.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { BLOCK_TYPE_ITEMS } from '@web/spaces/document/document-block-type';
import { BLOCK_MENU_ROWS } from '@web/spaces/document/document-block-menu-rows';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';

describe('the block handle menu', () => {
  it('holds seven rows in the order the demo has them', () => {
    expect(BLOCK_MENU_ROWS.map((row) => row.id)).toEqual([
      'blockType',
      'duplicate',
      'insertBelow',
      'align',
      'color',
      'comment',
      'delete',
    ]);
  });

  // Dragging a block to a new place is the handle's other gesture, not a row
  // in its menu: it is the other gesture on the same handle.
  it('offers no row for dragging', () => {
    expect(BLOCK_MENU_ROWS.map((row) => row.labelKey).join(' ')).not.toContain(
      'drag',
    );
  });
});

describe('the colour panel both menus open', () => {
  // One panel, two carriers. Asserted on the source because what would go
  // wrong is a second copy drawn from the same seven hue names: it would render
  // the same test ids and pass every behavioural case while drifting in
  // spacing, marks and cells from the day it was written.
  it('is the same module in the bubble bar and in the block handle menu', () => {
    const here = resolve(__dirname, '..');
    const carriers = ['document-bubble-slots.tsx', 'DocumentBlockMenu.tsx'];
    carriers.forEach((file) => {
      const source = readFileSync(resolve(here, file), 'utf8');
      expect(source, `${file} draws the panel itself`).toContain(
        'from \'@web/spaces/document/document-colour-panel\'',
      );
    });
  });

  // Likewise the three alignment rows: the bubble bar's slot and the block
  // handle's submenu read one table.
  it('reads one alignment table from both', () => {
    const here = resolve(__dirname, '..');
    expect(
      readFileSync(resolve(here, 'document-bubble-slots.tsx'), 'utf8'),
    ).toContain('from \'@web/spaces/document/document-align-items\'');
    expect(
      readFileSync(resolve(here, 'DocumentBlockMenu.tsx'), 'utf8'),
    ).toContain('from \'@web/spaces/document/document-align-items\'');
  });

  // And the column that marks the row in force. Four menus draw one — the
  // bubble bar's block type and alignment slots, the block handle menu's two
  // submenus — and written out per menu it drifts: before this was one
  // component the four spellings had already parted on the margin. Asserted
  // on the source because a hand-drawn copy renders the same glyph under the
  // same test ids and passes every behavioural case.
  it('draws one tick column in all four menus', () => {
    const here = resolve(__dirname, '..');
    const carriers = ['document-bubble-slots.tsx', 'DocumentBlockMenu.tsx'];
    carriers.forEach((file) => {
      const source = readFileSync(resolve(here, file), 'utf8');
      expect(source, `${file} draws the column itself`).toContain(
        'from \'@web/spaces/document/document-menu-tick\'',
      );
      expect(source, `${file} spells the column out by hand`).not.toContain(
        'size-4 shrink-0 items-center justify-center',
      );
    });
  });
});

describe('the insert menu', () => {
  // Read off the block type table rather than copied out here: what this pins
  // is that the two menus agree, and a copy would go on agreeing with itself
  // after one of them moved.
  it('offers the block type rows in the block type menu’s order', () => {
    expect(INSERT_MENU_ROWS).toEqual(
      BLOCK_TYPE_ITEMS.map((item) => item.id).filter(
        (id) => id !== 'paragraph',
      ),
    );
  });

  // A row the product has not built is absent rather than greyed: the menu
  // only offers what can happen, and every entry is named and drawn by the
  // one table the block type menu reads, so the two never drift.
  it('offers nothing outside the block type table', () => {
    const known = new Map(BLOCK_TYPE_ITEMS.map((item) => [item.id, item]));
    INSERT_MENU_ROWS.forEach((id) => {
      expect(known.get(id)?.labelKey).toMatch(/^spaces\.document\./);
    });
  });

  // The row the menu opens in already is a paragraph.
  it('does not offer to make the row a paragraph', () => {
    expect(INSERT_MENU_ROWS).not.toContain('paragraph');
  });
});
