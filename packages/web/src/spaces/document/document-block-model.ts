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
 *   4. One press builds one transaction, dispatched once and only where every
 *      step succeeded.
 *   5. A document holds one level of quote.
 *
 * Rule 4 is why nothing here goes through tiptap's command layer: both
 * `chain().run()` and a single `editor.commands.*` dispatch the transaction
 * before reporting whether the steps worked (`@tiptap/core@3.29.2`
 * `dist/index.js:60-63` and `:82-87`), which would leave half a press in the
 * document. Everything below writes into one `Transaction` through transform
 * primitives, and `runBlockType` dispatches it once.
 */

import type { Editor } from '@tiptap/core';
import { NodeRange, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { canSplit, findWrapping, liftTarget } from '@tiptap/pm/transform';
import { wrapRangeInList } from '@tiptap/pm/schema-list';

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
const LIST_NODE: Partial<Record<BlockTypeId, string>> = {
  'bullet-list': 'bulletList',
  'ordered-list': 'orderedList',
  'task-list': 'taskList',
};

/** Every node name that counts as a list. */
const LIST_NAMES = new Set<string>(Object.values(LIST_NODE));

/** The one node Quote wraps its content in. */
const QUOTE_NAMES = new Set<string>(['blockquote']);

/** The heading level each heading row stands for. */
const HEADING_LEVEL: Partial<Record<BlockTypeId, number>> = {
  'heading-1': 1,
  'heading-2': 2,
  'heading-3': 3,
};

/**
 * The name of the nearest list holding this position.
 * @param $pos - A resolved position inside a text block.
 * @returns The list's node name, or null where no list holds it.
 */
function nearestListName($pos: ReturnType<PMNode['resolve']>): string | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const name = $pos.node(depth).type.name;
    if (LIST_NAMES.has(name)) return name;
  }
  return null;
}

/**
 * Is a quote holding this position?
 * @param $pos - A resolved position inside a text block.
 * @returns Whether a blockquote holds it.
 */
function insideQuote($pos: ReturnType<PMNode['resolve']>): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (QUOTE_NAMES.has($pos.node(depth).type.name)) return true;
  }
  return false;
}

/**
 * Does the text block at this position count as the given item?
 *
 * The four kinds are judged differently. A list is the nearest list ancestor
 * while the block itself is a paragraph, so judging a list by the block's own
 * type would tick Text and leave the list blank.
 * @param doc - The document.
 * @param pos - A position inside a text block.
 * @param id - Which row.
 * @returns Whether the block is that item.
 */
function isItemAt(doc: PMNode, pos: number, id: BlockTypeId): boolean {
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock) return false;
  if (id === 'quote') return insideQuote($pos);
  const list = LIST_NODE[id];
  if (list !== undefined) return nearestListName($pos) === list;
  if (id === 'paragraph') {
    return block.type.name === 'paragraph' && nearestListName($pos) === null;
  }
  if (id === 'code-block') return block.type.name === 'codeBlock';
  return block.type.name === 'heading' && block.attrs.level === HEADING_LEVEL[id];
}

/**
 * One position inside each text block the range covers.
 * @param doc - The document.
 * @param from - Range start.
 * @param to - Range end.
 * @returns Those positions, in document order.
 */
function textBlockPositions(doc: PMNode, from: number, to: number): number[] {
  const found: number[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    found.push(pos + 1);
    return false;
  });
  return found;
}

/**
 * Is every text block in the selection this item?
 *
 * Empty answers false for all nine: "every block is" holds vacuously over an
 * empty set, which would tick the whole menu at once. The menu never opens on
 * such a selection anyway (`SelectionBubbleBar.tsx`'s `isWarranted` wants text
 * in it), and the shortcuts follow the menu.
 * @param editor - The editor.
 * @param id - Which row.
 * @returns Whether the row is ticked.
 */
export function isMarked(editor: Editor, id: BlockTypeId): boolean {
  const { doc, selection } = editor.state;
  const positions = textBlockPositions(doc, selection.from, selection.to);
  if (positions.length === 0) return false;
  return positions.every((pos) => isItemAt(doc, pos, id));
}

/**
 * The node range covering the selection's text blocks.
 * @param tr - The transaction.
 * @returns That range, or null where the selection holds no text block.
 */
function selectedRange(tr: Transaction): NodeRange | null {
  const positions = textBlockPositions(tr.doc, tr.selection.from, tr.selection.to);
  const first = positions[0];
  const last = positions[positions.length - 1];
  if (first === undefined || last === undefined) return null;
  return tr.doc.resolve(first).blockRange(tr.doc.resolve(last));
}

/**
 * Lifts every text block in the selection out of the lists holding it.
 *
 * The range is the block's own, so what comes out is the text block itself and
 * the list structure around it falls away. Runs until a pass lifts nothing:
 * each lift drops one block one level, so the summed depth of the covered
 * blocks strictly decreases and the loop ends — a pass count would instead
 * leave the items beyond it in their old list while the transaction went out
 * anyway.
 * @param tr - The transaction, written into.
 */
function liftOutOfLists(tr: Transaction): void {
  for (;;) {
    let lifted = false;
    const { from, to } = tr.selection;
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (lifted || !node.isTextblock) return !lifted;
      const $from = tr.doc.resolve(pos + 1);
      if (nearestListName($from) === null) return false;
      const range = $from.blockRange(tr.doc.resolve(pos + node.nodeSize - 1));
      if (!range) return false;
      const target = liftTarget(range);
      if (target === null) return false;
      tr.lift(range, target);
      lifted = true;
      return false;
    });
    if (!lifted) return;
  }
}

/**
 * The stretch of one quote's content the selection covers.
 *
 * Sits at the quote's own depth, so lifting it takes that quote off its
 * content rather than taking the text block out of whatever holds it innermost
 * — for a quoted list the innermost is the list, which the press has no
 * business touching.
 * @param tr - The transaction.
 * @returns That range, or null where no quote holds the selection.
 */
function innermostQuoteRange(tr: Transaction): NodeRange | null {
  const positions = textBlockPositions(tr.doc, tr.selection.from, tr.selection.to);
  for (const pos of positions) {
    const $pos = tr.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if (!QUOTE_NAMES.has($pos.node(depth).type.name)) continue;
      const quoteStart = $pos.start(depth);
      const shared = positions.filter((other) => {
        const $other = tr.doc.resolve(other);
        return $other.depth >= depth && $other.start(depth) === quoteStart;
      });
      const first = shared[0];
      const last = shared[shared.length - 1];
      if (first === undefined || last === undefined) continue;
      return new NodeRange(tr.doc.resolve(first), tr.doc.resolve(last), depth);
    }
  }
  return null;
}

/**
 * Takes every quote off the selected blocks, however many levels deep.
 *
 * Where the selection covers only part of a quote's content, the lift splits
 * it and the blocks nobody selected stay in a quote of their own (§5.1).
 * @param tr - The transaction, written into.
 */
function unwrapQuotes(tr: Transaction): void {
  for (;;) {
    const range = innermostQuoteRange(tr);
    if (!range) return;
    const target = liftTarget(range);
    if (target === null) return;
    tr.lift(range, target);
  }
}

/**
 * The depth of the nearest list holding the whole range.
 * @param range - The range.
 * @returns That depth, or null where no list holds it.
 */
function listDepthOf(range: NodeRange): number | null {
  for (let depth = range.depth; depth > 0; depth -= 1) {
    if (LIST_NAMES.has(range.$from.node(depth).type.name)) return depth;
  }
  return null;
}

/**
 * Splits the nearest list at the selection's edges.
 *
 * Leaves the selected items in a list of their own, so wrapping that list in a
 * quote leaves the items nobody selected outside it (§5.2 of the design). The
 * tail goes first: splitting there does not move the positions before it.
 * @param tr - The transaction, written into.
 */
function splitListAtSelectionEdges(tr: Transaction): void {
  const range = selectedRange(tr);
  if (!range) return;
  const depth = listDepthOf(range);
  if (depth === null) return;
  const itemDepth = depth + 1;

  if (range.$to.index(depth) + 1 < range.$from.node(depth).childCount) {
    const tail = range.$to.after(itemDepth);
    if (canSplit(tr.doc, tail, 1)) tr.split(tail, 1);
  }
  if (range.$from.index(depth) > 0) {
    const moved = selectedRange(tr);
    if (moved) {
      const head = moved.$from.before(itemDepth);
      if (canSplit(tr.doc, head, 1)) tr.split(head, 1);
    }
  }
}

/**
 * Wraps the selection in a quote, taking the nearest list along with it.
 *
 * Walks outwards from the blocks: the first depth a quote can hold is the list
 * the items sit on, and where they sit in no list it is the blocks themselves.
 * @param tr - The transaction, written into.
 * @returns Whether the wrapping went in.
 */
function wrapInQuote(tr: Transaction): boolean {
  const quote = tr.doc.type.schema.nodes.blockquote;
  if (!quote) return false;
  splitListAtSelectionEdges(tr);
  const range = selectedRange(tr);
  if (!range) return false;
  for (let depth = range.depth; depth >= 0; depth -= 1) {
    const outer = new NodeRange(range.$from, range.$to, depth);
    const wrapping = findWrapping(outer, quote);
    if (wrapping) {
      tr.wrap(outer, wrapping);
      return true;
    }
  }
  return false;
}

/**
 * Sets every text block in the selection to this type.
 * @param tr - The transaction, written into.
 * @param type - The target node type.
 * @param attrs - Attributes for it.
 * @returns Whether the selection still held a text block.
 */
function setBlocks(
  tr: Transaction,
  type: NodeType,
  attrs: Record<string, unknown> | null,
): boolean {
  const { from, to } = tr.selection;
  if (textBlockPositions(tr.doc, from, to).length === 0) return false;
  tr.setBlockType(from, to, type, attrs ?? undefined);
  return true;
}

/**
 * Turns the selection into blocks of one type, list wrappers giving way.
 * @param tr - The transaction, written into.
 * @param type - The target node type.
 * @param attrs - Attributes for it.
 * @returns Whether every step went in.
 */
function toBlockType(
  tr: Transaction,
  type: NodeType,
  attrs: Record<string, unknown> | null,
): boolean {
  liftOutOfLists(tr);
  return setBlocks(tr, type, attrs);
}

/**
 * Turns the selection into items of one list type.
 *
 * A list item's first block is a paragraph, so whatever the blocks were has to
 * become one before the list can hold them.
 * @param tr - The transaction, written into.
 * @param listType - The list node type.
 * @returns Whether every step went in.
 */
function toList(tr: Transaction, listType: NodeType): boolean {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!paragraph) return false;
  liftOutOfLists(tr);
  if (!setBlocks(tr, paragraph, null)) return false;
  const range = selectedRange(tr);
  if (!range) return false;
  return wrapRangeInList(tr, range, listType);
}

/**
 * Writes one row's transition into the transaction.
 * @param tr - The transaction, written into.
 * @param schema - The document schema.
 * @param id - Which row.
 * @param marked - Whether the row is already ticked.
 * @returns Whether every step went in.
 */
function applyTransition(
  tr: Transaction,
  schema: Schema,
  id: BlockTypeId,
  marked: boolean,
): boolean {
  if (id === 'quote') {
    // Both directions start by taking the selected blocks out of every quote
    // holding them, which is what splits an original quote at the selection's
    // edges and leaves the blocks nobody selected inside it.
    unwrapQuotes(tr);
    return marked ? true : wrapInQuote(tr);
  }

  const target: BlockTypeId = marked ? 'paragraph' : id;
  const listNode = LIST_NODE[target];
  if (listNode !== undefined) {
    const listType = schema.nodes[listNode];
    return listType === undefined ? false : toList(tr, listType);
  }
  if (target === 'code-block') {
    const type = schema.nodes.codeBlock;
    return type === undefined ? false : toBlockType(tr, type, null);
  }
  const level = HEADING_LEVEL[target];
  if (level !== undefined) {
    const type = schema.nodes.heading;
    return type === undefined ? false : toBlockType(tr, type, { level });
  }
  const type = schema.nodes.paragraph;
  return type === undefined ? false : toBlockType(tr, type, null);
}

/**
 * Runs the row's transition against the selection, as one transaction.
 *
 * A node selection is turned into the text range covering the same blocks
 * first, so every shape reaches the same transition (A9).
 * @param editor - The editor.
 * @param id - Which row.
 */
export function runBlockType(editor: Editor, id: BlockTypeId): void {
  const { state } = editor;
  const positions = textBlockPositions(state.doc, state.selection.from, state.selection.to);
  const first = positions[0];
  const last = positions[positions.length - 1];
  if (first === undefined || last === undefined) return;

  const listNode = LIST_NODE[id];
  if (listNode !== undefined && state.schema.nodes[listNode] === undefined) return;

  const marked = isMarked(editor, id);
  const tr = state.tr;
  if (!(state.selection instanceof TextSelection)) {
    tr.setSelection(TextSelection.create(tr.doc, first, last));
  }
  if (applyTransition(tr, state.schema, id, marked)) editor.view.dispatch(tr);
}

/**
 * Which block a position counts as, for the slot's face.
 *
 * The exclusive item it is: the nearest list where a list holds it, and the
 * block's own type otherwise. A quote is orthogonal and takes no part, which
 * is what makes the face show a heading inside a quote (#928).
 * @param doc - The document.
 * @param pos - A position inside a text block.
 * @returns That block's type, or null when it is none of the nine.
 */
export function blockTypeAt(doc: PMNode, pos: number): BlockTypeId | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const list = nearestListName($pos);
  if (list !== null) {
    const row = (Object.keys(LIST_NODE) as BlockTypeId[])
      .find((id) => LIST_NODE[id] === list);
    if (row !== undefined) return row;
  }
  const block = $pos.parent;
  if (block.type.name === 'paragraph') return 'paragraph';
  if (block.type.name === 'codeBlock') return 'code-block';
  if (block.type.name === 'heading') {
    const level = block.attrs.level;
    if (level === 1) return 'heading-1';
    if (level === 2) return 'heading-2';
    if (level === 3) return 'heading-3';
  }
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
 * into a code block still moves the heading, so the control is live.
 * @param editor - The editor.
 * @returns Whether the selection holds at least one alignable block.
 */
export function selectionCanAlign(editor: Editor): boolean {
  const { doc, selection } = editor.state;
  return textBlockPositions(doc, selection.from, selection.to).some((pos) => {
    const type = blockTypeAt(doc, pos);
    return type !== null && ALIGNABLE.has(type);
  });
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
  const first = textBlockPositions(doc, selection.from, selection.to)[0];
  if (first === undefined) return 'paragraph';
  return blockTypeAt(doc, first) ?? 'paragraph';
}
