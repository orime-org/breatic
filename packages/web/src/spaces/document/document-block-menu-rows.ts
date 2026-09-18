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

/** One row of the block handle menu. */
export interface BlockMenuRow {
  /** Stable id, used for the test id and to pick the handler. */
  readonly id: 'blockType' | 'duplicate' | 'insertBelow' | 'comment' | 'delete';
  /** i18n key for the row's name. */
  readonly labelKey: string;
  /** The icon the demo draws for it. */
  readonly Icon: LucideIcon;
  /**
   * Whether the row stands in the menu with nothing behind it yet.
   *
   * The only thing the render asks this table beyond the three above: which
   * command a row runs is picked by its id, and a submenu is a submenu because
   * of what that id's branch builds.
   */
  readonly comingSoon: boolean;
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
    comingSoon: false,
  },
  {
    id: 'duplicate',
    labelKey: 'spaces.document.blockHandle.duplicate',
    Icon: Copy,
    comingSoon: false,
  },
  {
    id: 'insertBelow',
    labelKey: 'spaces.document.blockHandle.insertBelow',
    Icon: Plus,
    comingSoon: false,
  },
  {
    id: 'comment',
    labelKey: 'spaces.document.commands.comment',
    Icon: MessageSquareText,
    comingSoon: true,
  },
  {
    id: 'delete',
    labelKey: 'spaces.document.blockHandle.delete',
    Icon: Trash2,
    comingSoon: false,
  },
];
