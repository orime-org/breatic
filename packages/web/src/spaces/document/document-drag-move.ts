// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a dragged row lands, and what gets written there (A11, design §8).
 *
 * BlockNote carries a block drag through the clipboard: `dragStart` serialises
 * the row into three `dataTransfer` formats (`SideMenu/dragging.ts`), and a
 * `dragstart` listener on the editor's root then parses the `blocknote/html`
 * one back into nodes and hands them to ProseMirror as `view.dragging`
 * (`SideMenu.ts:295-318`; `:596` clears it again at `dragend`). So the slice
 * ProseMirror would write at the landing is fixed at the moment the pointer
 * goes down, and a drop reads it rather than the document
 * (`prosemirror-view/src/input.ts:788-790`).
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
import type { Command } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';

import {
  BODY_OPERATION_META,
  BodyOriginMirror,
  BodyProvenanceError,
  bodyInlineOccurrences,
  recordBodyOperation,
} from '@web/spaces/document/document-body-provenance';
import {
  rowById,
  type RowInDocument,
} from '@web/spaces/document/document-row-by-id';
import { cellDepthOf, DOC_TABLE, isTableCell } from '@web/spaces/document/document-table-nodes';

/**
 * Whether a carried block is a table or contains one in its children.
 * @param node - The carried block.
 * @returns True when moving it would move a table too.
 */
function carriesTable(node: PMNode): boolean {
  if (node.type.name === DOC_TABLE) return true;
  let found = false;
  node.descendants((child) => {
    if (child.type.name === DOC_TABLE) found = true;
    return !found;
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
 * What has to come out of the document for the row to leave.
 *
 * Usually the row itself. When the row is the only child of a NESTED
 * `blockGroup`, that group has to go with it: `BlockGroup.ts:11` is
 * `blockGroupChild+`, so a group left with no children is refilled by the
 * schema with an empty paragraph, and the reader would watch a blank row
 * appear under the block they dragged out of. The document's own top-level
 * group is exempt — `BlockContainer.ts` puts it at depth 1 and the document
 * requires it, so it stays and the insert below is what keeps it occupied. A
 * table cell is exempt too: it is a place in its table, and the refill is
 * the empty paragraph a cell a block left holds.
 * @param doc - The document the row sits in.
 * @param row - The row about to leave.
 * @returns The range to remove.
 */
export function rangeToLift(
  doc: PMNode,
  row: RowInDocument,
): { from: number; to: number } {
  const $row = doc.resolve(row.from);
  // A table cell keeps its place: the schema refills it with an empty
  // paragraph once its only block leaves (inner#1619 T6).
  if ($row.parent.childCount > 1 || $row.depth <= 1 || isTableCell($row.parent)) {
    return { from: row.from, to: row.to };
  }
  return { from: $row.before($row.depth), to: $row.after($row.depth) };
}

/**
 * Runs the existing row removal and insertion against each state's live nodes.
 * The private state carries occurrence tags through the installed fitter.
 * @param blockId - The explicitly dragged row.
 * @param at - The actual pointer position before source removal.
 * @returns The same product move for the real and private schemas.
 * @throws {RangeError} If ProseMirror rejects the source range or insertion.
 */
function rowMoveCommand(blockId: string, at: number): Command {
  return (state, dispatch) => {
    const row = rowById(state.doc, blockId);
    if (row === undefined) return false;
    const landing = landingFor(state.doc, at, row.node);
    const leaving = rangeToLift(state.doc, row);
    const tr = state.tr;
    tr.delete(leaving.from, leaving.to);
    tr.insert(tr.mapping.map(landing), row.node);
    dispatch?.(tr);
    return true;
  };
}

/**
 * Moves the row to where the drop happened, reading it from the document.
 *
 * One transaction, so the row is never absent from the document and the two
 * halves cannot be undone separately. The landing is mapped through the
 * removal, which is what makes a landing BELOW the row come out right.
 *
 * A LANDING INSIDE THE ROW IS THE ROW STAYING PUT, and nothing is written.
 * `dropPoint` answers with a gap, and the gaps at and inside the dragged row's
 * own range are the places it already is. Writing the move anyway would empty
 * the only group a one-row document has — which is what a fresh Space is — and
 * `blockGroupChild+` refills an emptied group with a paragraph, so the reader
 * would get a second, blank row out of putting a row back where it was
 * (measured 2026-09-18: one row before, two after).
 * @param view - The view to write to.
 * @param blockId - The row that was dragged.
 * @param at - The document position the pointer was over at the drop.
 * @throws {BodyProvenanceError} If the private fitter differs or changes inline content.
 * @throws {RangeError} If ProseMirror rejects the source range or insertion.
 */
export function moveRowTo(view: EditorView, blockId: string, at: number): void {
  const row = rowById(view.state.doc, blockId);
  if (row === undefined) return;

  const landing = landingFor(view.state.doc, at, row.node);
  if (landing >= row.from && landing <= row.to) return;
  if (cellDepthOf(view.state.doc.resolve(landing)) > 0 && carriesTable(row.node)) return;

  const sourceAt = new Map(bodyInlineOccurrences(view.state.doc).map((unit) => [unit.pos, `row-source:${unit.pos}`]));
  const mirror = new BodyOriginMirror(view.state.tr, { sourceAt });
  const operation = mirror.nativeMove('whole row drop', row.from, row.to, view.state.selection, rowMoveCommand(blockId, at));
  if (operation.created.length > 0 || (operation.dropped?.length ?? 0) > 0) {
    throw new BodyProvenanceError('A whole row drop changed its inline content');
  }
  const transaction = mirror.tr.setMeta(BODY_OPERATION_META, []);
  recordBodyOperation(transaction, {
    id: operation.id,
    name: operation.name,
    source: operation.source,
    target: operation.target,
    handoffs: operation.handoffs.map((handoff) => ({ kind: handoff.kind, source: handoff.source, target: handoff.target })),
    created: [],
  });
  view.dispatch(transaction);
}
