// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The nine rows of the block type menu: what each one is called and drawn as.
 *
 * What a row DOES, and which of them the selection counts as, live in
 * `document-block-ticks.ts` — this file is the menu's presentation alone.
 *
 * The slot shows an ICON that tracks the current block and carries no text, so
 * nothing here goes through i18n (user 2026-08-26): it stands in the same run
 * as B, I and U, which are letterforms too, and a translated word would make
 * the bar's width depend on the language.
 *
 * Four of the five products surveyed put the block type's NAME on that button,
 * and all three that localise anything localise it (Notion's `Text`, Google
 * Docs' `Normal text`, BlockNote's 24 language packs). This one does not
 * follow, for the reason above.
 */

import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  ListTodo,
  type LucideIcon,
} from 'lucide-react';

import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';

/** One row of the menu. */
export interface BlockTypeItem {
  id: BlockTypeId;
  labelKey: string;
  Icon: LucideIcon;
}

/**
 * The nine, in the order user 2026-08-29 settled: the eight exclusive items,
 * a separator, then Quote.
 */
export const BLOCK_TYPE_ITEMS: BlockTypeItem[] = [
  {
    id: 'paragraph',
    labelKey: 'spaces.document.commands.paragraph',
    Icon: Type,
  },
  {
    id: 'heading-1',
    labelKey: 'spaces.document.commands.heading1',
    Icon: Heading1,
  },
  {
    id: 'heading-2',
    labelKey: 'spaces.document.commands.heading2',
    Icon: Heading2,
  },
  {
    id: 'heading-3',
    labelKey: 'spaces.document.commands.heading3',
    Icon: Heading3,
  },
  {
    id: 'bullet-list',
    labelKey: 'spaces.document.commands.bulletList',
    Icon: List,
  },
  {
    id: 'ordered-list',
    labelKey: 'spaces.document.commands.orderedList',
    Icon: ListOrdered,
  },
  {
    id: 'task-list',
    labelKey: 'spaces.document.commands.taskList',
    Icon: ListTodo,
  },
  {
    id: 'code-block',
    labelKey: 'spaces.document.commands.codeBlock',
    Icon: SquareCode,
  },
  {
    id: 'quote',
    labelKey: 'spaces.document.commands.quote',
    Icon: Quote,
  },
];

/** Finds a row by id; the paragraph row stands in when nothing matches. */
const BY_ID = new Map(BLOCK_TYPE_ITEMS.map((item) => [item.id, item]));

/**
 * The row a block type id names.
 * @param id - The id.
 * @returns That row, and the paragraph row for an id no longer in the list.
 */
export function blockTypeItem(id: BlockTypeId): BlockTypeItem {
  return BY_ID.get(id) ?? (BLOCK_TYPE_ITEMS[0] as BlockTypeItem);
}
