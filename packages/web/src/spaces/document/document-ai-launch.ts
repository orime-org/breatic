// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI output dialog takes from the body when it opens (inner#1860,
 * design §5.2, §5.4): the block a result is inserted under, and the context
 * Markdown sent with the selection, cut to the budget around it.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import { aimAt, type LocalRange } from '@web/spaces/document/document-local-range';
import { cellDepthOf, tableAround } from '@web/spaces/document/document-table-nodes';

/** What a block is told apart by in the body. */
const BLOCK_GROUP = 'bnBlock';

/** The blank line Markdown puts between two blocks. */
const BETWEEN_BLOCKS = '\n\n';

/**
 * Where the last thing the selection covers starts: the last letter, or the
 * last block with no letters (an image, a video) it takes in.
 *
 * Not `to - 1`: a selection made with Shift+Down from the start of a
 * paragraph ends at offset 0 of the next block, and the position before that
 * lies inside the next block's container, not in the block selected.
 * @param doc - The body.
 * @param from - The selection's start.
 * @param to - Its end.
 * @returns The position; `from` when the selection covers nothing.
 */
function lastCovered(doc: ProseMirrorNode, from: number, to: number): number {
  let last = from;
  doc.nodesBetween(from, to, (node, pos) => {
    if ((node.isText || node.isAtom) && pos < to) last = Math.max(pos, from);
    return true;
  });
  return last;
}

/**
 * The block a result is inserted under (§5.4): the one the selection ends in.
 * A selection running into a table from outside it, or from one cell into
 * another, acts on the whole table (inner#1619 T14), so the table is the
 * block; one inside a single cell keeps the block in that cell.
 * @param state - The editor state, holding the selection.
 * @returns The block's id, or null when the selection is in no block.
 */
export function aiInsertBlockId(state: EditorState): string | null {
  const { doc, selection } = state;
  const $last = doc.resolve(lastCovered(doc, selection.from, selection.to));
  const table = tableAround($last);
  if (table !== null) {
    const $from = doc.resolve(selection.from);
    const fromCell = cellDepthOf($from);
    const lastCell = cellDepthOf($last);
    const oneCell = fromCell > 0 && lastCell > 0 && $from.before(fromCell) === $last.before(lastCell);
    if (!oneCell) return String(table.node.attrs['id']);
  }
  for (let depth = $last.depth; depth > 0; depth -= 1) {
    const node = $last.node(depth);
    if (node.type.isInGroup(BLOCK_GROUP)) return String(node.attrs['id']);
  }
  // A position between blocks: the block right after it.
  const after = $last.nodeAfter;
  return after !== null && after.type.isInGroup(BLOCK_GROUP) ? String(after.attrs['id']) : null;
}

/**
 * The blocks with no words a selection takes in at its edges, by id in
 * document order: an image, a video, an empty line before its first letter or
 * after its last. The original range follows letters, the request carries the
 * whole selection, and a replace takes these away too, so what was sent is
 * what is written over (`packages/web/AGENTS.md` "Selection is the range").
 */
export interface AiEdgeBlocks {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** One block: its id, its container's extent and its own content's. */
interface PlacedBlock {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  /** Whether no letter is anywhere in it, its child blocks included. */
  readonly wordless: boolean;
}

/**
 * Every block in document order. Their own contents never overlap: a block's
 * children sit beside its content, not inside it.
 * @param doc - The body.
 * @returns The blocks.
 */
function placedBlocks(doc: ProseMirrorNode): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  doc.descendants((node, pos) => {
    const content = node.firstChild;
    if (node.type.isInGroup(BLOCK_GROUP) && content !== null) {
      blocks.push({
        id: String(node.attrs['id']),
        from: pos,
        to: pos + node.nodeSize,
        contentFrom: pos + 1,
        contentTo: pos + 1 + content.nodeSize,
        wordless: node.textContent === '',
      });
    }
    return true;
  });
  return blocks;
}

/**
 * The block whose own content holds a position.
 * @param blocks - Every block, in document order.
 * @param pos - The position.
 * @returns Its index, or -1 when no block's content holds it.
 */
function blockHolding(blocks: readonly PlacedBlock[], pos: number): number {
  return blocks.findIndex((b) => b.contentFrom <= pos && pos <= b.contentTo);
}

/**
 * The blocks with no words at the selection's edges: those whose whole
 * container, child blocks included, lies between an end of the selection and
 * its nearest letter. A block one of whose children holds the selected words,
 * or words left out of the selection, is not one of them.
 * @param state - The editor state, holding the selection.
 * @returns Them, before its first letter and after its last.
 */
export function aiEdgeBlocks(state: EditorState): AiEdgeBlocks {
  const { doc, selection } = state;
  const letters = aimAt(doc, selection.ranges.map((range) => ({ from: range.$from.pos, to: range.$to.pos })));
  if (letters.length === 0) return { before: [], after: [] };
  const first = letters[0]!.from;
  const last = letters[letters.length - 1]!.to;
  const blocks = placedBlocks(doc);
  return {
    before: blocks.filter((b) => b.from >= selection.from && b.to <= first).map((b) => b.id),
    after: blocks.filter((b) => b.from >= last && b.to <= selection.to).map((b) => b.id),
  };
}

/**
 * The blocks with no words from the selection's edges that a replace takes
 * away with the words: those still right against the original range and still
 * without words. One the reader has since put something in front of, or
 * written in, stays. A block inside another one taken away goes with it, so it
 * is not named again.
 * @param doc - The body now.
 * @param letters - The original range, first letter to past the last.
 * @param edges - The blocks with no words at the selection's edges.
 * @returns Their ids.
 */
export function aiEdgeBlocksBeside(doc: ProseMirrorNode, letters: LocalRange, edges: AiEdgeBlocks): string[] {
  const blocks = placedBlocks(doc);
  const beside: PlacedBlock[] = [];
  /**
   * Whether a block is the next edge block still to be found.
   * @param at - The block's index.
   * @param id - The edge block's id.
   * @returns True when it is that block and still has no words.
   */
  const matches = (at: number, id: string | undefined): boolean => blocks[at]!.id === id && blocks[at]!.wordless;
  // Document order puts the blocks the words sit inside just before them;
  // those are not beside the words, so the walk back starts past them.
  let start = blockHolding(blocks, letters.from) - 1;
  while (start >= 0 && blocks[start]!.to > letters.from) start -= 1;
  for (let at = start, k = edges.before.length - 1; at >= 0 && k >= 0 && matches(at, edges.before[k]); at -= 1, k -= 1) {
    beside.push(blocks[at]!);
  }
  for (let at = blockHolding(blocks, letters.to) + 1, k = 0; at < blocks.length && k < edges.after.length && matches(at, edges.after[k]); at += 1, k += 1) {
    beside.push(blocks[at]!);
  }
  return beside
    .filter((b) => !beside.some((outer) => outer !== b && outer.from <= b.from && b.to <= outer.to))
    .map((b) => b.id);
}

/** One top-level block of the context: its Markdown and its place in the body. */
interface ContextBlock {
  readonly markdown: string;
  readonly index: number;
}

/**
 * A stretch of text cut to a budget, centred on some words in it.
 * @param text - The text.
 * @param budget - The most it may hold.
 * @param centre - Where the words' middle is, in the text.
 * @returns The stretch.
 */
function clipAround(text: string, budget: number, centre: number): string {
  if (text.length <= budget) return text;
  const start = Math.min(Math.max(0, Math.round(centre - budget / 2)), text.length - budget);
  return text.slice(start, start + budget);
}

/**
 * The context sent with the selection (§5.2): the whole document as
 * Markdown when it fits the budget; otherwise the top-level blocks the
 * selection is in, widened a block at a time on either side while the next
 * block still fits; and when those blocks alone are over the budget, their
 * Markdown cut to the budget around the selection, the way the Agent's space
 * context cuts inside a block.
 * @param editor - The document editor.
 * @param budget - The most characters the context may hold.
 * @returns The context Markdown.
 */
export function aiContextOf(editor: BlockNoteEditor<never, never, never>, budget: number): string {
  const { doc, selection } = editor.prosemirrorState;
  const order = new Map<string, number>();
  doc.firstChild?.forEach((node, _offset, index) => order.set(String(node.attrs['id']), index));
  const blocks: ContextBlock[] = readTopBlocks(editor).map((block) => ({
    markdown: block.markdown.trim(),
    index: order.get(block.id) ?? -1,
  }));
  const whole = blocks.map((block) => block.markdown).join(BETWEEN_BLOCKS);
  if (whole.length <= budget) return whole;

  const first = doc.resolve(selection.from).index(1);
  const last = doc.resolve(lastCovered(doc, selection.from, selection.to)).index(1);
  let lo = blocks.findIndex((block) => block.index >= first);
  if (lo < 0) lo = blocks.length;
  let hi = lo - 1;
  while (hi + 1 < blocks.length && blocks[hi + 1]!.index <= last) hi += 1;
  const core = blocks.slice(lo, hi + 1).map((block) => block.markdown).join(BETWEEN_BLOCKS);

  if (core.length > budget) {
    const words = doc.textBetween(selection.from, selection.to, '\n', '\n');
    const found = core.indexOf(words.split('\n')[0] ?? '');
    // Markdown can spell the words differently from their text (a mark, an
    // escape); then where they sit is told by how far into the blocks they are.
    const firstPos = positionOf(doc, first);
    const lastEnd = positionOf(doc, last + 1);
    const ratio = lastEnd > firstPos ? (selection.from - firstPos) / (lastEnd - firstPos) : 0;
    const start = found >= 0 ? found : Math.round(ratio * core.length);
    return clipAround(core, budget, start + Math.min(words.length, budget) / 2);
  }

  let used = core.length;
  let count = hi - lo + 1;
  for (;;) {
    let grew = false;
    for (const side of [-1, 1] as const) {
      const next = side < 0 ? lo - 1 : hi + 1;
      const block = blocks[next];
      if (block === undefined) continue;
      const cost = block.markdown.length + (count > 0 ? BETWEEN_BLOCKS.length : 0);
      if (used + cost > budget) continue;
      used += cost;
      count += 1;
      if (side < 0) lo = next;
      else hi = next;
      grew = true;
    }
    if (!grew) break;
  }
  return blocks.slice(lo, hi + 1).map((block) => block.markdown).join(BETWEEN_BLOCKS);
}

/**
 * Where a top-level block starts in the body.
 * @param doc - The body.
 * @param index - The block's index among the top-level blocks; one past the
 *   last gives the end of the last.
 * @returns The position before it.
 */
function positionOf(doc: ProseMirrorNode, index: number): number {
  const group = doc.firstChild;
  if (group === null) return 0;
  let pos = 1;
  for (let i = 0; i < Math.min(index, group.childCount); i += 1) pos += group.child(i).nodeSize;
  return pos;
}
