// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shift-Mod-ArrowUp and Shift-Mod-ArrowDown: move the selected rows one place.
 *
 * BlockNote binds both keys to `moveBlocksUp` / `moveBlocksDown`
 * (`KeyboardShortcutsExtension.ts:989-996`), which take the rows out and put
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
 * some; out of the row above when there is no sibling that way. Its column
 * check does not apply — this schema has no columns.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type Selection,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { rangeToLift } from '@web/spaces/document/document-drag-move';
import { rowById } from '@web/spaces/document/document-row-by-id';

/** A row as the editor's block calls hand it back. */
interface BlockLike {
  readonly id: string;
  readonly children: readonly BlockLike[];
}

/** The editor calls a move reads. */
interface MoveEditor {
  readonly prosemirrorView: EditorView;
  getSelection(): { blocks: readonly BlockLike[] } | undefined;
  getTextCursorPosition(): { block: BlockLike };
  getPrevBlock(block: BlockLike): BlockLike | undefined;
  getNextBlock(block: BlockLike): BlockLike | undefined;
  getParentBlock(block: BlockLike): BlockLike | undefined;
}

/** Where the moved rows go: next to this row, on this side of it. */
interface Placement {
  readonly referenceId: string;
  readonly side: 'before' | 'after';
}

/**
 * Where the rows go on the way up.
 * @param editor - The editor.
 * @param first - The first row being moved.
 * @returns The place, or null when nothing is above to move past.
 */
function placementUp(editor: MoveEditor, first: BlockLike): Placement | null {
  const prev = editor.getPrevBlock(first);
  if (prev === undefined) {
    const parent = editor.getParentBlock(first);
    return parent === undefined
      ? null
      : { referenceId: parent.id, side: 'before' };
  }
  const under = prev.children[prev.children.length - 1];
  return under === undefined
    ? { referenceId: prev.id, side: 'before' }
    : { referenceId: under.id, side: 'after' };
}

/**
 * Where the rows go on the way down.
 * @param editor - The editor.
 * @param last - The last row being moved.
 * @returns The place, or null when nothing is below to move past.
 */
function placementDown(editor: MoveEditor, last: BlockLike): Placement | null {
  const next = editor.getNextBlock(last);
  if (next === undefined) {
    const parent = editor.getParentBlock(last);
    return parent === undefined
      ? null
      : { referenceId: parent.id, side: 'after' };
  }
  const under = next.children[0];
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
  const blocks = editor.getSelection()?.blocks ?? [
    editor.getTextCursorPosition().block,
  ];
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) return;
  const place =
    direction === 'up'
      ? placementUp(editor, first)
      : placementDown(editor, last);
  if (place === null) return;

  const { doc, selection } = view.state;
  const rows = blocks.map((block) => rowById(doc, block.id));
  const reference = rowById(doc, place.referenceId);
  if (reference === undefined || rows.some((row) => row === undefined)) return;
  const moved = rows as NonNullable<(typeof rows)[number]>[];

  const tr = view.state.tr;
  // Last first, so each row is looked for in the document as the earlier
  // removals left it, and a group emptied by the last of its rows leaving
  // goes with that row.
  for (const block of [...blocks].reverse()) {
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
