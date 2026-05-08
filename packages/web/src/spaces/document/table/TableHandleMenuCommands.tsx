import type { Editor } from '@tiptap/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { selectedRect } from '@tiptap/pm/tables';

function getRect(editor: Editor) {
  try {
    return selectedRect(editor.state);
  } catch {
    return null;
  }
}

function isRectangularGrid(table: PMNode, mapWidth: number): boolean {
  let ok = true;
  table.forEach((row) => {
    if (row.childCount !== mapWidth) ok = false;
  });
  return ok;
}

function replaceTable(editor: Editor, newTable: PMNode): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const tr = state.tr.replaceWith(r.tableStart, r.tableStart + r.table.nodeSize, newTable);
  view.dispatch(tr);
  return true;
}

/** Swap two columns (no colspan / uniform row width). */
export function moveTableColumn(editor: Editor, direction: 'left' | 'right'): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { map, table } = r;
  const col = r.left;
  const next = direction === 'left' ? col - 1 : col + 1;
  if (next < 0 || next >= map.width) return false;
  if (!isRectangularGrid(table, map.width)) return false;

  const newRows: PMNode[] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((c) => cells.push(c));
    const copy = [...cells];
    [copy[col], copy[next]] = [copy[next], copy[col]];
    newRows.push(row.type.create(row.attrs, Fragment.fromArray(copy)));
  });
  const newTable = table.type.create(table.attrs, Fragment.fromArray(newRows));
  return replaceTable(editor, newTable);
}

/** Swap two rows. */
export function moveTableRow(editor: Editor, direction: 'up' | 'down'): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { map, table } = r;
  const row = r.top;
  const next = direction === 'up' ? row - 1 : row + 1;
  if (next < 0 || next >= map.height) return false;

  const rows: PMNode[] = [];
  table.forEach((rw) => rows.push(rw));
  const copy = [...rows];
  [copy[row], copy[next]] = [copy[next], copy[row]];
  const newTable = table.type.create(table.attrs, Fragment.fromArray(copy));
  return replaceTable(editor, newTable);
}

export function duplicateTableColumn(editor: Editor, colIndex: number): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { map, table } = r;
  if (colIndex < 0 || colIndex >= map.width) return false;
  if (!isRectangularGrid(table, map.width)) return false;

  const newRows: PMNode[] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((c) => cells.push(c));
    const cell = cells[colIndex];
    const dup = cell.type.create(cell.attrs, cell.content, cell.marks);
    const merged = [...cells.slice(0, colIndex + 1), dup, ...cells.slice(colIndex + 1)];
    newRows.push(row.type.create(row.attrs, Fragment.fromArray(merged)));
  });
  const newTable = table.type.create(table.attrs, Fragment.fromArray(newRows));
  return replaceTable(editor, newTable);
}

export function duplicateTableRow(editor: Editor, rowIndex: number): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { map, table } = r;
  if (rowIndex < 0 || rowIndex >= map.height) return false;

  const rows: PMNode[] = [];
  table.forEach((rw) => rows.push(rw));
  const row = rows[rowIndex];
  const dup = row.type.create(row.attrs, row.content, row.marks);
  const merged = [...rows.slice(0, rowIndex + 1), dup, ...rows.slice(rowIndex + 1)];
  const newTable = table.type.create(table.attrs, Fragment.fromArray(merged));
  return replaceTable(editor, newTable);
}

export function setTableColumnCellBackground(editor: Editor, colIndex: number, color: string | null): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const { map, tableStart } = r;
  let tr = state.tr;
  for (let row = 0; row < map.height; row++) {
    const offset = map.map[row * map.width + colIndex];
    const abs = tableStart + offset;
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
    tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, backgroundColor: color });
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export function setTableRowCellBackground(editor: Editor, rowIndex: number, color: string | null): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const { map, tableStart } = r;
  let tr = state.tr;
  for (let col = 0; col < map.width; col++) {
    const offset = map.map[rowIndex * map.width + col];
    const abs = tableStart + offset;
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
    tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, backgroundColor: color });
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export function setTableColumnCellAlign(
  editor: Editor,
  colIndex: number,
  align: 'left' | 'center' | 'right' | null,
): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const { map, tableStart } = r;
  let tr = state.tr;
  for (let row = 0; row < map.height; row++) {
    const offset = map.map[row * map.width + colIndex];
    const abs = tableStart + offset;
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
    const next = { ...cell.attrs, align: align ?? null };
    tr = tr.setNodeMarkup(abs, undefined, next);
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

export function setTableRowCellAlign(
  editor: Editor,
  rowIndex: number,
  align: 'left' | 'center' | 'right' | null,
): boolean {
  const r = getRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const { map, tableStart } = r;
  let tr = state.tr;
  for (let col = 0; col < map.width; col++) {
    const offset = map.map[rowIndex * map.width + col];
    const abs = tableStart + offset;
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
    tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, align: align ?? null });
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}
