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
 * The demo's list has eight entries and this has seven: "drag to move" is not
 * a menu row — it is the other gesture on the same handle (A4).
 */

import {
  Copy,
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
    | 'comment'
    | 'delete';
  /** i18n key for the row's name. */
  readonly labelKey: string;
  /** The icon the demo draws for it. */
  readonly Icon: LucideIcon;
}

/**
 * The seven rows, in the demo's order.
 *
 * Comment is a row with nothing behind it yet and is drawn like the bubble
 * bar's comment entry already is (A10) — the shape is whole from the first
 * slice, and what it must not do is look usable.
 *
 * Alignment and colour open what the bubble bar's own two slots open, down to
 * the rows and the panel, and each carries the icon the demo draws for it.
 * Both keep a STILL icon rather than the one the hovered block reads as: the
 * type row above them does the same, and a trigger that changed its face with
 * the row under the pointer would be the only thing in this menu that did.
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
    id: 'delete',
    labelKey: 'spaces.document.blockHandle.delete',
    Icon: Trash2,
  },
];
