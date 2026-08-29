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
 * The first and last text block the selection covers.
 * @param tr - The transaction.
 * @returns Those two positions, or null where the selection holds no text block.
 */
function selectionEnds(tr: Transaction): { first: number; last: number } | null {
  const positions = textBlockPositions(tr.doc, tr.selection.from, tr.selection.to);
  const first = positions[0];
  const last = positions[positions.length - 1];
  return first === undefined || last === undefined ? null : { first, last };
}

/**
 * The node range covering the selection's text blocks.
 * @param tr - The transaction.
 * @returns That range, or null where the selection holds no text block.
 */
function selectedRange(tr: Transaction): NodeRange | null {
  const ends = selectionEnds(tr);
  if (!ends) return null;
  return tr.doc.resolve(ends.first).blockRange(tr.doc.resolve(ends.last));
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
 *
 * Coming out one level is as far as some blocks go, and that is the answer the
 * design gives them: an item indented under another, with a sibling on its own
 * level, ends up a paragraph inside the item above rather than at the top
 * (§5.3, measured).
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
 * The depth of the nearest list holding this position.
 * @param $pos - A resolved position inside a text block.
 * @returns That depth, or null where no list holds it.
 */
function listDepthAt($pos: ReturnType<PMNode['resolve']>): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (LIST_NAMES.has($pos.node(depth).type.name)) return depth;
  }
  return null;
}

/**
 * Splits the nearest list at each end of the selection.
 *
 * Each end is asked on its own, so a selection running from outside a list
 * into it splits there all the same — the two ends can sit in different lists,
 * or one of them in none. What is left is a list holding the selected run and
 * nothing else, which is what lets a quote take that run and leave the items
 * nobody selected outside it (§5.2 of the design). The tail goes first:
 * splitting there does not move the positions before it.
 * @param tr - The transaction, written into.
 */
function splitListAtSelectionEdges(tr: Transaction): void {
  const tail = selectionEnds(tr);
  if (!tail) return;
  const $last = tr.doc.resolve(tail.last);
  const tailDepth = listDepthAt($last);
  if (tailDepth !== null && $last.index(tailDepth) + 1 < $last.node(tailDepth).childCount) {
    const at = $last.after(tailDepth + 1);
    if (canSplit(tr.doc, at, 1)) tr.split(at, 1);
  }

  const head = selectionEnds(tr);
  if (!head) return;
  const $first = tr.doc.resolve(head.first);
  const headDepth = listDepthAt($first);
  if (headDepth !== null && $first.index(headDepth) > 0) {
    const at = $first.before(headDepth + 1);
    if (canSplit(tr.doc, at, 1)) tr.split(at, 1);
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
 * The selection's text blocks, grouped into runs one list can hold.
 *
 * A run is a stretch of blocks sharing one parent with nothing between them,
 * which is what a list can wrap: blocks on either side of a quote's edge
 * belong to different parents, and blocks with a non-text block between them
 * are not adjacent. Each run becomes a list of its own, and what sits between
 * them stays where it is (§6.0).
 * @param tr - The transaction.
 * @returns Each run's first and last position, in document order.
 */
function selectedRuns(tr: Transaction): Array<[first: number, last: number]> {
  const runs: Array<[number, number]> = [];
  let parent: string | null = null;
  let previous = -2;
  for (const pos of textBlockPositions(tr.doc, tr.selection.from, tr.selection.to)) {
    const $pos = tr.doc.resolve(pos);
    const depth = $pos.depth - 1;
    const here = `${depth}:${$pos.start(depth)}`;
    const index = $pos.index(depth);
    const run = runs[runs.length - 1];
    if (run !== undefined && here === parent && index === previous + 1) run[1] = pos;
    else runs.push([pos, pos]);
    parent = here;
    previous = index;
  }
  return runs;
}

/**
 * Turns the selection into items of one list type.
 *
 * A list item's first block is a paragraph, so whatever the blocks were has to
 * become one before the list can hold them. The runs are wrapped back to
 * front, which leaves the positions of the earlier ones untouched.
 * @param tr - The transaction, written into.
 * @param listType - The list node type.
 * @returns Whether every step went in.
 */
function toList(tr: Transaction, listType: NodeType): boolean {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!paragraph) return false;
  liftOutOfLists(tr);
  if (!setBlocks(tr, paragraph, null)) return false;

  const runs = selectedRuns(tr);
  if (runs.length === 0) return false;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const [first, last] = runs[i] as [number, number];
    const range = tr.doc.resolve(first).blockRange(tr.doc.resolve(last));
    if (!range) return false;
    if (!wrapRangeInList(tr, range, listType)) return false;
  }
  return true;
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
    // Both directions start the same way. Splitting the list at the selection's
    // edges leaves the selected items in a list of their own, so either
    // direction acts on those and no others; taking the blocks out of every
    // quote holding them then splits an original quote at those same edges and
    // leaves the blocks nobody selected inside it.
    splitListAtSelectionEdges(tr);
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
  // Rule 4, both halves. `applyTransition` reports whether every step went in,
  // which keeps half a press out of the document; `docChanged` answers the
  // other way round — a press the schema left nowhere to go writes no step at
  // all, and an empty transaction has no business being dispatched.
  if (applyTransition(tr, state.schema, id, marked) && tr.docChanged) {
    editor.view.dispatch(tr);
  }
}

/**
 * The exclusive eight, lists first.
 *
 * A block held by a list is a paragraph of its own type, so both the list row
 * and Text answer for it; the list is the row the reader sees, and asking it
 * first is what makes the face say so.
 */
const EXCLUSIVE: BlockTypeId[] = [
  'bullet-list',
  'ordered-list',
  'task-list',
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'code-block',
];

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
