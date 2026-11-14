// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Shift-Mod-ArrowUp and Shift-Mod-ArrowDown: move the selected rows one place.
 *
 * BlockNote binds both keys to `moveBlocksUp` / `moveBlocksDown`
 * (`KeyboardShortcutsExtension.ts:1039-1046`), which take the rows out and put
 * them back through `removeAndInsertBlocks` and `insertBlocks` — that is,
 * through the rows' JSON (`moveBlocks.ts`). A comment is a mark with no place
 * in that JSON, so every comment on a moved row lost its highlight and its
 * thread lost its words (#18).
 *
 * Here the rows are moved as the nodes the document holds, the way a dragged
 * row is (`document-drag-move.ts`): each one is taken out where it is, an
 * emptied nested group going with it, and all of them go back in, in order,
 * at the one place BlockNote would have put them. Where that place is is
 * BlockNote's rule, read through the same editor calls it makes
 * (`getMoveUpPlacement` / `getMoveDownPlacement`): past a sibling with no
 * rows under it; to the end or start of the rows under a sibling that has
 * some; out of the row above when there is no sibling that way. Its own
 * column check names BlockNote's column type; ours is `docColumn`, stopped
 * here with the cells.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type Selection,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  BodyEdgeSelection,
  bodyEdgeBetween,
  textOrEdge,
} from '@web/spaces/document/document-body-edge-selection';
import { rangeToLift } from '@web/spaces/document/document-drag-move';
import { rowById } from '@web/spaces/document/document-row-by-id';
import {
  DOC_TABLE,
  DOC_TABLE_CELL,
  DOC_TABLE_HEADER,
  DOC_TABLE_ROW,
} from '@web/spaces/document/document-table-nodes';
import { bodyDepthBetween, carrierAt } from '@web/spaces/document/document-body-carrier';
import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-geometry';

/** A row as the editor's block calls hand it back. */
interface BlockLike {
  readonly id: string;
  readonly type: string;
  readonly children: readonly BlockLike[];
}

/** The parts of a table that are no block of a body: its rows and cells. */
const TABLE_PARTS = new Set<string>([DOC_TABLE_ROW, DOC_TABLE_CELL, DOC_TABLE_HEADER]);

/** The editor calls a move reads. */
interface MoveEditor {
  readonly prosemirrorView: EditorView;
  getSelection(): { blocks: readonly BlockLike[] } | undefined;
  getTextCursorPosition(): { block: BlockLike };
  getPrevBlock(block: BlockLike): BlockLike | undefined;
  getNextBlock(block: BlockLike): BlockLike | undefined;
  getParentBlock(block: BlockLike): BlockLike | undefined;
  getBlock(id: string): BlockLike | undefined;
}

/** Where the moved rows go: next to this row, on this side of it. */
interface Placement {
  readonly referenceId: string;
  readonly side: 'before' | 'after';
}

/** What is carried whole, as one block of the body it stands in. */
const CARRIERS = new Set<string>([DOC_TABLE, DOC_COLUMN_LIST]);

/** Where a block stops: the top or bottom of a cell or a column. */
const STOPS = new Set<string>([...TABLE_PARTS, DOC_COLUMN]);

/**
 * What a move carries. Blocks all in one body (the page, a cell, a column)
 * move as themselves. Otherwise each is carried by the table or column group
 * it stands in right inside the innermost body holding them all, as one block
 * of that body (design 5.3; inner#1314 design 5.1).
 * @param editor - The editor.
 * @param blocks - The selected blocks, or the caret's.
 * @returns The blocks to move, in order.
 */
function unitsOf(editor: MoveEditor, blocks: readonly BlockLike[]): BlockLike[] {
  const doc = editor.prosemirrorView.state.doc;
  const rows = blocks.map((block) => rowById(doc, block.id));
  if (rows.some((row) => row === undefined)) return [...blocks];
  const $rows = rows.map((row) => doc.resolve(row!.from));
  const $first = $rows[0];
  const $last = $rows[$rows.length - 1];
  if ($first === undefined || $last === undefined) return [];
  // The first and last rows' common body holds every row between them.
  const body = bodyDepthBetween($first, $last);
  const units: BlockLike[] = [];
  const seen = new Set<string>();
  $rows.forEach(($row, index) => {
    const carrier = carrierAt($row, body);
    const unit = carrier === null ? blocks[index] : editor.getBlock(String(carrier.node.attrs['id']));
    if (unit !== undefined && !seen.has(unit.id)) {
      seen.add(unit.id);
      units.push(unit);
    }
  });
  return units;
}

/**
 * Where the rows go on the way up. A block at the top of a cell or a column
 * stays; a table or a column group above is passed as one block, and so is
 * every block when the rows carry a column group, which never hangs under a
 * row (inner#1314 design §5.1).
 * @param editor - The editor.
 * @param first - The first row being moved.
 * @param whole - Whether to pass the block above as one block.
 * @returns The place, or null when nothing is above to move past.
 */
function placementUp(editor: MoveEditor, first: BlockLike, whole: boolean): Placement | null {
  const prev = editor.getPrevBlock(first);
  if (prev === undefined) {
    const parent = editor.getParentBlock(first);
    return parent === undefined || STOPS.has(parent.type)
      ? null
      : { referenceId: parent.id, side: 'before' };
  }
  const under = whole || CARRIERS.has(prev.type) ? undefined : prev.children[prev.children.length - 1];
  return under === undefined
    ? { referenceId: prev.id, side: 'before' }
    : { referenceId: under.id, side: 'after' };
}

/**
 * Where the rows go on the way down. A block at the bottom of a cell or a
 * column stays; a table or a column group below is passed as one block, and
 * so is every block when the rows carry a column group.
 * @param editor - The editor.
 * @param last - The last row being moved.
 * @param whole - Whether to pass the block below as one block.
 * @returns The place, or null when nothing is below to move past.
 */
function placementDown(editor: MoveEditor, last: BlockLike, whole: boolean): Placement | null {
  const next = editor.getNextBlock(last);
  if (next === undefined) {
    const parent = editor.getParentBlock(last);
    return parent === undefined || STOPS.has(parent.type)
      ? null
      : { referenceId: parent.id, side: 'after' };
  }
  const under = whole || CARRIERS.has(next.type) ? undefined : next.children[0];
  return under === undefined
    ? { referenceId: next.id, side: 'after' }
    : { referenceId: under.id, side: 'before' };
}

/**
 * Where a position inside the moved rows lands once they are written back.
 * @param pos - The position in the document before the move.
 * @param rows - The moved rows' ranges before the move, in order.
 * @param at - Where they are written back.
 * @returns The position after the move, or null when it is not in a moved row.
 */
function carried(
  pos: number,
  rows: readonly { from: number; to: number }[],
  at: number,
): number | null {
  let before = 0;
  for (const row of rows) {
    if (pos >= row.from && pos <= row.to) return at + before + (pos - row.from);
    before += row.to - row.from;
  }
  return null;
}

/**
 * A selection that reached past the first or last block, after its rows moved
 * (#124). An end still on an edge stays one. An end the move took off the edge
 * sits beside a block without text, and is carried on outward to the next text,
 * or to the edge when there is none that way, so that block stays inside;
 * `TextSelection.between` would pull it back past that block.
 * @param doc - The document after the move.
 * @param anchor - The anchor, carried.
 * @param head - The head, carried.
 * @returns The selection.
 */
function edgeSelectionAfter(doc: PMNode, anchor: number, head: number): Selection {
  return bodyEdgeBetween(
    doc,
    textOrEdge(doc, anchor, anchor >= head ? 1 : -1),
    textOrEdge(doc, head, head >= anchor ? 1 : -1),
  );
}

/**
 * The selection over the moved rows, on the same letters.
 * @param doc - The document after the move.
 * @param selection - The selection before it.
 * @param rows - The moved rows' ranges before the move, in order.
 * @param at - Where they were written back.
 * @returns The selection, or null when an end is outside the moved rows.
 */
function selectionAfter(
  doc: PMNode,
  selection: Selection,
  rows: readonly { from: number; to: number }[],
  at: number,
): Selection | null {
  const anchor = carried(selection.anchor, rows, at);
  const head = carried(selection.head, rows, at);
  if (anchor === null || head === null) return null;
  if (selection instanceof BodyEdgeSelection) return edgeSelectionAfter(doc, anchor, head);
  return selection instanceof NodeSelection
    ? NodeSelection.create(doc, anchor)
    : TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}

/**
 * Moves the selected rows, or the caret's row, one place up or down.
 * @param editor - The editor.
 * @param direction - Which way.
 */
export function moveRowsFromKeyboard(
  editor: MoveEditor,
  direction: 'up' | 'down',
): void {
  const view = editor.prosemirrorView;
  const blocks = unitsOf(editor, editor.getSelection()?.blocks ?? [
    editor.getTextCursorPosition().block,
  ]);
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) return;
  const whole = blocks.some((block) => block.type === DOC_COLUMN_LIST);
  const place =
    direction === 'up'
      ? placementUp(editor, first, whole)
      : placementDown(editor, last, whole);
  if (place === null) return;

  const { doc, selection } = view.state;
  const rows = blocks.map((block) => rowById(doc, block.id));
  const reference = rowById(doc, place.referenceId);
  if (reference === undefined || rows.some((row) => row === undefined)) return;
  const moved = rows as NonNullable<(typeof rows)[number]>[];

  const tr = view.state.tr;
  // Each row is looked up again after the removals before it, so a group
  // emptied by the last of its rows leaving goes with that row.
  for (const block of blocks) {
    const row = rowById(tr.doc, block.id);
    if (row === undefined) return;
    const leaving = rangeToLift(tr.doc, row);
    tr.delete(leaving.from, leaving.to);
  }
  const at = tr.mapping.map(
    place.side === 'before' ? reference.from : reference.to,
  );
  tr.insert(
    at,
    moved.map((row) => row.node),
  );
  const kept = selectionAfter(tr.doc, selection, moved, at);
  if (kept !== null) tr.setSelection(kept);
  view.dispatch(tr.scrollIntoView());
}

/**
 * The extension that binds the two keys.
 * @returns The extension, for the assembly to register.
 */
export const documentKeyboardMoveExtension = createExtension(() => ({
  key: 'document-keyboard-move',
  keyboardShortcuts: {
    'Shift-Mod-ArrowUp': ({ editor }: { editor: MoveEditor }): boolean => {
      moveRowsFromKeyboard(editor, 'up');
      return true;
    },
    'Shift-Mod-ArrowDown': ({ editor }: { editor: MoveEditor }): boolean => {
      moveRowsFromKeyboard(editor, 'down');
      return true;
    },
  },
}) as never);
