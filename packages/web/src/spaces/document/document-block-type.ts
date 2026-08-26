// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the block type slot holds, and which of them the selection counts as.
 *
 * The nine come from the demo (`2026-08-21-editor-command-surface.html:560-588`).
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
import type { Editor } from '@tiptap/core';

import type { ShortcutSpec } from '@web/spaces/canvas/format-shortcut';

/** The nine blocks this slot knows. */
export type BlockTypeId =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'quote'
  | 'code-block'
  | 'task-list';

/** One row of the menu. */
export interface BlockTypeItem {
  id: BlockTypeId;
  labelKey: string;
  Icon: LucideIcon;
  /**
   * The shortcut the demo draws on the right; absent means no such column.
   *
   * A descriptor rather than a string: the same chord reads `⌘⌥1` on macOS and
   * `Ctrl+Alt+1` on Windows, and `packages/web/CLAUDE.md` makes carrying both
   * mandatory. `formatShortcut` turns it into whichever the reader is on.
   */
  shortcut?: ShortcutSpec;
  /**
   * The command behind this row.
   *
   * Three of the nine reach one today (bulleted list, numbered list, quote);
   * the rest carry the not-open-yet treatment (user 2026-08-23's rule, which
   * user 2026-08-26 confirmed still stands).
   */
  run?: (editor: Editor) => void;
}

/** The nine, in the demo's order. */
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
    shortcut: { mod: true, alt: true, key: '1' },
  },
  {
    id: 'heading-2',
    labelKey: 'spaces.document.commands.heading2',
    Icon: Heading2,
    shortcut: { mod: true, alt: true, key: '2' },
  },
  {
    id: 'heading-3',
    labelKey: 'spaces.document.commands.heading3',
    Icon: Heading3,
    shortcut: { mod: true, alt: true, key: '3' },
  },
  {
    id: 'bullet-list',
    labelKey: 'spaces.document.commands.bulletList',
    Icon: List,
    shortcut: { mod: true, shift: true, key: '8' },
    run: (e) => {
      e.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: 'ordered-list',
    labelKey: 'spaces.document.commands.orderedList',
    Icon: ListOrdered,
    shortcut: { mod: true, shift: true, key: '7' },
    run: (e) => {
      e.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: 'quote',
    labelKey: 'spaces.document.commands.quote',
    Icon: Quote,
    shortcut: { mod: true, shift: true, key: 'B' },
    run: (e) => {
      e.chain().focus().toggleBlockquote().run();
    },
  },
  {
    id: 'code-block',
    labelKey: 'spaces.document.commands.codeBlock',
    Icon: SquareCode,
    shortcut: { mod: true, alt: true, key: 'C' },
  },
  {
    id: 'task-list',
    labelKey: 'spaces.document.commands.taskList',
    Icon: ListTodo,
  },
];

/** Finds a row by id; the paragraph row stands in when nothing matches. */
const BY_ID = new Map(BLOCK_TYPE_ITEMS.map((item) => [item.id, item]));

/**
 * Which block a ProseMirror node counts as.
 * @param typeName - The node's schema name.
 * @param attrs - The node's attributes; headings tell their level here.
 * @returns The block type, or null when it is none of them.
 */
function blockTypeOf(
  typeName: string,
  attrs: Record<string, unknown>,
): BlockTypeId | null {
  if (typeName === 'paragraph') return 'paragraph';
  if (typeName === 'codeBlock') return 'code-block';
  if (typeName === 'heading') {
    const level = attrs.level;
    if (level === 1) return 'heading-1';
    if (level === 2) return 'heading-2';
    if (level === 3) return 'heading-3';
  }
  return null;
}

/**
 * Which block the current selection counts as.
 *
 * Walks every block the selection covers and collects their types. It names a
 * type ONLY when they all agree; a selection spanning two (a heading and the
 * paragraph under it, which is the common case) answers `paragraph` — the
 * slot's neutral reading, and the one that matches a menu with nothing lit.
 *
 * Not `editor.isActive()`: that answers "does this type appear anywhere in the
 * selection", which is true of both types across a spanning selection and
 * cannot tell "this whole run is a heading" from "the selection touched one".
 * @param editor - The editor.
 * @returns The current block type.
 */
export function currentBlockType(editor: Editor): BlockTypeId {
  const { from, to } = editor.state.selection;
  const seen = new Set<BlockTypeId | null>();
  // Lists and quotes wrap other blocks, so ask about them first: when one of
  // them holds the selection, that IS the type, and the paragraphs inside are
  // its content rather than the answer.
  if (editor.isActive('bulletList')) return 'bullet-list';
  if (editor.isActive('orderedList')) return 'ordered-list';
  if (editor.isActive('blockquote')) return 'quote';
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock) return true;
    seen.add(blockTypeOf(node.type.name, node.attrs));
    return false;
  });
  if (seen.size !== 1) return 'paragraph';
  const [only] = [...seen];
  return only ?? 'paragraph';
}

/**
 * The row for the current block type, which is where the slot's icon comes from.
 * @param editor - The editor.
 * @returns That row.
 */
export function currentBlockTypeItem(editor: Editor): BlockTypeItem {
  return BY_ID.get(currentBlockType(editor)) ?? BLOCK_TYPE_ITEMS[0];
}
