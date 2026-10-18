// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tab, Shift-Tab, Enter and the arrows inside a table cell, and Backspace and
 * Delete over every cell of an empty table.
 *
 * A cell holds blocks the way the body does (inner#1619), so Enter and
 * Shift-Enter in a cell are the body's own. Tab in a list item nests it where
 * it can go in, Shift-Tab takes a nested one out; otherwise they move between
 * cells, and Tab in the last cell adds a row first — the way Google Docs,
 * Notion and Word answer it. Over several selected cells Enter does nothing.
 *
 * A stored table from before (`document-table-legacy.ts`) has no table role:
 * Enter and Shift-Enter break the line in its cell, Tab and Shift-Tab do
 * nothing there.
 *
 * Order matters in both directions. This runs ahead of `document-tab`, whose
 * Tab nests the block anywhere. `document-enter` runs ahead of this: its
 * input-method guard has to see the Enter that commits a composition, and it
 * declines the Enter over selected cells and in a stored table's cell.
 */

import { createExtension } from '@blocknote/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { BlockNoteEditor } from '@blocknote/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { cellAt, wholeEmptyTableSelected } from '@web/spaces/document/document-table-run';
import {
  addRowAfter,
  cellAround,
  CellSelection,
  goToNextCell,
  isInTable,
} from '@tiptap/pm/tables';
import { isTableCell } from '@web/spaces/document/document-table-nodes';

/** The parts of the editor these bindings use. */
interface KeysEditor {
  readonly prosemirrorView: EditorView;
  removeBlocks: BlockNoteEditor<never, never, never>['removeBlocks'];
  insertBlocks: BlockNoteEditor<never, never, never>['insertBlocks'];
  setTextCursorPosition: BlockNoteEditor<never, never, never>['setTextCursorPosition'];
  canNestBlock: BlockNoteEditor<never, never, never>['canNestBlock'];
  nestBlock: BlockNoteEditor<never, never, never>['nestBlock'];
  unnestBlock: BlockNoteEditor<never, never, never>['unnestBlock'];
}

/** The line a stored table's cell holds (`document-table-legacy.ts`). */
const LEGACY_CELL_LINE = 'tableParagraph';

/** The list item types Tab nests before it moves between cells. */
const LIST_ITEMS = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

/**
 * Whether a position is in the line of a stored table's cell.
 * @param $pos - The position.
 * @returns True there.
 */
export function inLegacyCell($pos: ResolvedPos): boolean {
  return $pos.parent.type.name === LEGACY_CELL_LINE;
}

/**
 * Whether the caret's block is a list item, and whether it is nested under
 * another block of its cell rather than standing at the cell's top.
 * @param $head - The caret.
 * @returns Whether it is a list item, and whether it is nested.
 */
function listItemAt($head: ResolvedPos): { list: boolean; nested: boolean } {
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if ($head.node(depth).type.name !== 'blockContainer') continue;
    return {
      list: LIST_ITEMS.has($head.node(depth).firstChild?.type.name ?? ''),
      nested: $head.node(depth - 1).type.name === 'blockGroup',
    };
  }
  return { list: false, nested: false };
}

/**
 * Nests the list item the caret is in where it can go in; otherwise moves to
 * the next cell, adding a row first from the last cell.
 * @param editor - The editor.
 * @returns Whether the key was claimed.
 */
function tabForward(editor: KeysEditor): boolean {
  const view = editor.prosemirrorView;
  if (inLegacyCell(view.state.selection.$head)) return true;
  if (!isInTable(view.state)) return false;
  if (listItemAt(view.state.selection.$head).list && editor.canNestBlock()) {
    editor.nestBlock();
    return true;
  }
  if (!goToNextCell(1)(view.state, view.dispatch)) {
    addRowAfter(view.state, view.dispatch);
    goToNextCell(1)(view.state, view.dispatch);
  }
  return true;
}

/**
 * Takes a nested list item the caret is in out one level; otherwise moves to
 * the previous cell, and in the first cell the caret stays. A block at the top
 * of a cell never comes out of the cell.
 * @param editor - The editor.
 * @returns Whether the key was claimed.
 */
function tabBack(editor: KeysEditor): boolean {
  const view = editor.prosemirrorView;
  if (inLegacyCell(view.state.selection.$head)) return true;
  if (!isInTable(view.state)) return false;
  const item = listItemAt(view.state.selection.$head);
  if (item.list && item.nested) {
    editor.unnestBlock();
    return true;
  }
  goToNextCell(-1)(view.state, view.dispatch);
  return true;
}

/**
 * Enter and Shift-Enter where the body's own would be wrong: over several
 * selected cells they do nothing, and in a stored table's cell they break the
 * line. Everywhere else in a cell they are the body's.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function breakLine(view: EditorView): boolean {
  const { state } = view;
  if (state.selection instanceof CellSelection) return true;
  if (!inLegacyCell(state.selection.$head)) return false;
  const hardBreak = state.schema.nodes['hardBreak'];
  if (hardBreak === undefined) return false;
  view.dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
}

/**
 * The innermost block container around a position, and its depth.
 * @param $pos - The position.
 * @returns The depth, or -1 outside any block.
 */
function containerDepth($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'blockContainer') return depth;
  }
  return -1;
}


/**
 * The innermost cell around a position.
 * @param $pos - The position.
 * @returns The cell's depth, or -1 outside any cell.
 */
function cellDepth($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (isTableCell($pos.node(depth))) return depth;
  }
  return -1;
}

/**
 * Backspace at the start of a block where the body's own would reach across
 * a cell's or a table's edge (design 5.3):
 *
 * - at the start of the paragraph that opens a cell it does nothing; a
 *   heading or list item there turns into a paragraph first, which the body's
 *   own Backspace does;
 * - at the start of the block right under a table it moves the caret to the
 *   end of the table's last cell, and joins nothing.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function backspaceAtEdge(view: EditorView): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== 0) return false;
  const depth = containerDepth($head);
  if (depth < 0) return false;
  const parent = $head.node(depth - 1);
  const index = $head.index(depth - 1);
  if (isTableCell(parent) && index === 0) {
    const content = $head.node(depth).firstChild;
    return content?.type.name === 'paragraph' && content.attrs['quoted'] !== true;
  }
  if (cellDepth($head) > 0) return false;
  // The text before the block is in a table's cell only when a table ends
  // right before it.
  const inTable = Selection.findFrom(view.state.doc.resolve($head.before(depth)), -1, true);
  if (inTable === null || cellDepth(inTable.$head) < 0) return false;
  view.dispatch(view.state.tr.setSelection(inTable).scrollIntoView());
  return true;
}

/**
 * Delete at the end of a block where the body's own would reach across a
 * cell's or a table's edge (design 5.3): at the end of a cell's last block,
 * and at the end of the block right above a table, it does nothing.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function deleteAtEdge(view: EditorView): boolean {
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== $head.parent.content.size) return false;
  const next = Selection.findFrom(doc.resolve($head.after()), 1, true);
  const cell = cellDepth($head);
  if (cell > 0) return next === null || next.from > $head.end(cell);
  // Outside a cell, the next text is in a cell only when a table starts
  // right after the block.
  return next !== null && cellDepth(next.$head) > 0;
}

/**
 * Takes a whole empty table away when every cell of it is selected, for
 * either key a reader deletes with. Anything else is the table plugin's:
 * `deleteCellSelection` empties the selected cells.
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
 * Collapses words selected in a cell to the end the arrow points at, the way
 * an arrow treats a selection everywhere else in the body. The table plugin's
 * own arrow leaves for the next cell whenever the selection's head is at the
 * cell's edge (`prosemirror-tables` `arrow`, `dist/index.js:2140-2143`), and the
 * words Tab and Shift-Tab select always reach both edges.
 * @param view - The editor view.
 * @param dir - -1 for left, 1 for right.
 * @returns Whether the key was claimed.
 */
function collapseInCell(view: EditorView, dir: -1 | 1): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || selection.empty || !isInTable(view.state)) return false;
  const at = dir < 0 ? selection.from : selection.to;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  return true;
}

/** Which arrow leaves a table, and on which side. */
type EdgeArrow = 'up' | 'down' | 'left' | 'right';

/**
 * Opens a line beside a table at an end of the body, when the caret is on its
 * way out of it: on the first row going up or the last going down, at the
 * start of the first cell going left or the end of the last going right.
 * Nothing past such a table can take a selection, and the table plugin's own
 * arrow falls back into the table (`prosemirror-tables` `arrow`,
 * `dist/index.js:2143-2151`). Under the table this is the keyboard's way to
 * the line a click on the space below the last block opens; above it, to a
 * line before a table the body starts with.
 * @param editor - The editor.
 * @param dir - Which arrow.
 * @returns Whether the key was claimed.
 */
function leaveEdgeTable(editor: KeysEditor, dir: EdgeArrow): boolean {
  const view = editor.prosemirrorView;
  const { selection } = view.state;
  const cell = selection.empty ? cellAround(selection.$head) : null;
  const at = cell === null ? null : cellAt(view.state.doc, cell.pos);
  if (cell === null || at === null) return false;
  const before = dir === 'up' || dir === 'left';
  // The caret's line among the cell's lines, and the cell among the table's;
  // where it stands on that line is the view's to say.
  const line = selection.$head.index(cell.depth + 1);
  const edgeRow = before
    ? line === 0 && at.top === 0
    : line === cell.nodeAfter!.childCount - 1 && at.bottom === at.map.height;
  const edgeColumn = dir === 'left' ? at.left === 0 : dir === 'right' ? at.right === at.map.width : true;
  if (!edgeRow || !edgeColumn || !view.endOfTextblock(dir)) return false;
  // Just outside the table itself; past it that way, anything a selection can
  // stand on — a block nested under the table, a divider — means the body
  // goes on.
  const edge = before ? cell.before(cell.depth - 1) : cell.after(cell.depth - 1);
  if (Selection.findFrom(view.state.doc.resolve(edge), before ? -1 : 1) !== null) return false;
  const [opened] = editor.insertBlocks([{ type: 'paragraph' }] as never, at.blockId, before ? 'before' : 'after');
  if (opened === undefined) return false;
  editor.setTextCursorPosition(opened, 'start');
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
    Tab: ({ editor }: { editor: KeysEditor }) => tabForward(editor),
    'Shift-Tab': ({ editor }: { editor: KeysEditor }) => tabBack(editor),
    Enter: ({ editor }: { editor: KeysEditor }) => breakLine(editor.prosemirrorView),
    'Shift-Enter': ({ editor }: { editor: KeysEditor }) => breakLine(editor.prosemirrorView),
    Backspace: ({ editor }: { editor: KeysEditor }) =>
      deleteWholeTable(editor) || backspaceAtEdge(editor.prosemirrorView),
    Delete: ({ editor }: { editor: KeysEditor }) =>
      deleteWholeTable(editor) || deleteAtEdge(editor.prosemirrorView),
    ArrowLeft: ({ editor }: { editor: KeysEditor }) =>
      collapseInCell(editor.prosemirrorView, -1) || leaveEdgeTable(editor, 'left'),
    ArrowRight: ({ editor }: { editor: KeysEditor }) =>
      collapseInCell(editor.prosemirrorView, 1) || leaveEdgeTable(editor, 'right'),
    ArrowUp: ({ editor }: { editor: KeysEditor }) => leaveEdgeTable(editor, 'up'),
    ArrowDown: ({ editor }: { editor: KeysEditor }) => leaveEdgeTable(editor, 'down'),
  },
}) as never);
