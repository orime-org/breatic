// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the block type slot holds, and which of them the selection counts as.
 *
 * The nine come from the demo's `块类型下拉` column
 * (`2026-08-21-editor-command-surface.html`).
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
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';

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
   * The schema node this row wraps its content in, for the rows that wrap.
   *
   * A list holds list items which hold paragraphs, so a position inside one
   * is in the LIST — the paragraph is its content. Naming that node here
   * keeps a wrapping row and the wrapper it stands for in one edit. The rows
   * that ARE text blocks are recognised in {@link blockTypeOf} instead.
   */
  wrapperNode?: string;
  /**
   * Drawn greyed out, the way the demo draws that row.
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
    wrapperNode: 'bulletList',
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
    wrapperNode: 'orderedList',
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
    wrapperNode: 'blockquote',
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

/** The wrapping rows, keyed by the node each one wraps its content in. */
const WRAPPERS = new Map<string, BlockTypeId>(
  BLOCK_TYPE_ITEMS.flatMap((item) =>
    (item.wrapperNode === undefined ? [] : [[item.wrapperNode, item.id] as const])),
);

/**
 * Which block a position counts as.
 *
 * Lists and quotes wrap other blocks, so a position inside one counts as that
 * wrapper and the paragraph holding the text is its content. The innermost
 * wrapper wins, which is the one a list command would act on.
 *
 * Asked of a POSITION rather than of the selection as a whole. Asking
 * `editor.isActive('bulletList')` answers only while the list covers the
 * whole selection (`@tiptap/core`'s `isNodeActive` compares `range >=
 * selectionRange`), so a selection running out of a list reported the
 * paragraph inside it — and no reachable answer named a list at all.
 * @param doc - The document.
 * @param pos - A position inside a text block.
 * @returns That block's type, or null when it is none of the nine.
 */
function blockTypeAt(doc: PMNode, pos: number): BlockTypeId | null {
  const at = doc.resolve(pos);
  // A position resting on a block boundary rather than inside a text block —
  // between two paragraphs, say — has no type of its own to report. Asked
  // before the wrappers, or such a position would answer for whatever holds
  // it and the caller would have no way to tell that apart from a real answer.
  if (!at.parent.isTextblock) return null;
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const wrapper = WRAPPERS.get(at.node(depth).type.name);
    if (wrapper !== undefined) return wrapper;
  }
  return blockTypeOf(at.parent.type.name, at.parent.attrs);
}

/**
 * Which block the current selection counts as.
 *
 * The end the reader anchored on, so the face answers "what am I in" rather
 * than going blank over a selection spanning two types (user 2026-08-27). The
 * anchor is that end — `head` is where the drag has reached, `anchor` where it
 * began.
 *
 * The anchor answers only where it resolves inside a text block, which a text
 * selection guarantees and the other two shapes do not: a select-all anchors
 * at 0, and a node selection at the position BEFORE the node it picked, both
 * of which resolve into whatever HOLDS the selection.
 *
 * A node selection names the node the reader picked. Cmd+click steps outward
 * on each further click (`prosemirror-view:3277`), so the pick can be a
 * wrapper holding another one, and the walk below reads the innermost — the
 * one inside what was picked. A picked node that wraps nothing (a list item,
 * a paragraph) has no answer of its own and falls to the walk, which puts it
 * with the list it belongs to, the same answer a text selection there gives.
 *
 * What is left falls to the walk, which takes the first block covered.
 * @param editor - The editor.
 * @returns The current block type.
 */
export function currentBlockType(editor: Editor): BlockTypeId {
  const { doc, selection } = editor.state;
  if (selection instanceof NodeSelection) {
    const picked = WRAPPERS.get(selection.node.type.name);
    if (picked !== undefined) return picked;
  }
  const anchored = blockTypeAt(doc, selection.anchor);
  if (anchored !== null) return anchored;
  let first: BlockTypeId | null = null;
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (first !== null) return false;
    if (!node.isTextblock) return true;
    first = blockTypeAt(doc, pos + 1);
    return false;
  });
  return first ?? 'paragraph';
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
  const { doc, selection } = editor.state;
  let found = false;
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    const type = blockTypeAt(doc, pos + 1);
    if (type !== null && ALIGNABLE.has(type)) found = true;
    return false;
  });
  return found;
}

/**
 * The row a block type id names.
 * @param id - The id.
 * @returns That row, and the paragraph row for an id no longer in the list.
 */
export function blockTypeItem(id: BlockTypeId): BlockTypeItem {
  return BY_ID.get(id) ?? BLOCK_TYPE_ITEMS[0];
}
