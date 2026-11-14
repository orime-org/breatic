// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * whatever event dispatched it. A body written as it was saved
 * ({@link SAVED_BODY}) keeps the widths it was saved with.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { DOC_COLUMN_LIST, weightsFit, weightsOf, weightsWidth } from '@web/spaces/document/document-column-geometry';
import { SAVED_BODY } from '@web/spaces/document/document-column-repair';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { drawnColumns, holdColumnWidths } from '@web/spaces/document/document-table-column-widths';
import { isTableCell } from '@web/spaces/document/document-table-nodes';
import { fromYjs } from '@web/spaces/document/document-yjs-origin';

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
 * A length in pixels a computed style gives.
 * @param value - The computed value.
 * @returns The pixels, 0 for none.
 */
function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

/**
 * Writes down the widths of the table a group's cell stands in, as drawn,
 * widening the cell's column when the cell is too narrow for the group.
 * @param view - The editor view, still drawing the document before the change.
 * @param tr - The transaction to write into, on the document after it.
 * @param groupId - The group's id.
 */
function holdFor(view: EditorView, tr: Transaction, groupId: string): void {
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
  const style = getComputedStyle(cellDom);
  const room = cellDom.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
  const widths = drawnColumns(view, drawn.node, drawn.from + 1);
  const weights = weightsOf(found.node);
  if (weightsFit(room, weights)) {
    holdColumnWidths(tr, tablePos, widths);
    return;
  }
  const target = Math.ceil((widths[column] ?? cellDom.offsetWidth) + weightsWidth(weights) - room);
  holdColumnWidths(tr, tablePos, widths.map((width, k) => (k === column ? target : width)));
  // A cell that already held its width keeps it in `holdColumnWidths`; the
  // column widened here is written on every cell of the column.
  for (const rel of map.cellsInRect({ left: column, top: 0, right: column + 1, bottom: map.height })) {
    const cell = table.nodeAt(rel)!;
    if (Number(cell.attrs['colspan'] ?? 1) !== 1) continue;
    tr.setNodeMarkup(tablePos + 1 + rel, undefined, { ...cell.attrs, colwidth: [target] });
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
          if (view === null || !view.editable) return null;
          if (!transactions.some((tr) => tr.docChanged && !fromYjs(tr))) return null;
          if (transactions.some((tr) => tr.getMeta(SAVED_BODY) === true)) return null;
          const grown = grownGroups(before.doc, after.doc);
          if (grown.length === 0) return null;
          const tr = after.tr;
          for (const id of grown) holdFor(view, tr, id);
          return tr.docChanged ? tr : null;
        },
      }),
    ],
  };
});
