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
 * its end to the widest row, the shape the reader saw on the page. The HTML
 * is then read as HTML whenever it carries media (inner#1351 design §5.1).
 *
 * A cell holds words only, so the media in a pasted table's cells would be
 * gone once the HTML is read; they are moved out first, to land under the
 * table the way media pasted into a cell do (inner#1351 design §5.4, A7).
 */

import type { PasteHandler } from '@web/spaces/document/document-file-input';
import { HTML_MEDIA_ELEMENTS } from '@web/spaces/document/document-media-types';

/** Whether a piece of HTML carries an image, a video or an audio. */
const HTML_MEDIA = new RegExp(`<(${HTML_MEDIA_ELEMENTS.join('|')})\\b`, 'i');

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

/** The media elements inside table cells. */
const CELL_MEDIA = HTML_MEDIA_ELEMENTS.flatMap((name) => [`td ${name}`, `th ${name}`]).join(', ');

/**
 * Pasted HTML with the media its table cells hold moved out, right after the
 * outermost table around them — after the figure around that table, when
 * there is one, which would otherwise be read as a captioned picture — in the
 * order they came in. A medium moves with the figure around it when that
 * figure is inside the cell too.
 * @param html - The HTML.
 * @returns The same HTML when no cell holds a medium, the moved HTML otherwise.
 */
export function liftCellMedia(html: string): string {
  if (!/<t[dh]\b/i.test(html) || !HTML_MEDIA.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const last = new Map<Element, Element>();
  for (const element of Array.from(doc.body.querySelectorAll(CELL_MEDIA))) {
    // Gone from its cell with a figure moved before it.
    const cell = element.closest('td, th');
    if (cell === null) continue;
    // A td in an SVG is no table cell.
    let table = cell.closest('table');
    if (table === null) continue;
    for (let outer = table.parentElement?.closest('table'); outer; outer = outer.parentElement?.closest('table')) {
      table = outer;
    }
    const anchor = table.closest('figure') ?? table;
    const figure = element.closest('figure');
    const carried = figure !== null && cell.contains(figure) ? figure : element;
    (last.get(anchor) ?? anchor).after(carried);
    last.set(anchor, carried);
  }
  return last.size === 0 ? html : doc.body.innerHTML;
}

/**
 * BlockNote's own paste, given the clipboard's HTML with its tables evened
 * and the media in their cells moved out.
 * The clipboard is the event's, and BlockNote's handler reads it from there.
 * @param context - What BlockNote hands the paste hook.
 * @param context.event - The paste.
 * @param context.defaultPasteHandler - BlockNote's own paste.
 * @returns Whether the paste was handled.
 */
export const documentPasteHandler: PasteHandler = ({ event, defaultPasteHandler }) => {
  const data = event.clipboardData;
  const html = data?.getData('text/html') ?? '';
  const even = liftCellMedia(evenPastedTables(html));
  if (data !== null && even !== html) {
    const evened: Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'> = {
      types: data.types,
      files: data.files,
      items: data.items,
      getData: (format: string): string => (format === 'text/html' ? even : data.getData(format)),
    };
    Object.defineProperty(event, 'clipboardData', { value: evened });
  }
  // HTML carrying media is read as HTML even when its plain text looks like
  // Markdown, which would drop every picture (inner#1351 design §5.1).
  return HTML_MEDIA.test(even) ? defaultPasteHandler({ prioritizeMarkdownOverHTML: false }) : defaultPasteHandler();
};
