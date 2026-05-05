import type { Editor } from '@tiptap/react';
import { CellSelection, TableMap, setCellAttr } from '@tiptap/pm/tables';

function clearNativeDomTextSelection(): void {
  window.getSelection()?.removeAllRanges();
}

function setVerticalAlignForCurrentTableSelection(
  editor: Editor,
  verticalAlign: 'top' | 'middle' | 'bottom' | null,
): boolean {
  const { state, view } = editor;
  const didApply = setCellAttr('verticalAlign', verticalAlign)(state, (tr) => view.dispatch(tr));
  clearNativeDomTextSelection();
  return didApply;
}

/** Inclusive grid rectangle → `setCellSelection` (anchor = top-left cell, head = bottom-right cell). */
export function selectCellsInclusiveRect(
  editor: Editor,
  tableStart: number,
  map: TableMap,
  top: number,
  left: number,
  bottom: number,
  right: number,
): boolean {
  const tTop = Math.min(top, bottom);
  const tBottom = Math.max(top, bottom);
  const tLeft = Math.min(left, right);
  const tRight = Math.max(left, right);
  if (tTop < 0 || tLeft < 0 || tBottom >= map.height || tRight >= map.width) return false;
  const anchorPos = tableStart + map.map[tTop * map.width + tLeft];
  const headPos = tableStart + map.map[tBottom * map.width + tRight];
  try {
    const { state, view } = editor;
    const selection = CellSelection.create(state.doc, anchorPos, headPos);
    view.dispatch(state.tr.setSelection(selection));
    clearNativeDomTextSelection();
    return true;
  } catch {
    return false;
  }
}

export function selectTableRow(editor: Editor, tableStart: number, map: TableMap, row: number): boolean {
  return selectCellsInclusiveRect(editor, tableStart, map, row, 0, row, map.width - 1);
}

export function selectTableColumn(editor: Editor, tableStart: number, map: TableMap, col: number): boolean {
  return selectCellsInclusiveRect(editor, tableStart, map, 0, col, map.height - 1, col);
}

export function selectSingleTableCell(
  editor: Editor,
  tableStart: number,
  map: TableMap,
  row: number,
  col: number,
): boolean {
  return selectCellsInclusiveRect(editor, tableStart, map, row, col, row, col);
}

export function selectWholeTable(editor: Editor, tableStart: number): boolean {
  const table = editor.state.doc.nodeAt(tableStart);
  if (!table || table.type.name !== 'table') return false;
  const map = TableMap.get(table);
  if (map.width <= 0 || map.height <= 0) return false;
  /** `setCellSelection` expects absolute cell positions based on table content start (`tablePos + 1`). */
  const tableContentStart = tableStart + 1;
  return selectCellsInclusiveRect(editor, tableContentStart, map, 0, 0, map.height - 1, map.width - 1);
}

export function setRowVerticalAlign(
  editor: Editor,
  tableStart: number,
  map: TableMap,
  row: number,
  verticalAlign: 'top' | 'middle' | 'bottom' | null,
): boolean {
  if (!selectTableRow(editor, tableStart, map, row)) return false;
  setVerticalAlignForCurrentTableSelection(editor, verticalAlign);
  return true;
}

export function setColumnVerticalAlign(
  editor: Editor,
  tableStart: number,
  map: TableMap,
  col: number,
  verticalAlign: 'top' | 'middle' | 'bottom' | null,
): boolean {
  if (!selectTableColumn(editor, tableStart, map, col)) return false;
  setVerticalAlignForCurrentTableSelection(editor, verticalAlign);
  return true;
}

export function setWholeTableVerticalAlign(
  editor: Editor,
  tableStart: number,
  verticalAlign: 'top' | 'middle' | 'bottom' | null,
): boolean {
  if (!selectWholeTable(editor, tableStart)) return false;
  setVerticalAlignForCurrentTableSelection(editor, verticalAlign);
  return true;
}
