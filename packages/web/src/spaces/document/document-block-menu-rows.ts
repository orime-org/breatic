// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The rows the block handle menu holds, in the order it holds them.
 *
 * What each row DOES lives with the command it runs
 * (`document-handle-commands.ts`, `document-block-run.ts`,
 * `document-insert-row.ts`); this file is the menu's shape alone, the way
 * `document-block-type.ts` is the block type menu's.
 *
 * Seven of the rows are the demo's; its eighth entry, "drag to move", is not a
 * menu row — it is the other gesture on the same handle (A4). Add to Agent
 * (inner#936) is the eighth row here.
 */

import {
  Copy,
  IndentDecrease,
  IndentIncrease,
  MessageSquarePlus,
  MessageSquareText,
  Palette,
  Plus,
  TextAlignStart,
  Trash2,
  Type,
  type LucideIcon,
} from 'lucide-react';

/** One row of the block handle menu. */
export interface BlockMenuRow {
  /** Stable id, used for the test id and to pick the handler. */
  readonly id:
    | 'blockType'
    | 'duplicate'
    | 'insertBelow'
    | 'align'
    | 'color'
    | 'indent'
    | 'unindent'
    | 'comment'
    | 'addToAgent'
    | 'delete';
  /** i18n key for the row's name. */
  readonly labelKey: string;
  /** The icon the demo draws for it. */
  readonly Icon: LucideIcon;
}

/**
 * The eight rows: the demo's seven in its order, with Add to Agent after
 * Comment (inner#936).
 *
 * Comment opens a draft over the hovered row (A2), and reads unavailable on
 * a row with no words in it (A3) — the same two answers the bubble bar's own
 * comment entry gives.
 *
 * Alignment and colour open what the bubble bar's own two slots open, down to
 * the rows and the panel, and each carries the icon the demo draws for it.
 *
 * The alignment row's icon here is the row's STARTING face only: the menu
 * draws it off the hovered block's own alignment (`DocumentBlockMenu.tsx`),
 * the way the bubble bar draws its alignment opener off the selection's. The
 * other rows keep the icon this table gives them, because none of them
 * has a reading to show — "duplicate" and "delete" look the same whatever
 * block is under the pointer, and the type row's face would have to repeat
 * what the reader can already see in the body.
 */
export const BLOCK_MENU_ROWS: readonly BlockMenuRow[] = [
  {
    id: 'blockType',
    labelKey: 'spaces.document.commands.blockType',
    Icon: Type,
  },
  {
    id: 'duplicate',
    labelKey: 'spaces.document.blockHandle.duplicate',
    Icon: Copy,
  },
  {
    id: 'insertBelow',
    labelKey: 'spaces.document.blockHandle.insertBelow',
    Icon: Plus,
  },
  {
    id: 'align',
    labelKey: 'spaces.document.commands.align',
    Icon: TextAlignStart,
  },
  {
    id: 'color',
    labelKey: 'spaces.document.commands.color',
    Icon: Palette,
  },
  {
    id: 'comment',
    labelKey: 'spaces.document.commands.comment',
    Icon: MessageSquareText,
  },
  {
    id: 'addToAgent',
    labelKey: 'canvas.contextMenu.addToAgent',
    Icon: MessageSquarePlus,
  },
  {
    id: 'delete',
    labelKey: 'spaces.document.blockHandle.delete',
    Icon: Trash2,
  },
];

/**
 * A row of {@link BLOCK_MENU_ROWS}, by id.
 * @param id - The row's id.
 * @returns The row.
 */
function rowOf(id: BlockMenuRow['id']): BlockMenuRow {
  return BLOCK_MENU_ROWS.find((row) => row.id === id)!;
}

/**
 * The rows of a table's entry (inner#1126 A5). A table is not a text block,
 * so the rows that set a block's type, its alignment and its colour have
 * nothing to act on; indenting takes their place, and delete names what goes.
 */
export const TABLE_MENU_ROWS: readonly BlockMenuRow[] = [
  rowOf('insertBelow'),
  rowOf('duplicate'),
  { id: 'indent', labelKey: 'spaces.document.blockHandle.indent', Icon: IndentIncrease },
  { id: 'unindent', labelKey: 'spaces.document.blockHandle.unindent', Icon: IndentDecrease },
  rowOf('comment'),
  rowOf('addToAgent'),
  { ...rowOf('delete'), labelKey: 'spaces.document.blockHandle.deleteTable' },
];
