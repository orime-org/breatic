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
   * Three of the nine reach one today: bulleted list, numbered list, quote.
   */
  run?: (editor: Editor) => void;
  /**
   * Whether that command can run where the selection is.
   *
   * A dry run of the same chain. Inside a code block a list command reaches
   * nothing, and a row that reads as available and does nothing tells the
   * reader it is broken. Rows with no command carry no judgement to make.
   */
  canRun?: (editor: Editor) => boolean;
  /**
   * Drawn greyed out, the way demo:588 draws it.
   *
   * The demo greys one row, and for a reason of its own: the task list has no
   * schema node at all yet (#13). It has a place in the menu because a
   * paragraph could be turned into one; it does not read as available because
   * there is nothing to turn into.
   */
  greyed?: true;
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
    canRun: (e) => e.can().chain().toggleBulletList().run(),
    run: (e) => {
      e.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: 'ordered-list',
    labelKey: 'spaces.document.commands.orderedList',
    Icon: ListOrdered,
    shortcut: { mod: true, shift: true, key: '7' },
    canRun: (e) => e.can().chain().toggleOrderedList().run(),
    run: (e) => {
      e.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: 'quote',
    labelKey: 'spaces.document.commands.quote',
    Icon: Quote,
    shortcut: { mod: true, shift: true, key: 'B' },
    canRun: (e) => e.can().chain().toggleBlockquote().run(),
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
    greyed: true,
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
 * Walks every block the selection covers and collects their types. Where they
 * all agree it names that type; where they do not it names the type of the end
 * the reader anchored the selection on.
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
  const wrapping = wrappingBlockType(editor);
  if (wrapping !== null) return wrapping;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock) return true;
    seen.add(blockTypeOf(node.type.name, node.attrs));
    return false;
  });
  if (seen.size !== 1) return blockTypeAtAnchor(editor);
  const [only] = [...seen];
  return only ?? 'paragraph';
}

/**
 * The list or quote holding the selection, if one does.
 *
 * Lists and quotes wrap other blocks, so they are asked about first: when one
 * of them holds the selection, that IS the type, and the paragraphs inside are
 * its content rather than the answer.
 * @param editor - The editor.
 * @returns That type, or null when no wrapper holds the selection.
 */
function wrappingBlockType(editor: Editor): BlockTypeId | null {
  if (editor.isActive('bulletList')) return 'bullet-list';
  if (editor.isActive('orderedList')) return 'ordered-list';
  if (editor.isActive('blockquote')) return 'quote';
  return null;
}

/** The block types alignment has anything to say about. */
const ALIGNABLE = new Set<BlockTypeId>([
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
]);

/**
 * Is there anything in the selection alignment would reach?
 *
 * One alignable block is enough: aligning a selection that runs from a heading
 * into a code block still moves the heading, so the control is live. Asking
 * `currentBlockType` instead would answer for one end alone and grey the
 * control over a selection its command does reach.
 * @param editor - The editor.
 * @returns Whether the selection holds at least one alignable block.
 */
export function selectionCanAlign(editor: Editor): boolean {
  const wrapping = wrappingBlockType(editor);
  if (wrapping !== null) return ALIGNABLE.has(wrapping);
  const { from, to } = editor.state.selection;
  let found = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (found || !node.isTextblock) return !found;
    const type = blockTypeOf(node.type.name, node.attrs);
    if (type !== null && ALIGNABLE.has(type)) found = true;
    return false;
  });
  return found;
}

/**
 * The block type of the end the reader started the selection from.
 *
 * Over a run of one type the face names that type; over two it names the end
 * the reader is standing on, so the face answers "what am I in" rather than
 * going blank (user 2026-08-27). The anchor is that end — `head` is where the
 * drag has reached, `anchor` where it began.
 * @param editor - The editor.
 * @returns That block's type.
 */
function blockTypeAtAnchor(editor: Editor): BlockTypeId {
  const at = editor.state.doc.resolve(editor.state.selection.anchor);
  // An anchor resting on a block boundary rather than inside a text block —
  // between two paragraphs, say — has no type of its own to report.
  if (!at.parent.isTextblock) return 'paragraph';
  return blockTypeOf(at.parent.type.name, at.parent.attrs) ?? 'paragraph';
}

/**
 * The row a block type id names.
 * @param id - The id.
 * @returns That row, and the paragraph row for an id no longer in the list.
 */
export function blockTypeItem(id: BlockTypeId): BlockTypeItem {
  return BY_ID.get(id) ?? BLOCK_TYPE_ITEMS[0];
}
