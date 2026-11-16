// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Columns made in a cell widen the cell's table column to hold them side by
 * side (inner#1314 design §5.1): whenever a local transaction puts a column
 * group into a cell, or a column into a group in a cell, the table's drawn
 * widths are written down (`holdColumnWidths`, as a column drag starts), and
 * when the cell is too narrow for its columns that column is widened. A
 * column the user narrows afterwards stacks its groups instead.
 *
 * The widths are read off the table as drawn before the change and appended
 * to the transaction that made the columns, so they land in its undo step
 * whatever event dispatched it. A body written as it was saved keeps the
 * widths it was saved with ({@link localEdit}).
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { DOC_COLUMN_LIST, roomInside, weightsOf, weightsWidth } from '@web/spaces/document/document-column-geometry';
import { LEAVING_COLUMN } from '@web/spaces/document/document-column-drop';
import { localEdit } from '@web/spaces/document/document-column-repair';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { drawnColumns, holdColumnWidths } from '@web/spaces/document/document-table-column-widths';
import { isTableCell } from '@web/spaces/document/document-table-nodes';

/**
 * How many columns each group in a cell holds, by the group's id.
 * @param doc - The document.
 * @returns The counts.
 */
function groupsInCells(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== DOC_COLUMN_LIST) return true;
    if (isTableCell(doc.resolve(pos).parent)) counts.set(String(node.attrs['id']), node.childCount);
    return false;
  });
  return counts;
}

/**
 * The groups in cells that gained a column, or came in, between two documents.
 * @param before - The document before.
 * @param after - The document after.
 * @returns Their ids.
 */
function grownGroups(before: PMNode, after: PMNode): string[] {
  const was = groupsInCells(before);
  return [...groupsInCells(after)].filter(([id, count]) => count > (was.get(id) ?? 0)).map(([id]) => id);
}

/**
 * Writes down the widths of the table a group's cell stands in, as drawn,
 * widening the cell's column when the cell is too narrow for the group.
 * @param view - The editor view, still drawing the document before the change.
 * @param tr - The transaction to write into, on the document after it.
 * @param groupId - The group's id.
 * @param leaving - The id of a column the move's take-away empties next.
 */
function holdFor(view: EditorView, tr: Transaction, groupId: string, leaving: string | undefined): void {
  const found = rowById(tr.doc, groupId);
  if (found?.node.type.name !== DOC_COLUMN_LIST) return;
  const $group = tr.doc.resolve(found.from);
  const tableDepth = $group.depth - 2;
  if (!isTableCell($group.parent) || tableDepth < 1) return;
  const table = $group.node(tableDepth);
  const tablePos = $group.before(tableDepth);
  const map = TableMap.get(table);
  const { left: column, top } = map.findCell($group.before($group.depth) - tablePos - 1);
  // A table that comes in with the change is not drawn yet; it carries the
  // widths it was copied with.
  const drawn = rowById(view.state.doc, String(table.attrs['id']));
  if (drawn === undefined) return;
  const drawnMap = TableMap.get(drawn.node);
  if (top >= drawnMap.height || column >= drawnMap.width) return;
  const cellDom = view.nodeDOM(drawn.from + 1 + drawnMap.map[top * drawnMap.width + column]!);
  if (!(cellDom instanceof HTMLElement)) return;
  // Once held, the cell is drawn as wide as the whole-pixel widths of the
  // columns it covers, less its padding and border as drawn now: whether the
  // group fits, and by how much it falls short, is counted from them.
  const inside = roomInside(cellDom);
  const edges = cellDom.getBoundingClientRect().width - (inside.right - inside.left);
  const widths = drawnColumns(view, drawn.node, drawn.from + 1);
  const cellSpan = Number($group.parent.attrs['colspan'] ?? 1);
  const covered = widths.slice(column, column + cellSpan);
  const coveredWidth = covered.every((width) => width !== null) ? covered.reduce((sum, width) => sum + width!, 0) : cellDom.offsetWidth;
  const weights = weightsOf(found.node).filter((_weight, index) => found.node.child(index).attrs['id'] !== leaving);
  const deficit = weights.length <= 1 ? 0 : Math.ceil(weightsWidth(weights) + edges - coveredWidth);
  if (deficit <= 0) {
    holdColumnWidths(tr, tablePos, widths);
    return;
  }
  const target = (widths[column] ?? cellDom.offsetWidth) + deficit;
  holdColumnWidths(tr, tablePos, widths.map((width, k) => (k === column ? target : width)));
  // A cell that already held its width keeps it in `holdColumnWidths`; the
  // column widened here is written on every cell covering it, a merged one's
  // entry for this column included, so the table reads one width for it
  // (the table plugin's `fixTables` settles a column on the width most of
  // its cells hold).
  for (const rel of map.cellsInRect({ left: column, top: 0, right: column + 1, bottom: map.height })) {
    const cell = tr.doc.nodeAt(tablePos + 1 + rel)!;
    const colwidth = [...((cell.attrs['colwidth'] as (number | null)[] | null) ?? [])];
    const span = Number(cell.attrs['colspan'] ?? 1);
    for (let k = colwidth.length; k < span; k += 1) colwidth.push(widths[map.colCount(rel) + k] ?? null);
    colwidth[column - map.colCount(rel)] = target;
    tr.setNodeMarkup(tablePos + 1 + rel, undefined, { ...cell.attrs, colwidth });
  }
}

/**
 * The extension that widens a cell's column for the columns made in it.
 * @returns The extension, for the assembly to register.
 */
export const documentColumnCellWidthExtension = createExtension(() => {
  let drawing: EditorView | null = null;
  return {
    key: 'document-column-cell-width',
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentColumnCellWidth'),
        view: (view) => {
          drawing = view;
          return { destroy: (): void => void (drawing = null) };
        },
        appendTransaction: (transactions, before, after) => {
          const view = drawing;
          if (view === null || !view.editable || !localEdit(transactions)) return null;
          const grown = grownGroups(before.doc, after.doc);
          if (grown.length === 0) return null;
          const tr = after.tr;
          const leaving = transactions.map((transaction) => transaction.getMeta(LEAVING_COLUMN) as string | undefined).find((id) => id !== undefined);
          for (const id of grown) holdFor(view, tr, id, leaving);
          return tr.docChanged ? tr : null;
        },
      }),
    ],
  };
});
