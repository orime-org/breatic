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
import { TextSelection, type Selection, type Transaction } from '@tiptap/pm/state';
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

/** A resolved position, which is what every ancestor question is asked of. */
type Resolved = ReturnType<PMNode['resolve']>;

/**
 * The depth of the nearest ancestor going outwards whose node is one of these.
 *
 * Depth 0 is the document, which no caller is asking about, so the walk stops
 * above it.
 * @param $pos - A resolved position.
 * @param names - The node names being looked for.
 * @returns That depth, or null where no ancestor is one of them.
 */
function nearestDepth($pos: Resolved, names: Set<string>): number | null {
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
function listDepthAt($pos: Resolved): number | null {
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
function itemListName($pos: Resolved): string | null {
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
function isItemAt(doc: PMNode, pos: number, id: BlockTypeId): boolean {
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
 * The line order is the order `blockTypeAt` asks the rows in. No two of them
 * can answer for one block — a list item's own node is a paragraph and
 * `paragraph` excludes items — so the order settles nothing today; it is the
 * order the menu reads in, kept here so the face and the menu cannot disagree.
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
function selectedBlocks(src: Selected): number[] {
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
function markedOver(doc: PMNode, positions: number[], id: BlockTypeId): boolean {
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
 * Is every text block in the selection this item?
 * @param editor - The editor.
 * @param id - Which row.
 * @returns Whether the row is ticked.
 */
export function isMarked(editor: Editor, id: BlockTypeId): boolean {
  return markedOver(editor.state.doc, selectedBlocks(editor.state), id);
}

/**
 * The first and last text block the selection covers.
 * @param src - The document and the selection over it.
 * @returns Those two positions, or null where the selection holds no text block.
 */
function selectionEnds(src: Selected): { first: number; last: number } | null {
  const positions = selectedBlocks(src);
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
 * Takes each list item in the selection one level out of its list.
 *
 * ONE level per block, then stop (user 2026-08-30,
 * `demo/2026-08-30-nested-list-lift-decision.html`). An item of a nested list
 * lands in the item above as a plain paragraph, and an item of a top level
 * list lands in the body — one level takes it out either way. Lifting until
 * nothing moves instead read the answer off whether the block happened to land
 * mid-item, so two adjacent items of one list took opposite paths.
 *
 * Only blocks that ARE list items move: a later block of an item carries no
 * marker and is nothing the exclusive rows have to make way for, so leaving it
 * alone is what keeps the blocks nobody selected where they stand.
 *
 * The range sits on what the list item holds, not on what holds the block, so
 * a quote between the two comes out with the block instead of being taken off
 * it — Quote is orthogonal to the exclusive rows (rule 3, A4) and §6.1's
 * measured path leaves blockquote alone.
 * @param tr - The transaction, written into.
 */
function liftOutOfLists(tr: Transaction): void {
  for (let i = 0; ; i += 1) {
    const pos = selectedBlocks(tr)[i];
    if (pos === undefined) return;
    const $from = tr.doc.resolve(pos);
    const listDepth = listDepthAt($from);
    if (listDepth === null || itemListName($from) === null) continue;
    const range = new NodeRange($from, $from, listDepth + 1);
    const target = liftTarget(range);
    if (target === null) continue;
    tr.lift(range, target);
  }
}

/**
 * Did the press land every selected block on the row it aimed at?
 *
 * Rule 2 says an unticked press turns EVERY block into that row and a ticked
 * one takes every block back to Text, so a press that moved some and left
 * others is half of what it promised (rule 4). Reading the result back off the
 * document is what catches a block the schema would not let move: nothing on
 * the way there reports it.
 * @param tr - The transaction.
 * @param target - The row the press aimed at.
 * @param want - Whether every block should be that row, or none of them.
 * @returns Whether the press arrived.
 */
function landedOn(tr: Transaction, target: BlockTypeId, want: boolean): boolean {
  const positions = selectedBlocks(tr);
  return positions.length > 0 && positions.every((pos) => isItemAt(tr.doc, pos, target) === want);
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
  const positions = selectedBlocks(tr);
  for (const pos of positions) {
    const $pos = tr.doc.resolve(pos);
    const depth = nearestDepth($pos, QUOTE_NAMES);
    if (depth === null) continue;
    const quoteStart = $pos.start(depth);
    // `pos` itself is one of these, so the run is never empty.
    const shared = positions.filter((other) => {
      const $other = tr.doc.resolve(other);
      return $other.depth >= depth && $other.start(depth) === quoteStart;
    });
    const last = shared[shared.length - 1] ?? pos;
    return new NodeRange(tr.doc.resolve(shared[0] ?? pos), tr.doc.resolve(last), depth);
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
  const tailDepth = itemListName($last) === null ? null : listDepthAt($last);
  if (tailDepth !== null && $last.index(tailDepth) + 1 < $last.node(tailDepth).childCount) {
    const at = $last.after(tailDepth + 1);
    if (canSplit(tr.doc, at, 1)) tr.split(at, 1);
  }

  const head = selectionEnds(tr);
  if (!head) return;
  const $first = tr.doc.resolve(head.first);
  const headDepth = itemListName($first) === null ? null : listDepthAt($first);
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
    // A document holds one level of quote (rule 5). Walking out far enough to
    // find a wrapping can reach a range that already holds a quote of its own
    // — a list item whose later block is quoted, say — and wrapping that would
    // stack one inside the other. The press refuses instead of taking a quote
    // off blocks nobody selected.
    if (holdsQuote(outer)) return false;
    const wrapping = findWrapping(outer, quote);
    if (wrapping) {
      tr.wrap(outer, wrapping);
      return true;
    }
  }
  return false;
}

/**
 * Does anything inside this range carry a quote?
 * @param range - The range about to be wrapped.
 * @returns Whether a blockquote sits inside it.
 */
function holdsQuote(range: NodeRange): boolean {
  let found = false;
  range.parent.forEach((child, offset) => {
    const start = range.$from.start(range.depth) + offset;
    if (found || start + child.nodeSize <= range.start || start >= range.end) return;
    if (QUOTE_NAMES.has(child.type.name)) { found = true; return; }
    child.descendants((node) => {
      if (found) return false;
      if (QUOTE_NAMES.has(node.type.name)) { found = true; return false; }
      return true;
    });
  });
  return found;
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
  const before = selectedBlocks(tr).length;
  if (before === 0) return false;
  tr.setBlockType(from, to, type, attrs ?? undefined);

  // `setBlockType` skips a block the schema will not let it change and says
  // nothing, so the result is read back off the document. Reporting success
  // on a selection where one block moved and another did not would put half a
  // press into the document (rule 4).
  const after = selectedBlocks(tr);
  if (after.length !== before) return false;
  return after.every((pos) => {
    const block = tr.doc.resolve(pos).parent;
    if (block.type !== type) return false;
    return Object.entries(attrs ?? {}).every(([key, value]) => block.attrs[key] === value);
  });
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
  for (const pos of selectedBlocks(tr)) {
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
    if (!marked && !wrapInQuote(tr)) return false;
    return landedOn(tr, 'quote', !marked);
  }

  const target: BlockTypeId = marked ? 'paragraph' : id;
  if (!applyExclusive(tr, schema, target)) return false;
  return landedOn(tr, target, true);
}

/**
 * Writes one exclusive row's target into the transaction.
 * @param tr - The transaction, written into.
 * @param schema - The document schema.
 * @param target - Which of the exclusive eight to become.
 * @returns Whether every step went in.
 */
function applyExclusive(tr: Transaction, schema: Schema, target: BlockTypeId): boolean {
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
 * Builds the press's transaction, leaving it undispatched.
 *
 * A node selection is turned into the text range covering the same blocks
 * first, so every shape reaches the same transition (A9).
 *
 * Rule 4, both halves. `applyTransition` reports whether every step went in,
 * which keeps half a press out of the document; `docChanged` answers the other
 * way round — a press the schema left nowhere to go writes no step at all.
 * @param editor - The editor.
 * @param id - Which row.
 * @returns The transaction where the press does something, null where it does not.
 */
function buildPress(editor: Editor, id: BlockTypeId): Transaction | null {
  const { state } = editor;
  // One reading of the selection answers both questions this needs.
  const at = selectedBlocks(state);
  const first = at[0];
  const last = at[at.length - 1];
  if (first === undefined || last === undefined) return null;

  const listNode = LIST_NODE[id];
  if (listNode !== undefined && state.schema.nodes[listNode] === undefined) return null;

  const marked = markedOver(state.doc, at, id);
  const tr = state.tr;
  if (!applyTransition(tr, state.schema, id, marked)) return null;
  if (!tr.docChanged) return null;

  // §6.2's second promise: the press does not change what the reader is
  // holding. A transaction maps its own selection, which covers a text range
  // and a select-all; a node selection is the one shape with nothing to map
  // onto, because every exclusive press replaces the node it sat on and
  // `Selection.near` then answers with a caret. An empty selection takes the
  // bubble bar off screen (`SelectionBubbleBar.tsx`'s `isWarranted`), so the
  // blocks the press acted on carry the selection instead.
  if (tr.selection.empty && !state.selection.empty) {
    const head = tr.mapping.map(first);
    const tail = tr.mapping.map(last);
    tr.setSelection(TextSelection.create(tr.doc, head, tr.doc.resolve(tail).end()));
  }
  return tr;
}

/**
 * Would pressing this row reach anything on this selection?
 *
 * The menu greys the rows this answers false for (§6.7). It builds the very
 * transaction the press would build and looks at whether one came out, so the
 * two answer off the same work — a dry run comparing some other property is how
 * the judgement went wrong before (#85).
 *
 * It answers about the transaction, which is as far as anything before the
 * dispatch can see. A plugin appending its own can still take the change back
 * afterwards: over a body whose blocks are all empty, tiptap's `clearDocument`
 * runs `clearNodes()` on the result (`@tiptap/core@3.29.2` `dist/index.js`
 * `clearDocument`), so every row is lit and every press leaves the document as
 * it was — #931 holds that one.
 * @param editor - The editor.
 * @param id - Which row.
 * @returns Whether the press would change the document.
 */
export function canRunBlockType(editor: Editor, id: BlockTypeId): boolean {
  // Text on blocks that are already Text asks for the state they are in, and
  // rule 2 makes that the only row where the target can equal the current
  // state: pressing a ticked row aims at Text, so target and current coincide
  // only for Text itself. The tick already says "you are here"; greying it as
  // well would be two marks for one fact.
  if (id === 'paragraph' && isMarked(editor, 'paragraph')) return true;
  return buildPress(editor, id) !== null;
}

/**
 * Runs the row's transition against the selection, as one transaction.
 * @param editor - The editor.
 * @param id - Which row.
 */
export function runBlockType(editor: Editor, id: BlockTypeId): void {
  const tr = buildPress(editor, id);
  if (tr) editor.view.dispatch(tr);
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
  const { doc } = editor.state;
  return selectedBlocks(editor.state).some((pos) => {
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
  const first = selectedBlocks(editor.state)[0];
  if (first === undefined) return 'paragraph';
  return blockTypeAt(doc, first) ?? 'paragraph';
}
