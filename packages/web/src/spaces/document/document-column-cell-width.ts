// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Columns made in a cell widen the cell's table column to hold them side by
 * side (inner#1314 design §5.1): whenever a local transaction puts a column
 * group into a cell, or a column into a group in a cell, and the cell is too
 * narrow for its columns, the table's drawn widths are written down
 * (`holdColumnWidths`, as a column drag starts) and that column is widened.
 * Only then: a column the user narrows afterwards stacks its groups instead.
 * The write lands in the same undo step as the change that caused it, within
 * the undo manager's capture timeout.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

import { COLUMN_GAP, MIN_COLUMN_WIDTH } from '@web/spaces/document/document-column-geometry';
import { DOC_COLUMN_LIST } from '@web/spaces/document/document-column-nodes';
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
 * The groups in cells that gained a column, or came in, since a state.
 * @param before - The state before.
 * @param doc - The document now.
 * @returns Their positions.
 */
function grownGroups(before: EditorState, doc: PMNode): number[] {
  const was = groupsInCells(before.doc);
  const grown: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== DOC_COLUMN_LIST) return true;
    const id = String(node.attrs['id']);
    if (isTableCell(doc.resolve(pos).parent) && node.childCount > (was.get(id) ?? 0)) grown.push(pos);
    return false;
  });
  return grown;
}

/**
 * Widens the table column a group's cell stands in, when the cell is too
 * narrow for the group's columns.
 * @param view - The editor view.
 * @param groupPos - Where the group starts.
 */
function widenFor(view: EditorView, groupPos: number): void {
  const { doc } = view.state;
  const group = doc.nodeAt(groupPos);
  const $group = doc.resolve(groupPos);
  const cellDepth = $group.depth;
  const tableDepth = cellDepth - 2;
  const element = view.nodeDOM(groupPos);
  const cellDom = view.nodeDOM($group.before(cellDepth));
  if (group === null || tableDepth < 1 || !(element instanceof HTMLElement) || !(cellDom instanceof HTMLElement)) return;
  const count = group.childCount;
  const needed = count * MIN_COLUMN_WIDTH + (count - 1) * COLUMN_GAP;
  const room = element.getBoundingClientRect().width;
  if (room >= needed) return;
  const table = $group.node(tableDepth);
  const tablePos = $group.before(tableDepth);
  const map = TableMap.get(table);
  const cellRel = $group.before(cellDepth) - tablePos - 1;
  const column = map.colCount(cellRel);
  const widths = drawnColumns(view, table, tablePos + 1);
  const target = Math.ceil((widths[column] ?? cellDom.offsetWidth) + needed - room);
  const tr = holdColumnWidths(view.state.tr, tablePos, widths.map((width, k) => (k === column ? target : width)));
  // A cell that already held its width keeps it in `holdColumnWidths`; the
  // column widened here is written on every cell of the column.
  for (const rel of map.cellsInRect({ left: column, top: 0, right: column + 1, bottom: map.height })) {
    const cell = table.nodeAt(rel)!;
    if (Number(cell.attrs['colspan'] ?? 1) !== 1) continue;
    tr.setNodeMarkup(tablePos + 1 + rel, undefined, { ...cell.attrs, colwidth: [target] });
  }
  if (tr.docChanged) view.dispatch(tr);
}

/**
 * The extension that widens a cell's column for the columns made in it.
 * @returns The extension, for the assembly to register.
 */
export const documentColumnCellWidthExtension = createExtension(() => ({
  key: 'document-column-cell-width',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentColumnCellWidth'),
      view: () => ({
        update: (view: EditorView, before: EditorState): void => {
          if (view.state.doc === before.doc) return;
          const sync = ySyncPluginKey.getState(view.state) as { isChangeOrigin?: boolean } | undefined;
          if (sync?.isChangeOrigin === true || !view.editable) return;
          const grown = grownGroups(before, view.state.doc);
          // Measured once the browser has drawn the new columns.
          if (grown.length > 0) {
            requestAnimationFrame(() => {
              for (const pos of grown.reverse()) widenFor(view, pos);
            });
          }
        },
      }),
    }),
  ],
}));
