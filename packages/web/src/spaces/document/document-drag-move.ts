// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a dragged row lands, and what gets written there (A11, design §8).
 *
 * BlockNote carries a block drag through the clipboard: `dragStart` serialises
 * the row into three `dataTransfer` formats and never sets `view.dragging`
 * (`SideMenu/dragging.ts`, grep for `.dragging` finds nothing). ProseMirror
 * therefore falls back to parsing that payload at drop time
 * (`prosemirror-view/src/input.ts:790`), so the row written at the landing is
 * the row as it stood when the pointer went down.
 *
 * Measured 2026-09-18 with two pages on one Space: a word the other reader
 * typed INTO the dragged row during the flight was gone on both ends after the
 * drop, while a word typed into any other row survived and the row itself
 * moved correctly. The three runs are in design §8.
 *
 * So the landing is ours. The only thing carried across the flight is the
 * row's ID — the one thing that cannot go stale — and everything else is read
 * out of the document at the moment of the drop.
 *
 * WHERE THIS SITS. `handleDrop` is asked before ProseMirror's own drop
 * handling (`input.ts:796`), and returning true stops it, so the clipboard
 * payload is never parsed. The landing position is computed the same way
 * ProseMirror computes it, so where a row lands does not change.
 */

import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';

/** A row as the document holds it right now. */
export interface RowInDocument {
  /** The `blockContainer` node, nested blocks and all. */
  readonly node: PMNode;
  /** Where it starts. */
  readonly from: number;
  /** Where it ends. */
  readonly to: number;
}

/**
 * The block container carrying that id, as the document holds it now.
 *
 * The CONTAINER rather than its content: `BlockContainer.ts:27` is
 * `blockContent blockGroup?`, so the container is what holds the row's own
 * words together with anything indented under it, and a move takes both.
 * @param doc - The document to look in.
 * @param blockId - Which row.
 * @returns The row, or undefined when the document no longer holds it.
 */
export function rowById(
  doc: PMNode,
  blockId: string,
): RowInDocument | undefined {
  let found: RowInDocument | undefined;
  doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.attrs.id !== blockId) return true;
    found = { node, from: pos, to: pos + node.nodeSize };
    return false;
  });
  return found;
}

/**
 * Where a row would land for a drop at the given document position.
 *
 * `dropPoint` is what ProseMirror uses for the same question
 * (`input.ts:802`): it walks outwards from the position until the slice fits,
 * which is what turns a position inside a paragraph into the gap between two
 * blocks.
 * @param doc - The document to land in.
 * @param at - The position the pointer is over.
 * @param node - The row being carried.
 * @returns The landing position.
 */
export function landingFor(doc: PMNode, at: number, node: PMNode): number {
  const carried = new Slice(Fragment.from(node), 0, 0);
  return dropPoint(doc, at, carried) ?? at;
}

/**
 * Moves the row to where the drop happened, reading it from the document.
 *
 * One transaction, so the row is never absent from the document and the two
 * halves cannot be undone separately. The landing is mapped through the
 * deletion, which is what makes a landing BELOW the row come out right.
 *
 * Dropping a row onto itself maps the landing back to where the row was, so
 * the transaction puts it back where it started.
 * @param view - The view to write to.
 * @param blockId - The row that was dragged.
 * @param at - The document position the pointer was over at the drop.
 * @returns True when the move was written.
 */
export function moveRowTo(
  view: EditorView,
  blockId: string,
  at: number,
): boolean {
  const row = rowById(view.state.doc, blockId);
  if (row === undefined) return false;

  const landing = landingFor(view.state.doc, at, row.node);
  const tr = view.state.tr;
  tr.delete(row.from, row.to);
  tr.insert(tr.mapping.map(landing), row.node);
  view.dispatch(tr);
  return true;
}
