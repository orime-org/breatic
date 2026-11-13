// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the AI output dialog takes from the body when it opens (inner#1860,
 * design §4.6, §5.2, §5.4): the range it opens on (`aiCapture`), the block a
 * result is inserted under, and the context Markdown sent with the
 * selection, cut to the budget around it. What is sent for the range is
 * `aiRequest` in `document-ai-text.ts`.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { blockAround, containerAt, inlineLetter, inOneCell, ownContentEnd, type AiCapture } from '@web/spaces/document/document-ai-range';
import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import { letterBounds } from '@web/spaces/document/document-local-range';
import { heldTables } from '@web/spaces/document/document-table-leave-selection';
import { tableAround } from '@web/spaces/document/document-table-nodes';


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

/** A block container of the body, with or without words, and where it starts. */
interface BlockAt {
  readonly pos: number;
  readonly node: ProseMirrorNode;
}

/**
 * The body's blocks in reading order, as Plate counts them: the containers,
 * the blocks inside table cells included; a table, its rows and its cells
 * are not blocks of their own.
 * @param doc - The body.
 * @returns The blocks.
 */
function blocksInOrder(doc: ProseMirrorNode): BlockAt[] {
  const out: BlockAt[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') out.push({ pos, node });
    return true;
  });
  return out;
}

/**
 * Where a block's words start and end: its first line's start and its last
 * line's end, or its own content's edges for a block without lines.
 * @param doc - The body.
 * @param block - The block.
 * @returns The two positions.
 */
function wordEdges(doc: ProseMirrorNode, block: BlockAt): { start: number; end: number } {
  const own = ownContentEnd(doc, block.pos);
  let start = -1;
  let end = -1;
  doc.nodesBetween(block.pos, own, (node, pos) => {
    if (!node.isTextblock) return true;
    if (start < 0) start = pos + 1;
    end = pos + 1 + node.content.size;
    return false;
  });
  return start < 0 ? { start: block.pos, end: own } : { start, end };
}

/**
 * The range the AI dialog opens on (§4.6), Plate's `captureTextRange`: an
 * end at the start of a block other than the start's steps back one block
 * in reading order, and a start at the end of a block other than the end's
 * steps on one; what is then inside one line of words is the selected
 * words, and anything else takes the whole blocks it runs from and to, a
 * table it runs into whole. An end outside any line (select-all, a block
 * selected) takes the blocks the selection holds. The insert block (§5.4)
 * is the range's last block: the whole table for a range that takes one in,
 * the block in the cell for words inside a single cell.
 * @param state - The editor state, holding the selection.
 * @returns The range, or null when it holds no words.
 */
export function aiCapture(state: EditorState): AiCapture | null {
  const { doc, selection } = state;
  if (selection.empty || selection instanceof CellSelection) return null;
  const order = blocksInOrder(doc);
  /**
   * Where a block stands in reading order.
   * @param pos - Where it starts.
   * @returns Its index.
   */
  const at = (pos: number): number => order.findIndex((block) => block.pos === pos);
  const $from = doc.resolve(selection.from);
  const $to = doc.resolve(selection.to);
  let first = $from.parent.isTextblock ? at(containerAt(doc, selection.from)!) : order.findIndex((block) => ownContentEnd(doc, block.pos) > selection.from);
  let last = $to.parent.isTextblock ? at(containerAt(doc, selection.to)!) : order.findLastIndex((block) => block.pos < selection.to);
  if (first < 0 || last < first) return null;
  let from = selection.from;
  let to = selection.to;
  if (first !== last && $to.parent.isTextblock && to === wordEdges(doc, order[last]!).start) {
    last -= 1;
    to = wordEdges(doc, order[last]!).end;
  }
  if (first !== last && $from.parent.isTextblock && from === wordEdges(doc, order[first]!).end) {
    first += 1;
    from = wordEdges(doc, order[first]!).start;
  }
  const $first = doc.resolve(order[first]!.pos + 1);
  const $last = doc.resolve(order[last]!.pos + 1);
  // A table the editor shows taken whole (`heldTables`) is whole here too,
  // even when a step lands both ends in one of its cells.
  const oneCell = inOneCell($first, $last) && heldTables(selection) === null;
  const firstBlock = blockAround($first, oneCell)!;
  const lastBlock = blockAround($last, oneCell)!;
  const lastId = String(doc.nodeAt(lastBlock)!.attrs['id']);
  // Inside one block is inside one line of words: a legacy table's cells
  // are lines of one block, and a selection across them takes the table.
  const $start = doc.resolve(from);
  if (first === last && $start.parent.isTextblock && $start.sameParent(doc.resolve(to)) && (oneCell || tableAround($start) === null)) {
    const letters = letterBounds(doc, { from, to }, inlineLetter);
    return letters === null ? null : { range: letters, firstId: null, lastId: null, insertId: lastId };
  }
  const range = { from: firstBlock, to: ownContentEnd(doc, lastBlock) };
  if (letterBounds(doc, range, inlineLetter) === null) return null;
  return { range, firstId: String(doc.nodeAt(firstBlock)!.attrs['id']), lastId, insertId: lastId };
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
  // Only the Markdown is read here, never `lossy`.
  const blocks: ContextBlock[] = readTopBlocks(editor, new Set()).map((block) => ({
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
