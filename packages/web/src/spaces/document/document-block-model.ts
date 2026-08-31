// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The block type model: eight exclusive items plus Quote across them.
 *
 * A block is exactly one of Text, the three headings, the three lists and Code
 * block, because a list item's first block can only be a paragraph and so a
 * list cannot hold a heading on the row the reader sees. Quote sits on top of
 * any of them, because `blockquote` is `block+`.
 *
 * Five rules, with the tick and the transition sharing one judgement:
 *   1. A row is ticked when every text block in the selection is that item.
 *   2. Pressing a ticked exclusive row goes back to Text; pressing an unticked
 *      one turns every block into it, the other exclusive rows giving way.
 *   3. Pressing Quote wraps or unwraps and leaves the block type alone.
 *   4. One press builds one transaction, dispatched once and only where it
 *      reached a block. Blocks the schema will not move stay where they are.
 *   5. A document holds one level of quote.
 *
 * This file answers what a block already is; `document-block-press.ts` carries
 * out rules 2 to 4 against a selection.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

/** The nine blocks the menu knows. */
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

/** The schema node each list row stands for. */
export const LIST_NODE: Partial<Record<BlockTypeId, string>> = {
  'bullet-list': 'bulletList',
  'ordered-list': 'orderedList',
  'task-list': 'taskList',
};

/** Every node name that counts as a list. */
const LIST_NAMES = new Set<string>(Object.values(LIST_NODE));

/** The one node Quote wraps its content in. */
export const QUOTE_NAMES = new Set<string>(['blockquote']);

/** The heading level each heading row stands for. */
export const HEADING_LEVEL: Partial<Record<BlockTypeId, number>> = {
  'heading-1': 1,
  'heading-2': 2,
  'heading-3': 3,
};

/** A resolved position, which is what every ancestor question is asked of. */
export type Resolved = ReturnType<PMNode['resolve']>;

/**
 * The depth of the nearest ancestor going outwards whose node is one of these.
 *
 * Depth 0 is the document, which no caller is asking about, so the walk stops
 * above it.
 * @param $pos - A resolved position.
 * @param names - The node names being looked for.
 * @returns That depth, or null where no ancestor is one of them.
 */
export function nearestDepth($pos: Resolved, names: Set<string>): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (names.has($pos.node(depth).type.name)) return depth;
  }
  return null;
}

/**
 * The depth of the nearest list holding this position.
 * @param $pos - A resolved position inside a text block.
 * @returns That depth, or null where no list holds it.
 */
export function listDepthAt($pos: Resolved): number | null {
  return nearestDepth($pos, LIST_NAMES);
}

/**
 * Is a quote holding this position?
 * @param $pos - A resolved position inside a text block.
 * @returns Whether a blockquote holds it.
 */
function insideQuote($pos: Resolved): boolean {
  return nearestDepth($pos, QUOTE_NAMES) !== null;
}

/**
 * The list this block is an item of.
 *
 * A block is a list item only where it is its item's FIRST block (user
 * 2026-08-30). The marker is drawn on the list item and sits beside its first
 * line, so a later block of the same item carries none: the reader sees a
 * plain paragraph, and a judgement reading "some list is above me" would have
 * the menu report a list where there is no bullet.
 * @param $pos - A resolved position inside a text block.
 * @returns That list's node name, or null where the block is not an item.
 */
export function itemListName($pos: Resolved): string | null {
  const listDepth = listDepthAt($pos);
  // The block sits at `listDepth + 2`: list, item, block.
  if (listDepth === null || $pos.depth !== listDepth + 2) return null;
  if ($pos.index(listDepth + 1) !== 0) return null;
  return $pos.node(listDepth).type.name;
}

/**
 * Does the text block at this position count as the given item?
 *
 * The four kinds are judged differently. A list is judged by the block's place
 * — see {@link itemListName} — while the block itself is a paragraph, so
 * judging a list by the block's own type would tick Text and leave the list
 * blank.
 * @param doc - The document.
 * @param pos - A position inside a text block.
 * @param id - Which row.
 * @returns Whether the block is that item.
 */
export function isItemAt(doc: PMNode, pos: number, id: BlockTypeId): boolean {
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock) return false;
  if (id === 'quote') return insideQuote($pos);
  const list = LIST_NODE[id];
  if (list !== undefined) return itemListName($pos) === list;
  if (id === 'paragraph') {
    return block.type.name === 'paragraph' && itemListName($pos) === null;
  }
  if (id === 'code-block') return block.type.name === 'codeBlock';
  return block.type.name === 'heading' && block.attrs.level === HEADING_LEVEL[id];
}

/**
 * Every row, and where the face asks it.
 *
 * A `Record` over `BlockTypeId` rather than an array, so a row joining the
 * union without joining this table is a compile error and cannot end up drawn
 * in the menu yet never asked about.
 *
 * The line order is the order `blockTypeAt` asks the rows in, which is its own
 * order and not the menu's — `BLOCK_TYPE_ITEMS` draws them in the order the
 * reader sees. No two rows can answer for one block, a list item's own node
 * being a paragraph and `paragraph` excluding items, so what the order settles
 * is which answer comes back first if that ever stops holding.
 */
const ROW_ORDER: Record<BlockTypeId, true> = {
  'bullet-list': true,
  'ordered-list': true,
  'task-list': true,
  paragraph: true,
  'heading-1': true,
  'heading-2': true,
  'heading-3': true,
  'code-block': true,
  quote: true,
};

/** All nine rows, in that order. */
const ROWS = Object.keys(ROW_ORDER) as BlockTypeId[];

/** The exclusive eight: every row but Quote, which sits across them. */
const EXCLUSIVE = ROWS.filter((id) => id !== 'quote');

/**
 * Does this row belong to the exclusive group?
 *
 * The one boundary in the nine: an exclusive row replaces whichever other one
 * the block is, and Quote sits across all of them. The menu rules the two
 * groups apart on this answer rather than on the name of the row the rule
 * happens to follow today.
 * @param id - Which row.
 * @returns Whether it is one of the exclusive eight.
 */
export function isExclusiveRow(id: BlockTypeId): boolean {
  return id !== 'quote';
}

/**
 * A document and a selection over it, which is all any of the readers below
 * want. Both `EditorState` and `Transaction` are one.
 */
interface Selected {
  doc: PMNode;
  selection: Selection;
}

/**
 * One position inside each text block the selection covers.
 * @param src - The document and the selection over it.
 * @returns Those positions, in document order.
 */
export function selectedBlocks(src: Selected): number[] {
  const found: number[] = [];
  src.doc.nodesBetween(src.selection.from, src.selection.to, (node, pos) => {
    if (!node.isTextblock) return true;
    found.push(pos + 1);
    return false;
  });
  return found;
}

/**
 * Rule 1: is every one of these blocks that item?
 *
 * Empty answers no for all nine — "every block is" holds vacuously over an
 * empty set, which would tick the whole menu at once. The menu never opens on
 * such a selection anyway (`SelectionBubbleBar.tsx`'s `isWarranted` wants text
 * in it), and the shortcuts follow the menu.
 * @param doc - The document.
 * @param positions - One position inside each block.
 * @param id - Which row.
 * @returns Whether the row is ticked over them.
 */
export function markedOver(doc: PMNode, positions: number[], id: BlockTypeId): boolean {
  return positions.length > 0 && positions.every((pos) => isItemAt(doc, pos, id));
}

/**
 * Every row the selection is, in one walk of it.
 * @param editor - The editor.
 * @returns The ticked rows.
 */
export function markedIds(editor: Editor): Set<BlockTypeId> {
  const positions = selectedBlocks(editor.state);
  return new Set(ROWS.filter((id) => markedOver(editor.state.doc, positions, id)));
}


/**
 * Which block a position counts as, for the slot's face.
 *
 * The exclusive item it is, judged by the same `isItemAt` the ticks use. A
 * quote is orthogonal and takes no part, which is what makes the face show a
 * heading inside a quote (#928).
 * @param doc - The document.
 * @param pos - A position inside a text block.
 * @returns That block's type, or null when it is none of the nine.
 */
export function blockTypeAt(doc: PMNode, pos: number): BlockTypeId | null {
  return EXCLUSIVE.find((id) => isItemAt(doc, pos, id)) ?? null;
}


/**
 * Which block the current selection counts as, for the slot's face.
 *
 * The end the reader anchored on, so the face answers "what am I in" rather
 * than going blank over a selection spanning two types (user 2026-08-27). A
 * select-all anchors at 0 and a node selection at the position before the node
 * it picked, neither of which resolves inside a text block; those fall to the
 * first block the selection covers.
 * @param editor - The editor.
 * @returns The current block type.
 */
export function currentBlockType(editor: Editor): BlockTypeId {
  const { doc, selection } = editor.state;
  const anchored = blockTypeAt(doc, selection.anchor);
  if (anchored !== null) return anchored;
  const first = selectedBlocks(editor.state)[0];
  if (first === undefined) return 'paragraph';
  return blockTypeAt(doc, first) ?? 'paragraph';
}
