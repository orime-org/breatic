// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tab, Shift-Tab and Enter inside a table cell, and Delete over every cell of
 * an empty table.
 *
 * Tab and Shift-Tab move between cells, and Tab in the last cell adds a row
 * first — the way Google Docs, Notion and Word answer it. Enter breaks the
 * line inside the cell: a cell is somewhere to write, and the library's Enter
 * (to the cell below) leaves no way to write a second line in it.
 *
 * Order matters in both directions. This runs ahead of `document-tab`, whose
 * Tab nests the block, and ahead of the library's table keys
 * (`TableExtension.ts:37-100`), which BlockNote registers as a plain Tiptap
 * extension below every extension of ours. `document-enter` runs ahead of
 * this: its input-method guard has to see the Enter that commits a
 * composition, and it declines every other Enter inside a table.
 */

import { createExtension } from '@blocknote/core';
import type { EditorView } from '@tiptap/pm/view';
import type { BlockNoteEditor } from '@blocknote/core';
import { wholeEmptyTableSelected } from '@web/spaces/document/document-table-run';
import {
  addRowAfter,
  CellSelection,
  goToNextCell,
  isInTable,
} from '@tiptap/pm/tables';

/** The parts of the editor these bindings use. */
interface KeysEditor {
  readonly prosemirrorView: EditorView;
  removeBlocks: BlockNoteEditor<never, never, never>['removeBlocks'];
}

/**
 * Moves to the next cell, adding a row first from the last cell.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function tabForward(view: EditorView): boolean {
  if (!isInTable(view.state)) return false;
  if (!goToNextCell(1)(view.state, view.dispatch)) {
    addRowAfter(view.state, view.dispatch);
    goToNextCell(1)(view.state, view.dispatch);
  }
  return true;
}

/**
 * Moves to the previous cell; in the first cell the caret stays.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function tabBack(view: EditorView): boolean {
  if (!isInTable(view.state)) return false;
  goToNextCell(-1)(view.state, view.dispatch);
  return true;
}

/**
 * Breaks the line inside the cell.
 *
 * Over several selected cells the key does nothing: a line break belongs
 * inside one line.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function breakLine(view: EditorView): boolean {
  const { state } = view;
  if (!isInTable(state)) return false;
  if (state.selection instanceof CellSelection) return true;
  const hardBreak = state.schema.nodes['hardBreak'];
  if (hardBreak === undefined) return false;
  view.dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
}

/**
 * Takes a whole empty table away when every cell of it is selected — what the
 * library does for Backspace (`Table/block.ts:442-491`), for the other key a
 * reader deletes with. Anything else is the library's: `deleteCellSelection`
 * empties the selected cells.
 * @param editor - The editor.
 * @returns Whether the key was claimed.
 */
function deleteWholeTable(editor: KeysEditor): boolean {
  const blockId = wholeEmptyTableSelected(editor.prosemirrorView.state);
  if (blockId === null) return false;
  editor.removeBlocks([blockId]);
  return true;
}

/**
 * The extension that binds the keys inside a table.
 * @returns The extension, for the assembly to register.
 */
export const documentTableKeysExtension = createExtension(() => ({
  key: 'document-table-keys',
  runsBefore: ['document-tab'],
  keyboardShortcuts: {
    Tab: ({ editor }: { editor: KeysEditor }) => tabForward(editor.prosemirrorView),
    'Shift-Tab': ({ editor }: { editor: KeysEditor }) => tabBack(editor.prosemirrorView),
    Enter: ({ editor }: { editor: KeysEditor }) => breakLine(editor.prosemirrorView),
    'Shift-Enter': ({ editor }: { editor: KeysEditor }) => breakLine(editor.prosemirrorView),
    Delete: ({ editor }: { editor: KeysEditor }) => deleteWholeTable(editor),
  },
}) as never);
