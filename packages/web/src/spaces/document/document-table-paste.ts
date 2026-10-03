// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasted HTML tables made even before BlockNote reads them (inner#1126 A16).
 *
 * A browser draws a table whose grid does not add up — a rowspan running past
 * the last row, a row with fewer cells than the others — and the clipboard
 * keeps it as written. BlockNote turns pasted HTML into blocks and back into
 * HTML before ProseMirror sees it (`ExportManager.pasteHTML`), and on the way
 * back it lays every cell out on a grid sized from the rows: a span past the
 * last row writes outside that grid and throws, so nothing is pasted
 * (`api/blockManipulation/tables/tables.ts:197-226`). A short row reaches
 * ProseMirror intact and `fixTables` fills it — at the start of the first row,
 * where it takes the missing cells to be under a span from above, which moves
 * that row's words to the right.
 *
 * Here every rowspan is cut to the rows below it and every row is filled at
 * its end to the widest row, the shape the reader saw on the page.
 */

import type { BlockNoteEditorOptions } from '@blocknote/core';

/** BlockNote's paste hook, as this editor's options take it. */
type PasteHandler = NonNullable<BlockNoteEditorOptions<never, never, never>['pasteHandler']>;

/**
 * Evens one table's grid, in place.
 * @param table - The table.
 * @returns Whether anything changed.
 */
function evenTable(table: HTMLTableElement): boolean {
  const rows = Array.from(table.rows);
  const taken: Set<number>[] = rows.map(() => new Set());
  let changed = false;
  rows.forEach((row, r) => {
    let col = 0;
    for (const cell of Array.from(row.cells)) {
      while (taken[r]!.has(col)) col += 1;
      const span = Math.min(Math.max(cell.rowSpan, 1), rows.length - r);
      if (cell.rowSpan > span) {
        cell.rowSpan = span;
        changed = true;
      }
      const width = Math.max(cell.colSpan, 1);
      for (let down = 0; down < span; down += 1) {
        for (let across = 0; across < width; across += 1) taken[r + down]!.add(col + across);
      }
      col += width;
    }
  });
  const widest = Math.max(0, ...taken.map((cols) => cols.size));
  rows.forEach((row, r) => {
    for (let missing = widest - taken[r]!.size; missing > 0; missing -= 1) {
      row.insertCell();
      changed = true;
    }
  });
  return changed;
}

/**
 * Evens every table in a piece of pasted HTML.
 * @param html - The HTML.
 * @returns The same HTML when every table is already even, the evened HTML otherwise.
 */
export function evenPastedTables(html: string): string {
  if (!/<table/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    if (evenTable(table)) changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

/**
 * BlockNote's own paste, given the clipboard's HTML with its tables evened.
 * The clipboard is the event's, and BlockNote's handler reads it from there.
 * @param context - What BlockNote hands the paste hook.
 * @param context.event - The paste.
 * @param context.defaultPasteHandler - BlockNote's own paste.
 * @returns Whether the paste was handled.
 */
export const documentPasteHandler: PasteHandler = ({ event, defaultPasteHandler }) => {
  const data = event.clipboardData;
  const html = data?.getData('text/html') ?? '';
  const even = evenPastedTables(html);
  if (data !== null && even !== html) {
    const evened: Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'> = {
      types: data.types,
      files: data.files,
      items: data.items,
      getData: (format: string): string => (format === 'text/html' ? even : data.getData(format)),
    };
    Object.defineProperty(event, 'clipboardData', { value: evened });
  }
  return defaultPasteHandler();
};
