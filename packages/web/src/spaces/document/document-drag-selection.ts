// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reader's own place in the text, across a block drag.
 *
 * A drag off the handle is carried out through a node selection: the library
 * puts one on the row when the drag starts, and it is still there when the
 * drag ends (measured 2026-09-18 — dropped on another row, dropped back on its
 * own row, and let go over the space below the last row all left the row
 * wearing `ProseMirror-selectednode`, and with it the outline this Space draws
 * for a block the READER selected). What the reader sees is a violet frame
 * around a row nobody selected, standing there until they click somewhere
 * else.
 *
 * So the drag hands the reader's place back when it ends, which is the same
 * thing every other command off this strip already does — `runBlockType` puts
 * the selection back over the words it was over, so a press on a row the
 * pointer is over never moves the caret (A5).
 *
 * A POSITION CANNOT BE KEPT AS A NUMBER: the drop moves a whole block, so
 * every position after it shifts, and the transaction that does it is the
 * library's — there is no mapping of it to travel through. A block id and an
 * offset inside that block survive the move instead: the block keeps its id,
 * and moving it changes nothing about its own content.
 */

import { TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/** One end of the reader's selection, addressed so a move cannot shift it. */
interface Anchored {
  /** The block that end stands in. */
  readonly blockId: string;
  /** How far into that block's own content it stands. */
  readonly offset: number;
}

/** Where the reader was, for as long as the drag lasts. */
export interface ReaderPlace {
  /** Where the selection started. */
  readonly anchor: Anchored;
  /** Where it ended; the same as the anchor for a caret. */
  readonly head: Anchored;
}

/**
 * A caret at the very start of one block.
 *
 * What a drag hands back when the reader had no text selection of its own to
 * hand back — a gap cursor, say. Any text selection will do to take the
 * library's node selection off the row; the start of the row that just moved
 * is the place the reader is looking at.
 * @param blockId - The block to put the caret in.
 * @returns That place.
 */
export function caretAtStartOf(blockId: string): ReaderPlace {
  const end = { blockId, offset: 0 };
  return { anchor: end, head: end };
}

/**
 * The block a position stands in, and how far into it.
 * @param doc - The document the position is in.
 * @param pos - The position.
 * @returns The block and offset, or undefined when the position is not inside
 * a block that carries an id.
 */
function anchor(doc: PMNode, pos: number): Anchored | undefined {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const id: unknown = $pos.node(depth).attrs['id'];
    if (typeof id !== 'string') continue;
    // The content node opens one position inside the container, and the
    // offset is measured from there.
    return { blockId: id, offset: pos - ($pos.start(depth) + 1) };
  }
  return undefined;
}

/**
 * Where the reader's text selection is, if they have one.
 *
 * A node selection is not read: the only one that can be current when a drag
 * starts is the one the drag itself just made.
 * @param state - The editor's state.
 * @returns The place, or undefined when there is nothing to hand back.
 */
export function readerPlace(state: EditorState): ReaderPlace | undefined {
  if (!(state.selection instanceof TextSelection)) return undefined;
  const anchorEnd = anchor(state.doc, state.selection.anchor);
  const headEnd = anchor(state.doc, state.selection.head);
  if (anchorEnd === undefined || headEnd === undefined) return undefined;

  return { anchor: anchorEnd, head: headEnd };
}

/**
 * That end's position in the document as it is now.
 * @param doc - The document to look in.
 * @param end - The block and offset to find.
 * @returns The position, or undefined when that block is gone.
 */
function positionOf(doc: PMNode, end: Anchored): number | undefined {
  let found: number | undefined;
  doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.attrs['id'] !== end.blockId) return true;
    const content = node.firstChild;
    if (content === null) return false;
    // Clamped to the block: a co-editor can shorten it while the drag is on.
    const start = pos + 2;
    found = start + Math.min(end.offset, Math.max(content.content.size, 0));
    return false;
  });
  return found;
}

/**
 * Puts the reader back where they were.
 *
 * Does nothing when either end's block is gone — a co-editor can remove it
 * while the drag is on, and a selection guessed at from half a place would be
 * a place the reader never had.
 * @param view - The editor view to write to.
 * @param place - What {@link readerPlace} read.
 */
export function restoreReaderPlace(view: EditorView, place: ReaderPlace): void {
  const { doc } = view.state;
  const anchorPos = positionOf(doc, place.anchor);
  const headPos = positionOf(doc, place.head);
  if (anchorPos === undefined || headPos === undefined) return;

  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, anchorPos, headPos)));
}
