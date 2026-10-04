// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The commands a table's handles and its cell button run.
 *
 * Each one is handed the position of the cell it acts on — the cell the menu
 * was opened on, followed through every change since (`document-table-target.ts`)
 * — and finds the table from it inside the transaction it writes. It writes
 * the table in place, never through the block's JSON: our comment mark is
 * ignored by BlockNote's block conversion, and a round trip would drop it.
 * The reader's own selection is put back at the end of the same transaction:
 * the cell a command acts on is never the reader's selection.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  EditorState,
  TextSelection,
  type Selection,
  type Transaction,
} from '@tiptap/pm/state';
import {
  addColumn,
  addRow,
  cellAround,
  CellSelection,
  columnIsHeader,
  removeColumn,
  removeRow,
  mergeCells,
  moveTableColumn,
  moveTableRow,
  rowIsHeader,
  splitCell,
  TableMap,
  toggleHeader,
} from '@tiptap/pm/tables';

import { NO_COLOUR } from '@web/spaces/document/document-colour-run';

/** The editor, as far as these commands use it. */
type TableEditor = BlockNoteEditor<never, never, never>;

/** A cell, with the table around it and where it stands in that table. */
export interface CellAt {
  /** The table node. */
  readonly table: PMNode;
  /** Where the table's content starts. */
  readonly tableStart: number;
  /** The table's map. */
  readonly map: TableMap;
  /** The id of the block holding the table. */
  readonly blockId: string;
  /** The rows and columns the cell covers. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Which part of the table a cell attribute is written to. */
export type CellScope = 'row' | 'column' | 'cell';

/**
 * The cell at a position, and the table it is in.
 * @param doc - The document.
 * @param cellPos - The position before the cell node.
 * @returns The cell, or null when no cell is there.
 */
export function cellAt(doc: PMNode, cellPos: number): CellAt | null {
  if (cellPos < 0 || cellPos >= doc.content.size) return null;
  const cell = doc.nodeAt(cellPos);
  const role = cell?.type.spec['tableRole'] as string | undefined;
  if (role !== 'cell' && role !== 'header_cell') return null;
  const $cell = doc.resolve(cellPos);
  const table = $cell.node($cell.depth - 1);
  const tableStart = $cell.start($cell.depth - 1);
  const map = TableMap.get(table);
  const rect = map.findCell(cellPos - tableStart);
  const blockId = String($cell.node($cell.depth - 2).attrs['id']);
  return { table, tableStart, map, blockId, ...rect };
}

/**
 * Runs a write against the table a cell is in, and puts the reader's
 * selection back.
 * @param editor - The editor to write to.
 * @param cellPos - The cell the command acts on.
 * @param write - What the command does, given the cell as it stands in this
 *   transaction.
 */
function runOnTable(
  editor: TableEditor,
  cellPos: number,
  write: (tr: Transaction, at: CellAt) => void,
): void {
  editor.transact((tr) => {
    const at = cellAt(tr.doc, cellPos);
    if (at === null) return;
    const reader = tr.selection;
    const written = tr.mapping.maps.length;
    write(tr, at);
    if (tr.mapping.maps.length > written) {
      tr.setSelection(reader.map(tr.doc, tr.mapping.slice(written)));
    }
  });
}

/**
 * The table as it stands in the transaction now, read from a position inside it.
 * @param tr - The transaction.
 * @param tableStart - Where the table's content started when the command began.
 * @param written - How many steps the transaction held then.
 * @returns The table, as `addRow` and its kin take it.
 */
function tableNow(tr: Transaction, tableStart: number, written: number): CellAt {
  const start = tr.mapping.slice(written).map(tableStart);
  const table = tr.doc.resolve(start).parent;
  const firstCell = start + 1;
  const at = cellAt(tr.doc, firstCell);
  if (at === null || at.table !== table) {
    throw new Error('the table is no longer where the command left it');
  }
  return at;
}

/**
 * Inserts a row above or below the cell.
 * @param editor - The editor to write to.
 * @param cellPos - The cell.
 * @param side - Which side.
 */
export function insertRow(editor: TableEditor, cellPos: number, side: 'above' | 'below'): void {
  runOnTable(editor, cellPos, (tr, at) => {
    addRow(tr, at, side === 'above' ? at.top : at.bottom);
  });
}

/**
 * Inserts a column to the left or right of the cell.
 * @param editor - The editor to write to.
 * @param cellPos - The cell.
 * @param side - Which side.
 */
export function insertColumn(editor: TableEditor, cellPos: number, side: 'left' | 'right'): void {
  runOnTable(editor, cellPos, (tr, at) => {
    addColumn(tr, at, side === 'left' ? at.left : at.right);
  });
}

/**
 * Deletes the rows the cell covers; the whole table when they are all of them.
 *
 * `prosemirror-tables` refuses to delete every row (`deleteRow` returns false
 * there), and a table with no rows is not a table, so the block goes.
 * @param editor - The editor to write to.
 * @param cellPos - The cell.
 */
export function deleteRowAt(editor: TableEditor, cellPos: number): void {
  runOnTable(editor, cellPos, (tr, at) => {
    if (at.bottom - at.top >= at.map.height) {
      editor.removeBlocks([at.blockId]);
      return;
    }
    const written = tr.mapping.maps.length;
    for (let row = at.bottom - 1; row >= at.top; row -= 1) {
      removeRow(tr, tableNow(tr, at.tableStart, written), row);
    }
  });
}

/**
 * Deletes the columns the cell covers; the whole table when they are all of them.
 * @param editor - The editor to write to.
 * @param cellPos - The cell.
 */
export function deleteColumnAt(editor: TableEditor, cellPos: number): void {
  runOnTable(editor, cellPos, (tr, at) => {
    if (at.right - at.left >= at.map.width) {
      editor.removeBlocks([at.blockId]);
      return;
    }
    const written = tr.mapping.maps.length;
    for (let col = at.right - 1; col >= at.left; col -= 1) {
      removeColumn(tr, tableNow(tr, at.tableStart, written), col);
    }
  });
}

/**
 * Whether the table's first row or first column is headers.
 * @param doc - The document.
 * @param cellPos - Any cell of the table.
 * @param kind - The row or the column.
 * @returns True when it is.
 */
export function headerOn(doc: PMNode, cellPos: number, kind: 'row' | 'column'): boolean {
  const at = cellAt(doc, cellPos);
  if (at === null) return false;
  return kind === 'row' ? rowIsHeader(at.map, at.table, 0) : columnIsHeader(at.map, at.table, 0);
}

/**
 * Runs a `prosemirror-tables` command that reads the table from the
 * selection, with the selection in the given cell, and carries its steps into
 * this transaction. The state it runs against differs from the document's
 * only in where the selection is.
 * @param tr - The transaction.
 * @param cellPos - The cell.
 * @param command - The command.
 */
function runInCell(
  tr: Transaction,
  cellPos: number,
  command: (state: EditorState, dispatch: (made: Transaction) => void) => boolean,
): void {
  const inCell = EditorState.create({
    doc: tr.doc,
    selection: TextSelection.near(tr.doc.resolve(cellPos + 1)),
  });
  command(inCell, (made) => {
    made.steps.forEach((step) => tr.step(step));
  });
}

/**
 * Whether a cell spans more than one row or column.
 * @param doc - The document.
 * @param cellPos - The cell.
 * @returns True for a merged cell.
 */
export function isMerged(doc: PMNode, cellPos: number): boolean {
  const cell = doc.nodeAt(cellPos);
  return cell !== null && (Number(cell.attrs['colspan']) > 1 || Number(cell.attrs['rowspan']) > 1);
}

/**
 * Splits a merged cell back into the cells it covers; its content stays in
 * the top-left one.
 * @param editor - The editor to write to.
 * @param cellPos - The cell.
 */
export function splitCellAt(editor: TableEditor, cellPos: number): void {
  runOnTable(editor, cellPos, (tr) => {
    runInCell(tr, cellPos, splitCell);
  });
}

/**
 * Turns the table's first row or first column into headers, or back.
 *
 * `toggleHeader` reads the table from the selection, so it runs in the cell
 * through {@link runInCell}.
 * @param editor - The editor to write to.
 * @param cellPos - Any cell of the table.
 * @param kind - The row or the column.
 */
export function toggleHeaderAt(editor: TableEditor, cellPos: number, kind: 'row' | 'column'): void {
  runOnTable(editor, cellPos, (tr) => {
    runInCell(tr, cellPos, toggleHeader(kind));
  });
}

/**
 * Writes one attribute to every cell of the row, of the column, or to the one
 * cell.
 *
 * Every cell is written on its own: `setCellAttr` looks at one cell and does
 * nothing at all when that one already holds the value
 * (`prosemirror-tables/dist/index.js:1671-1675`).
 * @param editor - The editor to write to.
 * @param cellPos - The cell.
 * @param scope - Which cells.
 * @param name - The attribute.
 * @param value - Its new value.
 */
export function setCellsAttr(
  editor: TableEditor,
  cellPos: number,
  scope: CellScope,
  name: string,
  value: unknown,
): void {
  runOnTable(editor, cellPos, (tr, at) => {
    const cells = at.map.cellsInRect(scopeRect(at, scope)).map((rel) => at.tableStart + rel);
    writeCellsAttr(tr, cells, name, value);
  });
}

/**
 * The value one attribute holds across the row, the column or the one cell,
 * when every cell there holds the same.
 * @param doc - The document.
 * @param cellPos - The cell.
 * @param scope - Which cells.
 * @param name - The attribute.
 * @returns The shared value, or undefined when the cells differ or no cell is there.
 */
export function sharedCellAttr(
  doc: PMNode,
  cellPos: number,
  scope: CellScope,
  name: string,
): unknown {
  const at = cellAt(doc, cellPos);
  if (at === null) return undefined;
  const values = new Set(
    at.map.cellsInRect(scopeRect(at, scope)).map((rel) => at.table.nodeAt(rel)?.attrs[name]),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * The rectangle of cells a scope covers.
 * @param at - The cell.
 * @param scope - Which cells.
 * @returns The rectangle.
 */
function scopeRect(
  at: CellAt,
  scope: CellScope,
): { left: number; right: number; top: number; bottom: number } {
  if (scope === 'row') return { left: 0, right: at.map.width, top: at.top, bottom: at.bottom };
  if (scope === 'column') return { left: at.left, right: at.right, top: 0, bottom: at.map.height };
  return at;
}

/**
 * The cells a command written to a scope reaches, from one cell in it.
 * @param doc - The document.
 * @param cellPos - The position before the cell.
 * @param scope - Its row, its column, or the cell alone.
 * @returns The positions before those cells, or none when no cell is there.
 */
export function cellsOfScope(doc: PMNode, cellPos: number, scope: CellScope): number[] {
  const at = cellAt(doc, cellPos);
  if (at === null) return [];
  return at.map.cellsInRect(scopeRect(at, scope)).map((rel) => at.tableStart + rel);
}

/**
 * The position before a cell, from the table block's id and the cell's place
 * among the nodes — the indices the library's handles report.
 * @param doc - The document.
 * @param blockId - The table block's id.
 * @param rowIndex - The row's index among the table's rows.
 * @param cellIndex - The cell's index among that row's cells.
 * @returns The position, or null when no such cell is there.
 */
export function cellPosOf(
  doc: PMNode,
  blockId: string,
  rowIndex: number,
  cellIndex: number,
): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== 'blockContainer' || node.attrs['id'] !== blockId) return true;
    const table = node.firstChild;
    if (table?.type.name !== 'table' || rowIndex >= table.childCount) return false;
    const row = table.child(rowIndex);
    if (cellIndex >= row.childCount) return false;
    // Container, table and row each open one level.
    let at = pos + 1 + 1;
    for (let r = 0; r < rowIndex; r += 1) at += table.child(r).nodeSize;
    at += 1;
    for (let c = 0; c < cellIndex; c += 1) at += row.child(c).nodeSize;
    found = at;
    return false;
  });
  return found;
}

/**
 * The cells a selection covers: every cell of a selection over cells, or the
 * one cell a text selection sits in from end to end.
 * @param doc - The document.
 * @param selection - The selection.
 * @returns The positions before those cells; none outside a table.
 */
export function cellsUnder(doc: PMNode, selection: Selection): number[] {
  if (selection instanceof CellSelection) {
    const cells: number[] = [];
    selection.forEachCell((_cell, pos) => {
      cells.push(pos);
    });
    return cells;
  }
  const from = cellAround(selection.$from);
  const to = cellAround(selection.$to);
  return from !== null && to !== null && from.pos === to.pos ? [from.pos] : [];
}

/**
 * Writes one attribute to the given cells, where it differs.
 * @param tr - The transaction.
 * @param cells - The positions before the cells.
 * @param name - The attribute.
 * @param value - Its new value.
 */
export function writeCellsAttr(
  tr: Transaction,
  cells: readonly number[],
  name: string,
  value: unknown,
): void {
  for (const pos of cells) {
    const cell = tr.doc.nodeAt(pos);
    if (cell !== null && cell.attrs[name] !== value) {
      tr.setNodeMarkup(pos, null, { ...cell.attrs, [name]: value });
    }
  }
}

/**
 * The fill the cells under the selection share, as the colour panel names it.
 * @param state - The editor state.
 * @returns A hue, {@link NO_COLOUR} for none, `undefined` where the cells
 *   differ or the selection covers no cell.
 */
export function cellFillFace(state: EditorState): string | undefined {
  const cells = cellsUnder(state.doc, state.selection);
  if (cells.length === 0) return undefined;
  const fills = new Set(cells.map((pos) => state.doc.nodeAt(pos)?.attrs['backgroundColor']));
  if (fills.size !== 1) return undefined;
  const fill = [...fills][0] as string;
  return fill === 'default' ? NO_COLOUR : fill;
}

/**
 * Fills the cells under the selection, or takes their fill off.
 * @param editor - The editor to write to.
 * @param hue - The hue, or nothing to take the fill off.
 */
export function setCellFill(editor: TableEditor, hue: string | undefined): void {
  editor.transact((tr) => {
    writeCellsAttr(tr, cellsUnder(tr.doc, tr.selection), 'backgroundColor', hue ?? 'default');
  });
}

/**
 * Whether the selection is several cells that can be merged into one.
 * @param state - The editor state.
 * @returns True when a merge would do something.
 */
export function canMergeCells(state: EditorState): boolean {
  return state.selection instanceof CellSelection && mergeCells(state);
}

/**
 * Merges the selected cells into one; their words stay, in reading order.
 * @param editor - The editor to write to.
 */
export function mergeSelectedCells(editor: TableEditor): void {
  const view = editor.prosemirrorView;
  if (view === undefined) return;
  mergeCells(view.state, view.dispatch);
}

/**
 * The table a selection takes in whole, when every cell of it is empty: the
 * case where deleting the selection leaves nothing of the table to keep.
 * @param state - The editor state.
 * @returns The table block's id, or null.
 */
export function wholeEmptyTableSelected(state: EditorState): string | null {
  const { selection } = state;
  if (!(selection instanceof CellSelection)) return null;
  // Top to bottom and first column to last: the whole table.
  if (!selection.isRowSelection() || !selection.isColSelection()) return null;
  const at = cellAt(state.doc, selection.$anchorCell.pos);
  if (at === null) return null;
  let empty = true;
  at.table.descendants((node) => {
    const role = node.type.spec['tableRole'] as string | undefined;
    if (role !== 'cell' && role !== 'header_cell') return true;
    if (node.childCount !== 1 || node.firstChild!.childCount !== 0) empty = false;
    return false;
  });
  return empty ? at.blockId : null;
}

/**
 * Moves the row or column a cell is in so that it ends up at an index.
 *
 * `moveTableRow` and `moveTableColumn` find the line to move from the
 * selection, so they run in the cell through {@link runInCell}. They rebuild
 * the table from its own cell nodes, so the words, styles and comment marks
 * in the cells move with them.
 * @param editor - The editor to write to.
 * @param cellPos - A cell of the row or column.
 * @param orientation - Row or column.
 * @param to - The index it ends up at.
 */
export function moveLineAt(
  editor: TableEditor,
  cellPos: number,
  orientation: 'row' | 'column',
  to: number,
): void {
  runOnTable(editor, cellPos, (tr, at) => {
    const from = orientation === 'row' ? at.top : at.left;
    if (from === to) return;
    const move = orientation === 'row' ? moveTableRow : moveTableColumn;
    runInCell(tr, cellPos, move({ from, to, select: false, pos: cellPos + 1 }));
  });
}
