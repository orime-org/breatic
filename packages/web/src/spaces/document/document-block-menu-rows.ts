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
 * The demo's list has six entries and this has five: "drag to move" is not a
 * menu row — it is the other gesture on the same handle (A4).
 */

import {
  Copy,
  MessageSquareText,
  Plus,
  Trash2,
  Type,
  type LucideIcon,
} from 'lucide-react';

/** What pressing a row leads to. */
export type BlockMenuRowKind =
  /** Opens a submenu to the right. */
  | 'submenu'
  /** Runs there and then, and closes the menu. */
  | 'command'
  /** Stands in the menu with nothing behind it yet. */
  | 'coming';

/** One row of the block handle menu. */
export interface BlockMenuRow {
  /** Stable id, used for the test id and to pick the handler. */
  readonly id: 'blockType' | 'duplicate' | 'insertBelow' | 'comment' | 'delete';
  /** i18n key for the row's name. */
  readonly labelKey: string;
  /** The icon the demo draws for it. */
  readonly Icon: LucideIcon;
  /** What pressing it leads to. */
  readonly kind: BlockMenuRowKind;
}

/**
 * The five rows, in the demo's order.
 *
 * Comment is a row with nothing behind it yet and is drawn like the bubble
 * bar's comment entry already is (A10) — the shape is whole from the first
 * slice, and what it must not do is look usable.
 */
export const BLOCK_MENU_ROWS: readonly BlockMenuRow[] = [
  {
    id: 'blockType',
    labelKey: 'spaces.document.commands.blockType',
    Icon: Type,
    kind: 'submenu',
  },
  {
    id: 'duplicate',
    labelKey: 'spaces.document.blockHandle.duplicate',
    Icon: Copy,
    kind: 'command',
  },
  {
    id: 'insertBelow',
    labelKey: 'spaces.document.blockHandle.insertBelow',
    Icon: Plus,
    kind: 'submenu',
  },
  {
    id: 'comment',
    labelKey: 'spaces.document.commands.comment',
    Icon: MessageSquareText,
    kind: 'coming',
  },
  {
    id: 'delete',
    labelKey: 'spaces.document.blockHandle.delete',
    Icon: Trash2,
    kind: 'command',
  },
];
