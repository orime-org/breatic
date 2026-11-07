// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI output dialog takes from the body when it opens (inner#1860,
 * design §4.6, §5.2, §5.4): the range it opens on (`aiCapture`), the block a
 * result is inserted under, and the context Markdown sent with the
 * selection, cut to the budget around it. What is sent for the range is
 * `aiRequest` in `document-ai-units.ts`.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { blockAround, inlineLetter, inOneCell, ownContentEnd, type AiCapture } from '@web/spaces/document/document-ai-range';
import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import { letterBounds } from '@web/spaces/document/document-local-range';


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
 * Where the first thing the selection covers starts: the first letter, or
 * the first block with no letters it takes in, past its start.
 * @param doc - The body.
 * @param from - The selection's start.
 * @param to - Its end.
 * @returns The position; `to` when the selection covers nothing.
 */
function firstCovered(doc: ProseMirrorNode, from: number, to: number): number {
  let first = to;
  doc.nodesBetween(from, to, (node, pos) => {
    if (first < to) return false;
    if ((node.isText || node.isAtom) && pos + node.nodeSize > from) {
      first = Math.max(pos, from);
      return false;
    }
    return true;
  });
  return first;
}

/**
 * The range the AI dialog opens on (§4.6), the way Plate's
 * `captureTextRange` takes it: a block the selection only ends at the start
 * of, or only starts at the end of, is left out; what is left inside one
 * line of words is the selected words, and anything else takes the whole
 * blocks it touches, a table it runs into whole. The insert block (§5.4) is
 * the range's last block: the whole table for a range that takes one in,
 * the block in the cell for words inside a single cell.
 * @param state - The editor state, holding the selection.
 * @returns The range, or null when it holds no words.
 */
export function aiCapture(state: EditorState): AiCapture | null {
  const { doc, selection } = state;
  if (selection.empty || selection instanceof CellSelection) return null;
  const { from, to } = selection;
  const firstAt = firstCovered(doc, from, to);
  if (firstAt >= to) return null;
  const $first = doc.resolve(firstAt);
  const $last = doc.resolve(lastCovered(doc, from, to));
  const oneCell = inOneCell($first, $last);
  const first = blockAround($first, oneCell);
  const last = blockAround($last, oneCell);
  if (first === null || last === null) return null;
  const lastId = String(doc.nodeAt(last)!.attrs['id']);
  // Inside one block is inside one line of words: a legacy table's cells
  // are lines of one block, and a selection across them takes the table.
  if (first === last && $first.sameParent($last)) {
    const letters = letterBounds(doc, { from, to }, inlineLetter);
    return letters === null ? null : { range: letters, firstId: null, lastId: null, insertId: lastId };
  }
  const range = { from: first, to: ownContentEnd(doc, last) };
  if (letterBounds(doc, range, inlineLetter) === null) return null;
  return { range, firstId: String(doc.nodeAt(first)!.attrs['id']), lastId, insertId: lastId };
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
