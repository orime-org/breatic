// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Dragging a column's edge changes that column only (inner#1126 A12).
 *
 * `prosemirror-tables` writes a width to the dragged column alone. A column
 * with no stored width is sized by the browser from what is left of the
 * table, and the table is as wide as its words ask, up to its frame — so a
 * column dragged wider took its room from the columns around it. When a drag
 * starts, every column of that table without a stored width is given the
 * width it is drawn at; the table's width is then the sum of its columns, and
 * the dragged column grows the table, which scrolls in its frame. The write is
 * kept off the undo stack: it changes nothing on screen, and one undo puts
 * the dragged column back.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { cellAt } from '@web/spaces/document/document-table-run';

/**
 * Gives every column of a table without a stored width the width given for it.
 * @param tr - The transaction to write into.
 * @param tablePos - The position before the table node.
 * @param columns - Each column's width, left to right; null where none is known.
 * @returns The transaction.
 */
export function holdColumnWidths(
  tr: Transaction,
  tablePos: number,
  columns: readonly (number | null)[],
): Transaction {
  const table = tr.doc.nodeAt(tablePos);
  if (table === null) return tr;
  const map = TableMap.get(table);
  const start = tablePos + 1;
  const seen = new Set<number>();
  map.map.forEach((rel, index) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const cell = table.nodeAt(rel);
    if (cell === null) return;
    const left = index % map.width;
    const span = Number(cell.attrs['colspan'] ?? 1);
    const stored = cell.attrs['colwidth'] as (number | null)[] | null;
    const held = Array.from({ length: span }, (_, k) => stored?.[k] ?? columns[left + k] ?? null);
    if (held.some((width) => width === null)) return;
    if (stored !== null && held.every((width, k) => width === stored[k])) return;
    tr.setNodeMarkup(start + rel, undefined, { ...cell.attrs, colwidth: held });
  });
  return tr;
}

/**
 * Each column's drawn width, from the cells that cover one column each.
 * @param view - The editor view.
 * @param table - The table node.
 * @param start - Where the table's content starts.
 * @returns The widths, left to right; null where no such cell is drawn.
 */
function drawnColumns(view: EditorView, table: PMNode, start: number): (number | null)[] {
  const map = TableMap.get(table);
  const columns: (number | null)[] = Array.from({ length: map.width }, () => null);
  map.map.forEach((rel, index) => {
    const left = index % map.width;
    if (columns[left] !== null || Number(table.nodeAt(rel)?.attrs['colspan'] ?? 1) !== 1) return;
    const dom = view.nodeDOM(start + rel);
    if (dom instanceof HTMLElement) columns[left] = dom.offsetWidth;
  });
  return columns;
}

/**
 * The plugin that holds the widths as a drag starts.
 *
 * The widths are read while the pointer rests on a column's edge, before the
 * drag: the moment it starts, the library marks the dragged column's cells
 * `column-resize-dragging`, and the library stylesheet takes the 120px
 * minimum off a cell so marked (`editor.css:174-178`) — the column snaps to
 * its words and its neighbours take the room before anything else runs.
 * @returns The plugin.
 */
function columnWidthsPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('document-table-column-widths'),
    view: () => {
      // The widths drawn while the pointer rests on an edge, and the table.
      let read: { tablePos: number; columns: (number | null)[] } | null = null;
      return {
        update: (view, prev): void => {
          const now = columnResizingPluginKey.getState(view.state);
          const at = now === undefined || now.activeHandle < 0 ? null : cellAt(view.state.doc, now.activeHandle);
          if (at === null) {
            read = null;
            return;
          }
          if (!now?.dragging) {
            read = { tablePos: at.tableStart - 1, columns: drawnColumns(view, at.table, at.tableStart) };
            return;
          }
          if (columnResizingPluginKey.getState(prev)?.dragging || read?.tablePos !== at.tableStart - 1) return;
          const tr = holdColumnWidths(view.state.tr, read.tablePos, read.columns);
          if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
        },
      };
    },
  });
}

/**
 * The extension that carries the plugin.
 * @returns The extension, for the assembly to register.
 */
export const documentTableColumnWidthsExtension = createExtension(() => ({
  key: 'document-table-column-widths',
  prosemirrorPlugins: [columnWidthsPlugin()],
}) as never);
