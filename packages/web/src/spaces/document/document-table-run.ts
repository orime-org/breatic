// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The commands a table's handles, its edge plus and its cell button run.
 *
 * Each one is handed the position of the cell it acts on — the cell the menu
 * was opened on, mapped through every change since (`document-table-target.ts`)
 * — and finds the table from it inside the transaction it writes, so an edit
 * someone else made in between cannot point it at the wrong row. It writes
 * the table in place, never through the block's JSON: our comment mark is
 * ignored by BlockNote's block conversion, and a round trip would drop it.
 * The reader's own selection is put back at the end of the same transaction:
 * the cell a command acts on is never the reader's selection.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import {
  addColumn,
  addRow,
  columnIsHeader,
  removeColumn,
  removeRow,
  rowIsHeader,
  TableMap,
  toggleHeader,
} from '@tiptap/pm/tables';

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
  /** Its first row and column. */
  readonly row: number;
  readonly col: number;
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
  return { table, tableStart, map, blockId, ...rect, row: rect.top, col: rect.left };
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
 * Adds a row at the bottom of the table the cell is in.
 * @param editor - The editor to write to.
 * @param cellPos - Any cell of the table.
 */
export function appendRow(editor: TableEditor, cellPos: number): void {
  runOnTable(editor, cellPos, (tr, at) => {
    addRow(tr, at, at.map.height);
  });
}

/**
 * Adds a column at the right of the table the cell is in.
 * @param editor - The editor to write to.
 * @param cellPos - Any cell of the table.
 */
export function appendColumn(editor: TableEditor, cellPos: number): void {
  runOnTable(editor, cellPos, (tr, at) => {
    addColumn(tr, at, at.map.width);
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
 * Turns the table's first row or first column into headers, or back.
 *
 * `toggleHeader` reads the table from the selection, so it runs against a
 * state that differs from the document's only in where the selection is, and
 * its steps are carried into this transaction.
 * @param editor - The editor to write to.
 * @param cellPos - Any cell of the table.
 * @param kind - The row or the column.
 */
export function toggleHeaderAt(editor: TableEditor, cellPos: number, kind: 'row' | 'column'): void {
  runOnTable(editor, cellPos, (tr) => {
    const inCell = EditorState.create({
      doc: tr.doc,
      selection: TextSelection.near(tr.doc.resolve(cellPos + 1)),
    });
    toggleHeader(kind)(inCell, (made) => {
      made.steps.forEach((step) => tr.step(step));
    });
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
    const rect =
      scope === 'row'
        ? { left: 0, right: at.map.width, top: at.top, bottom: at.bottom }
        : scope === 'column'
          ? { left: at.left, right: at.right, top: 0, bottom: at.map.height }
          : at;
    for (const rel of at.map.cellsInRect(rect)) {
      const cell = at.table.nodeAt(rel);
      if (cell !== null && cell.attrs[name] !== value) {
        tr.setNodeMarkup(at.tableStart + rel, null, { ...cell.attrs, [name]: value });
      }
    }
  });
}
