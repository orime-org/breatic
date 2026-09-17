// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the insert menu offers, in the order it offers it.
 *
 * Every entry is a row of the block type menu, so the two menus name and draw
 * the same thing the same way — `BLOCK_TYPE_ITEMS` is the one table both read
 * (`document-block-type.ts`).
 *
 * Text is deliberately absent: the row the menu opens in is already a
 * paragraph, so "make this a paragraph" is the one choice that would do
 * nothing.
 *
 * Everything the product has not built yet — the divider (#124), tables (#15),
 * uploaded media (#16 / #17), generated media (#20) — is absent by not being
 * here (A15). A row is added to this list when the thing behind it exists, so
 * the menu never offers something that cannot happen.
 */

import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';

/**
 * The character the insert menu is registered under.
 *
 * Nothing types it: the menu is registered with `shouldOpen: () => false`, so
 * a slash the reader types stays plain text (A16), and the plus opens the menu
 * through `openSuggestionMenu`, which does not put the character in the
 * document (`SuggestionMenu.ts:216-218` inserts it only when the caller asks
 * for `deleteTriggerCharacter`). It still has to be a character, because the
 * plugin keys its registered menus by one.
 */
export const INSERT_TRIGGER = '/';

/** The one group the first batch of entries sits under. */
export const INSERT_GROUP_LABEL_KEY = 'spaces.document.insertMenu.basicGroup';

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
