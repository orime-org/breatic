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
  it('holds five rows in the order the demo has them', () => {
    expect(BLOCK_MENU_ROWS.map((row) => row.id)).toEqual([
      'blockType',
      'duplicate',
      'insertBelow',
      'comment',
      'delete',
    ]);
  });

  // Dragging a block to a new place is the handle's other gesture, not a row
  // in its menu; the handle's tooltip is where the reader learns about it.
  it('offers no row for dragging', () => {
    expect(BLOCK_MENU_ROWS.map((row) => row.labelKey).join(' ')).not.toContain(
      'drag',
    );
  });

  it('opens a submenu for the two rows that lead to another list', () => {
    const submenus = BLOCK_MENU_ROWS.filter(
      (row) => row.kind === 'submenu',
    ).map((row) => row.id);
    expect(submenus).toEqual(['blockType', 'insertBelow']);
  });

  it('marks comment as the one row with nothing behind it yet', () => {
    const coming = BLOCK_MENU_ROWS.filter((row) => row.kind === 'coming');
    expect(coming.map((row) => row.id)).toEqual(['comment']);
  });
});

describe('the insert menu', () => {
  it('offers the eight the first batch settled, in that order', () => {
    expect(INSERT_MENU_ROWS).toEqual([
      'heading-1',
      'heading-2',
      'heading-3',
      'bullet-list',
      'ordered-list',
      'quote',
      'code-block',
      'task-list',
    ]);
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
