// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the handle menu's insert-below submenu offers, in the order it offers
 * it.
 *
 * Every entry is a row of the block type menu, so the two menus name and draw
 * the same thing the same way — `BLOCK_TYPE_ITEMS` is the one table both read
 * (`document-block-type.ts`).
 *
 * Text is deliberately absent: the row the command makes is already a
 * paragraph, so "make this a paragraph" is the one choice that would do
 * nothing.
 *
 * Everything the product has not built yet — the divider (#124), tables (#15),
 * uploaded media (#16 / #17), generated media (#20) — is absent by not being
 * here (A15). A row is added to this list when the thing behind it exists, so
 * the menu never offers something that cannot happen.
 */

import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';

/** The eight entries, in the demo's order. */
export const INSERT_MENU_ROWS: readonly BlockTypeId[] = [
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'ordered-list',
  'quote',
  'code-block',
  'task-list',
];
