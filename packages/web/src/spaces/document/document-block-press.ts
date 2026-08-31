// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a block type row does to a selection, as one transaction.
 *
 * Rule 4 is why nothing here goes through tiptap's command layer: both
 * `chain().run()` and a single `editor.commands.*` dispatch the transaction
 * before reporting whether the steps worked (`@tiptap/core@3.29.2`
 * `dist/index.js:60-63` and `:82-87`), which would leave half a press in the
 * document. Everything below writes into one `Transaction` through transform
 * primitives, and `runBlockType` dispatches it once.
 *
 * The rows themselves, and what a block already counts as, live in
 * `document-block-model.ts`. This file only moves blocks.
 */

import type { Editor } from '@tiptap/core';
import { NodeRange, type NodeType, type Schema } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { canSplit, findWrapping, liftTarget } from '@tiptap/pm/transform';
import { wrapRangeInList } from '@tiptap/pm/schema-list';

import { unquoteSelection } from '@web/spaces/document/document-unquote';
import {
  HEADING_LEVEL,
  LIST_NODE,
  QUOTE_NAMES,
  isItemAt,
  itemListName,
  listDepthAt,
  markedIds,
  markedOver,
  nearestDepth,
  selectedBlocks,
  type BlockTypeId,
  type Resolved,
} from '@web/spaces/document/document-block-model';

/**
 * Where the press's blocks stand now.
 *
 * A press is given the blocks the reader selected, and every step it writes
 * moves them. The transaction maps its own steps, so the blocks are carried
 * across by that map. Reading them back off `tr.selection` instead answers for
 * whatever the selection has become: lifting the first item of a list deletes
 * the node a node selection sat on, and ProseMirror re-anchors it to a caret,
 * so the steps after that one see a single block where the reader had a list.
 * @param tr - The transaction.
 * @param blocks - Where the blocks stood when the press started.
 * @returns Where they stand now, in document order.
 */
function movedTo(tr: Transaction, blocks: number[]): number[] {
  return blocks.map((pos) => tr.mapping.map(pos));
}

/**
 * The first and last of the press's blocks.
 * @param tr - The transaction.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns Those two positions, or null where the selection holds no text block.
 */
function selectionEnds(tr: Transaction, blocks: number[]): { first: number; last: number } | null {
  const positions = movedTo(tr, blocks);
  const first = positions[0];
  const last = positions[positions.length - 1];
  return first === undefined || last === undefined ? null : { first, last };
}

/**
 * The node range covering the selection's text blocks.
 * @param tr - The transaction.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns That range, or null where the selection holds no text block.
 */
function selectedRange(tr: Transaction, blocks: number[]): NodeRange | null {
  const ends = selectionEnds(tr, blocks);
  if (!ends) return null;
  return tr.doc.resolve(ends.first).blockRange(tr.doc.resolve(ends.last));
}

/**
 * Takes the selection's list items out of their lists.
 *
 * ONE level per block, then stop (user 2026-08-30,
 * `demo/2026-08-30-nested-list-lift-decision.html`). An item of a nested list
 * lands in the item above as a plain paragraph, and an item of a top level
 * list lands in the body — one level takes it out either way.
 *
 * A block can be made an item again by the lift of another one: taking the
 * outer item of a nested list out leaves the inner one opening what is left,
 * so it carries the marker now. That block has still moved one level of its
 * own, and rule 2 wants every selected block to become the row that was
 * pressed, which a list item cannot be. The rounds run until no selected block
 * is an item, which for a block nothing else disturbs is one lift.
 *
 * Only blocks that ARE list items move: a later block of an item carries no
 * marker and is nothing the exclusive rows have to make way for. Where the
 * item held nothing else, the block below the lifted one becomes the item's
 * first and takes over its marker, which is the marker staying on the item it
 * has always been drawn beside.
 *
 * An item has to open with a paragraph, so an item holding a heading or a code
 * block below its first line cannot give that line up on its own — what would
 * be left opens with the heading. The whole item comes apart there and its
 * blocks land where the item stood, which leaves the reader the line they
 * pressed on plus whatever was riding along in the same item.
 * A block that cannot leave stays where it is and the press carries on with
 * the rest: the row acts on what it can reach.
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 */
function liftOutOfLists(tr: Transaction, blocks: number[]): void {
  for (;;) {
    let moved = false;
    for (const origin of blocks) {
      const $from = tr.doc.resolve(tr.mapping.map(origin));
      if (itemListName($from) === null) continue;
      const lift = itemLift($from);
      if (!lift) continue;
      tr.lift(lift.range, lift.target);
      moved = true;
    }
    if (!moved) break;
  }
}

/**
 * How this list item's first block leaves the list.
 *
 * The block alone where the item can still be one without it, the item's whole
 * content where it cannot.
 * @param $from - A resolved position inside the first block of a list item.
 * @returns The range to lift and where to lift it to, or null where neither
 *   range can move.
 */
function itemLift($from: Resolved): { range: NodeRange; target: number } | null {
  const itemDepth = $from.depth - 1;
  const alone = new NodeRange($from, $from, itemDepth);
  const aloneTarget = liftTarget(alone);
  if (aloneTarget !== null) return { range: alone, target: aloneTarget };

  const whole = new NodeRange(
    $from.doc.resolve($from.start(itemDepth)),
    $from.doc.resolve($from.end(itemDepth)),
    itemDepth,
  );
  const wholeTarget = liftTarget(whole);
  return wholeTarget === null ? null : { range: whole, target: wholeTarget };
}

/**
 * Did the press reach any of the blocks it was given?
 *
 * ONE is enough (user 2026-08-30). A row answers for what it can do to the
 * selection, and a block the schema will not let move is a block the row
 * leaves alone rather than a reason to call the whole press off. This is the
 * judgement `prosemirror-commands`' own `setBlockType` makes — `applicable`
 * there stops at the first block that can take the type — and `Transform`
 * skips the ones that cannot, one at a time, without failing.
 *
 * The blocks are the ones the press was given, carried across the steps by the
 * transaction's own mapping. Reading them off the selection instead answered
 * for whatever the selection had become: a node selection re-anchors onto a
 * single block once the node it sat on is gone, so a press that moved one item
 * of a list and left the rest read back as a press that arrived.
 * @param tr - The transaction.
 * @param at - Where the blocks stood before the press.
 * @param target - The row the press aimed at.
 * @param want - Whether a block should have become that row, or left it.
 * @returns Whether the press arrived.
 */
function landedOn(tr: Transaction, at: number[], target: BlockTypeId, want: boolean): boolean {
  return at.some((pos) => {
    const now = tr.mapping.map(pos);
    const $now = tr.doc.resolve(now);
    return $now.parent.isTextblock && isItemAt(tr.doc, now, target) === want;
  });
}

/**
 * The stretch of one quote's content the selection covers.
 *
 * Sits at the quote's own depth, so lifting it takes that quote off its
 * content rather than taking the text block out of whatever holds it innermost
 * — for a quoted list the innermost is the list, which the press has no
 * business touching.
 * @param tr - The transaction.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns That range, or null where no quote holds the selection.
 */
function innermostQuoteRange(tr: Transaction, blocks: number[]): NodeRange | null {
  const positions = movedTo(tr, blocks);
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
 * Lifts the selected blocks out of the quotes holding them.
 *
 * Serves the wrapping direction only: blocks on the two sides of a quote's edge
 * all have to be outside one before they can go into the same new quote (§5.1).
 * Taking a quote off on the reader's behalf is `document-unquote.ts`, which
 * rebuilds the whole quote rather than lifting a range out of it.
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 */
function liftOutOfQuotes(tr: Transaction, blocks: number[]): void {
  for (;;) {
    const range = innermostQuoteRange(tr, blocks);
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
 *
 * The split is worth anything only where the quote acts on the list or outside
 * it. Where the item can hold the quote beside its own paragraph the shell
 * never moves, and splitting it there cuts a list nobody touched into pieces
 * that renumber. `quoteAt` is the answer to which of the two this press is,
 * and it is read before the first write for that reason.
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @param quoteAt - The depth the quote will act at.
 */
function splitListAtSelectionEdges(
  tr: Transaction,
  blocks: number[],
  quoteAt: number | null,
): void {
  if (quoteAt === null) return;
  const tail = selectionEnds(tr, blocks);
  if (!tail) return;
  const $last = tr.doc.resolve(tail.last);
  const tailDepth = listDepthAt($last);
  if (tailDepth !== null && quoteAt <= tailDepth
    && $last.index(tailDepth) + 1 < $last.node(tailDepth).childCount) {
    const at = $last.after(tailDepth + 1);
    if (canSplit(tr.doc, at, 1)) tr.split(at, 1);
  }

  const head = selectionEnds(tr, blocks);
  if (!head) return;
  const $first = tr.doc.resolve(head.first);
  const headDepth = listDepthAt($first);
  if (headDepth !== null && quoteAt <= headDepth && $first.index(headDepth) > 0) {
    const at = $first.before(headDepth + 1);
    if (canSplit(tr.doc, at, 1)) tr.split(at, 1);
  }
}

/** Where a quote goes in, with the range and the wrapping found there. */
interface QuoteWrap {
  depth: number;
  outer: NodeRange;
  wrapping: NonNullable<ReturnType<typeof findWrapping>>;
}

/**
 * The outermost-but-first depth a quote can be put in around the selection.
 *
 * Walks outwards from the blocks and stops at the first depth the schema
 * accepts a quote in, carrying out the wrapping it found there.
 * @param tr - The transaction.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns That depth with the range and the wrapping, or null where no depth
 *   takes one.
 */
function wrapDepth(tr: Transaction, blocks: number[]): QuoteWrap | null {
  const quote = tr.doc.type.schema.nodes.blockquote;
  const range = quote === undefined ? null : selectedRange(tr, blocks);
  if (!quote || !range) return null;
  for (let depth = range.depth; depth >= 0; depth -= 1) {
    const outer = new NodeRange(range.$from, range.$to, depth);
    const wrapping = findWrapping(outer, quote);
    if (wrapping) return { depth, outer, wrapping };
  }
  return null;
}

/**
 * Wraps the selection in a quote.
 *
 * A document holds one level of quote (rule 5). Walking out far enough to find
 * a wrapping can reach a range that already holds a quote of its own — a list
 * item whose later block is quoted, say — and wrapping that would stack one
 * inside the other. The press refuses instead of taking a quote off blocks
 * nobody selected. Upstream answers the same way from a different direction:
 * `toggleBlockquote` only tries the selection's own `blockRange`, where the
 * schema takes no quote at all, so `can()` there is false on these shapes too
 * (`@tiptap/extension-blockquote@3.29.2`, measured 2026-08-31).
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns Whether the wrapping went in.
 */
function wrapInQuote(tr: Transaction, blocks: number[]): boolean {
  const found = wrapDepth(tr, blocks);
  if (!found || holdsQuote(found.outer)) return false;
  tr.wrap(found.outer, found.wrapping);
  return true;
}

/**
 * Does anything inside this range carry a quote?
 * @param range - The range about to be wrapped.
 * @returns Whether a blockquote sits inside it.
 */
function holdsQuote(range: NodeRange): boolean {
  // A NodeRange always covers whole children of its parent and names them,
  // so the children it covers are read off those indices.
  for (let i = range.startIndex; i < range.endIndex; i += 1) {
    const child = range.parent.child(i);
    if (QUOTE_NAMES.has(child.type.name)) return true;
    let nested = false;
    child.descendants((node) => {
      if (nested) return false;
      if (QUOTE_NAMES.has(node.type.name)) nested = true;
      return !nested;
    });
    if (nested) return true;
  }
  return false;
}

/**
 * Sets every text block in the selection to this type.
 *
 * `setBlockType` skips a block the schema will not let it change and says
 * nothing about it, which is the behaviour rule 2 wants: the row acts on what
 * it can reach. Whether anything arrived is read off the document at the end
 * of the press by `landedOn`, so the steps here report nothing of their own.
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @param type - The target node type.
 * @param attrs - Attributes for it.
 */
function setBlocks(
  tr: Transaction,
  blocks: number[],
  type: NodeType,
  attrs: Record<string, unknown> | null,
): void {
  for (const origin of blocks) {
    const pos = tr.mapping.map(origin);
    tr.setBlockType(pos, pos, type, attrs ?? undefined);
  }
}

/**
 * Turns the selection into blocks of one type, list wrappers giving way.
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @param type - The target node type.
 * @param attrs - Attributes for it.
 */
function toBlockType(
  tr: Transaction,
  blocks: number[],
  type: NodeType,
  attrs: Record<string, unknown> | null,
): void {
  liftOutOfLists(tr, blocks);
  setBlocks(tr, blocks, type, attrs);
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
 * @param blocks - Where the press's blocks stood when it started.
 * @returns Each run's first and last position, in document order.
 */
function selectedRuns(tr: Transaction, blocks: number[]): Array<[first: number, last: number]> {
  const runs: Array<[number, number]> = [];
  let parent: number | null = null;
  let previous = -2;
  for (const pos of movedTo(tr, blocks)) {
    const $pos = tr.doc.resolve(pos);
    const depth = $pos.depth - 1;
    // `start(depth)` is an absolute content-start position, so no two nodes
    // share one and it names the parent on its own.
    const here = $pos.start(depth);
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
 * @param blocks - Where the press's blocks stood when it started.
 * @param listType - The list node type.
 */
function toList(tr: Transaction, blocks: number[], listType: NodeType): void {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!paragraph) return;
  liftOutOfLists(tr, blocks);
  setBlocks(tr, blocks, paragraph, null);

  const runs = selectedRuns(tr, blocks);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const [first, last] = runs[i] as [number, number];
    const range = tr.doc.resolve(first).blockRange(tr.doc.resolve(last));
    // A run the schema will not take a list on keeps the paragraph it was just
    // made into: rule 2 says the row acts on what it can reach, and half of
    // this row's reach — becoming a plain block — is already done by here. The
    // run is not left as it was found.
    if (range) wrapRangeInList(tr, range, listType);
  }
}

/**
 * Writes one row's transition into the transaction.
 * @param tr - The transaction, written into.
 * @param schema - The document schema.
 * @param id - Which row.
 * @param marked - Whether the row is already ticked.
 * @param at - Where the selection's blocks stood before the press.
 * @returns Whether the press reached a block.
 */
function applyTransition(
  tr: Transaction,
  schema: Schema,
  id: BlockTypeId,
  marked: boolean,
  at: number[],
): boolean {
  if (id === 'quote') {
    // Taking quotes off rebuilds every quote the selection reaches in one pass,
    // so it answers for the whole selection at once and places the selection
    // itself (`document-unquote.ts`).
    if (marked) return unquoteSelection(tr, at);
    // Putting one on splits the list at the selection's edges, which leaves the
    // selected items in a list of their own for the wrapping to take, and lifts
    // the blocks out of any quote already holding some of them so all of them
    // go into the one new quote (§5.1).
    splitListAtSelectionEdges(tr, at, wrapDepth(tr, at)?.depth ?? null);
    liftOutOfQuotes(tr, at);
    if (!wrapInQuote(tr, at)) return false;
    return landedOn(tr, at, 'quote', true);
  }

  const target: BlockTypeId = marked ? 'paragraph' : id;
  applyExclusive(tr, at, schema, target);
  return landedOn(tr, at, target, true);
}

/**
 * Writes one exclusive row's target into the transaction.
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @param schema - The document schema.
 * @param target - Which of the exclusive eight to become.
 */
function applyExclusive(
  tr: Transaction,
  blocks: number[],
  schema: Schema,
  target: BlockTypeId,
): void {
  const listNode = LIST_NODE[target];
  if (listNode !== undefined) {
    const listType = schema.nodes[listNode];
    if (listType) toList(tr, blocks, listType);
    return;
  }
  if (target === 'code-block') {
    const type = schema.nodes.codeBlock;
    if (type) toBlockType(tr, blocks, type, null);
    return;
  }
  const level = HEADING_LEVEL[target];
  if (level !== undefined) {
    const type = schema.nodes.heading;
    if (type) toBlockType(tr, blocks, type, { level });
    return;
  }
  const type = schema.nodes.paragraph;
  if (type) toBlockType(tr, blocks, type, null);
}

/**
 * Builds the press's transaction, leaving it undispatched.
 *
 * Rule 4, both halves. `applyTransition` reads the document at the end of the
 * press to say whether it reached a block; `docChanged` answers the other way
 * round — a press the schema left nowhere to go writes no step at all.
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

  const marked = markedOver(state.doc, at, id);
  const tr = state.tr;
  if (!applyTransition(tr, state.schema, id, marked, at)) return null;
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
  if (id === 'paragraph' && markedIds(editor).has('paragraph')) return true;
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
