// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A4, A13 and A15: what each of the two menus holds.
 */

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
