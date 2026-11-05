// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI output dialog takes from the body when it opens (inner#1860,
 * design §5.2, §5.4): the block a result is inserted under, and the context
 * Markdown sent with the selection, cut to the budget around it. The units
 * sent are `document-ai-units.ts`.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
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
