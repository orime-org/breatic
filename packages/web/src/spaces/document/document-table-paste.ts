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
 * its end to the widest row, the shape the reader saw on the page; a table
 * holding no cell at all goes, since ProseMirror builds no table from it. The
 * paste and the drop both do it while the HTML is made ready to read
 * (`document-paste-html.ts`).
 */

/**
 * Evens one table's grid, in place; a table holding no cell has no grid and
 * goes, since no table can be built from it.
 * @param table - The table.
 * @returns Whether anything changed.
 */
function evenTable(table: HTMLTableElement): boolean {
  const rows = Array.from(table.rows);
  if (rows.every((row) => row.cells.length === 0)) {
    table.remove();
    return true;
  }
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
 * Evens every table under a root, in place.
 * @param root - Where the tables are.
 * @returns Whether anything changed.
 */
export function evenTables(root: Element): boolean {
  let changed = false;
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (evenTable(table)) changed = true;
  }
  return changed;
}
