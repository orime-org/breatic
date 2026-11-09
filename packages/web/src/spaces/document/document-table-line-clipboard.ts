// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Copying, cutting and pasting a table's rows, columns and whole table from
 * their menus, and handing a row or a column to the Agent (inner#1239).
 *
 * A row or a column acts as the cells a drag of it moves (`canDragFrom`): a
 * merged cell reaching out of it refuses all of these. A copy writes what
 * Cmd+C writes with the same cells selected (`cellsClipped`), through a copy
 * event so our own clipboard type goes with it (clipboard-polyfill
 * `write-fallback`), and through the async clipboard when no copy event runs.
 * A paste reads the clipboard as Cmd+V reads it (`readTransfer`) and inserts
 * the one table it holds as new rows or columns (`insertLinesOf`), the cell it
 * acts on held through every change while the clipboard is read
 * (`holdPendingCell`).
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { cellsItem } from '@web/spaces/document/document-to-agent';
import { cellsClipped, writeClipped, type Clipped } from '@web/spaces/document/document-table-copy';
import { canDragFrom } from '@web/spaces/document/document-table-drag';
import { PASTED_MEDIA_KEY, type PastedMediaJudge } from '@web/spaces/document/document-external-media';
import { readTransfer, type Transfer } from '@web/spaces/document/document-paste-read';
import { judgedTable } from '@web/spaces/document/document-put';
import { cellAt, deleteColumnAt, deleteRowAt, insertLinesOf } from '@web/spaces/document/document-table-run';
import { holdPendingCell } from '@web/spaces/document/document-table-target';
import type { TrayItem } from '@web/stores/chat-attachments';

/** The editor, as far as these commands use it. */
type LineEditor = BlockNoteEditor<never, never, never>;

/** What a menu's copy, cut or Agent entry acts on. */
export type LineScope = 'row' | 'column' | 'table';

/** Where pasted rows or columns go, beside the menu's cell. */
export type PasteSide = 'above' | 'below' | 'left' | 'right';

/** How a copy ended. */
export type CopyOutcome = 'copied' | 'merged' | 'failed';

/** How a cut ended. */
export type CutOutcome = 'cut' | 'merged' | 'failed' | 'gone';

/** How a paste ended. */
export type PasteOutcome = 'pasted' | 'merged' | 'no-table' | 'unreadable' | 'gone';

/**
 * The editor's view.
 * @param editor - The editor.
 * @returns The view.
 * @throws {Error} When the editor is not mounted.
 */
function viewOf(editor: LineEditor): EditorView {
  const view = editor.prosemirrorView;
  if (view === undefined || view === null) throw new Error('the document editor is not mounted');
  return view;
}

/**
 * The cells a menu entry acts on.
 * @param doc - The document.
 * @param cellPos - The menu's cell.
 * @param scope - Its row, its column or the whole table.
 * @returns The selection, or null where a merged cell reaches out of the row or column.
 */
export function tableLineSelection(doc: PMNode, cellPos: number, scope: LineScope): CellSelection | null {
  const at = cellAt(doc, cellPos);
  if (at === null) return null;
  if (scope === 'table') {
    const { map, tableStart } = at;
    return CellSelection.create(doc, tableStart + map.map[0], tableStart + map.map[map.map.length - 1]);
  }
  if (!canDragFrom(doc, cellPos, scope)) return null;
  const $cell = doc.resolve(cellPos);
  return scope === 'row' ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
}

/**
 * Writes a copy through a copy event, so our own clipboard type goes with it.
 * A copy command needs a range selected on the page in WebKit before 18.4
 * (WebKit bug 156529), so a visible scrap of text is selected for it and the
 * page's selection put back after.
 * @param clipped - What the copy carries.
 * @returns Whether the copy event ran.
 */
function copyByEvent(clipped: Clipped): boolean {
  let ran = false;
  /**
   * Writes the copy, ahead of every other copy handler.
   * @param event - The copy the command fired.
   */
  const listener = (event: ClipboardEvent): void => {
    ran = true;
    event.stopImmediatePropagation();
    writeClipped(event, clipped);
  };
  const scrap = document.createElement('span');
  scrap.textContent = ' ';
  scrap.style.cssText = 'position:fixed;top:0;left:0;white-space:pre;user-select:text;-webkit-user-select:text;';
  const page = window.getSelection();
  const kept = page === null ? [] : Array.from({ length: page.rangeCount }, (_, i) => page.getRangeAt(i));
  document.body.appendChild(scrap);
  document.addEventListener('copy', listener, true);
  try {
    if (page !== null) {
      const range = document.createRange();
      range.selectNodeContents(scrap);
      page.removeAllRanges();
      page.addRange(range);
    }
    document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', listener, true);
    scrap.remove();
    if (page !== null) {
      page.removeAllRanges();
      kept.forEach((range) => page.addRange(range));
    }
  }
  return ran;
}

/**
 * Writes a copy through the async clipboard: HTML and plain text.
 * @param clipped - What the copy carries.
 * @returns Whether the write went through.
 */
async function copyByClipboard(clipped: Clipped): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined') return false;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([clipped.external], { type: 'text/html' }),
        'text/plain': new Blob([clipped.plain], { type: 'text/plain' }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a row, a column or the table to the clipboard.
 * @param editor - The editor.
 * @param cellPos - The menu's cell.
 * @param scope - What to copy.
 * @returns How it ended.
 */
export async function copyTableLine(editor: LineEditor, cellPos: number, scope: LineScope): Promise<CopyOutcome> {
  const view = viewOf(editor);
  const cells = tableLineSelection(view.state.doc, cellPos, scope);
  if (cells === null) return 'merged';
  const clipped = cellsClipped(editor, view, cells);
  return copyByEvent(clipped) || (await copyByClipboard(clipped)) ? 'copied' : 'failed';
}

/**
 * Deletes a row, a column or the table.
 * @param editor - The editor.
 * @param cellPos - The menu's cell.
 * @param scope - What to delete.
 */
function deleteLine(editor: LineEditor, cellPos: number, scope: LineScope): void {
  if (scope === 'row') deleteRowAt(editor, cellPos);
  else if (scope === 'column') deleteColumnAt(editor, cellPos);
  else {
    const at = cellAt(viewOf(editor).state.doc, cellPos);
    if (at !== null) editor.removeBlocks([at.blockId]);
  }
}

/**
 * Copies a row, a column or the table, then deletes it. When the copy waits
 * on the async clipboard, what it deletes is the cell held through every
 * change meanwhile; nothing is deleted once that cell is gone.
 * @param editor - The editor.
 * @param cellPos - The menu's cell.
 * @param scope - What to cut.
 * @returns How it ended.
 */
export async function cutTableLine(editor: LineEditor, cellPos: number, scope: LineScope): Promise<CutOutcome> {
  const view = viewOf(editor);
  const cells = tableLineSelection(view.state.doc, cellPos, scope);
  if (cells === null) return 'merged';
  const clipped = cellsClipped(editor, view, cells);
  if (copyByEvent(clipped)) {
    deleteLine(editor, cellPos, scope);
    return 'cut';
  }
  const held = holdPendingCell(view, cellPos);
  try {
    if (!(await copyByClipboard(clipped))) return 'failed';
    const now = held.now();
    if (now === null) return 'gone';
    // The table may have changed while the clipboard was written.
    if (scope !== 'table' && !canDragFrom(view.state.doc, now, scope)) return 'merged';
    deleteLine(editor, now, scope);
    return 'cut';
  } finally {
    held.release();
  }
}

/** The clipboard's HTML and plain text, as an async read hands them. */
interface ClipboardText {
  readonly html: string;
  readonly plain: string;
}

/**
 * Reads the clipboard's HTML and plain text. Chromium hands HTML cleaned
 * (styles dropped, CSS inlined) unless asked for it as written, which is what
 * a paste event hands; other engines ignore the request.
 * @returns The text, or null when the read is refused.
 */
async function readClipboard(): Promise<ClipboardText | null> {
  try {
    // `unsanitized` is in the Clipboard API spec but not yet in TypeScript's DOM types.
    const read = navigator.clipboard.read.bind(navigator.clipboard) as (options: { unsanitized: readonly string[] }) => Promise<ClipboardItems>;
    const items = await read({ unsanitized: ['text/html'] });
    let html = '';
    let plain = '';
    for (const item of items) {
      if (html === '' && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (plain === '' && item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
    }
    return { html, plain };
  } catch {
    return null;
  }
}

/**
 * One type of the clipboard, as a paste event's data hands it.
 * @param type - The type.
 * @param value - Its text.
 * @returns The transfer.
 */
function transferOf(type: 'text/html' | 'text/plain', value: string): Transfer {
  return { types: [type], getData: (asked: string) => (asked === type ? value : '') };
}

/**
 * The one table the clipboard holds, read as Cmd+V reads it. The HTML is read
 * alone: with the plain text beside it, the Markdown table we copy as plain
 * text would be read in its place and flatten the cells' blocks
 * (`document-paste-read.ts`). The plain text is read alone after, for a
 * Markdown table copied as its source, whose HTML is a code block.
 * @param editor - The editor.
 * @param pasted - How pasted media are judged.
 * @param text - The clipboard.
 * @returns The table and how many media reading left out, or null.
 */
function clipboardTable(editor: LineEditor, pasted: PastedMediaJudge, text: ClipboardText): { table: PMNode; lost: number } | null {
  const schema = viewOf(editor).state.schema;
  for (const [type, value] of [['text/html', text.html], ['text/plain', text.plain]] as const) {
    if (value === '') continue;
    const read = readTransfer(editor, transferOf(type, value), pasted.lands);
    const table = judgedTable(read, pasted.judge, schema);
    if (table !== null) return { table, lost: read.lost };
  }
  return null;
}

/**
 * Inserts the clipboard's table as new rows or columns beside the menu's cell.
 * @param editor - The editor.
 * @param cellPos - The menu's cell.
 * @param side - Where they go.
 * @returns How it ended.
 * @throws {Error} When the editor judges no pasted media.
 */
export async function pasteTableLines(editor: LineEditor, cellPos: number, side: PasteSide): Promise<PasteOutcome> {
  const view = viewOf(editor);
  const rows = side === 'above' || side === 'below';
  if (!canDragFrom(view.state.doc, cellPos, rows ? 'row' : 'column')) return 'merged';
  const pasted = editor.getExtension(PASTED_MEDIA_KEY) as PastedMediaJudge | undefined;
  if (pasted === undefined) throw new Error('the document editor judges no pasted media');
  const held = holdPendingCell(view, cellPos);
  try {
    const text = await readClipboard();
    if (text === null) return 'unreadable';
    // The table may have changed while the clipboard was read; nothing is
    // judged (no upload queued, no medium counted) for a paste that cannot land.
    const now = held.now();
    if (now === null) return 'gone';
    if (!canDragFrom(view.state.doc, now, rows ? 'row' : 'column')) return 'merged';
    const found = clipboardTable(editor, pasted, text);
    if (found === null) return 'no-table';
    insertLinesOf(editor, now, side, found.table);
    pasted.leaveOut(found.lost);
    return 'pasted';
  } finally {
    held.release();
  }
}

/**
 * The first cell of a table block, for the table menu's copy and cut.
 * @param doc - The document.
 * @param blockId - The table block's id.
 * @returns The position before the cell, or null when no such table is there.
 */
export function firstCellOf(doc: PMNode, blockId: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.spec['tableRole'] === 'table' && node.attrs['id'] === blockId) found = pos + 2;
    return found === null;
  });
  return found;
}

/**
 * A row or a column, as an item for the Agent's tray.
 * @param editor - The editor.
 * @param cellPos - The menu's cell.
 * @param scope - Its row or its column.
 * @returns The item, or null where a merged cell reaches out of it.
 */
export function tableLineItem(editor: LineEditor, cellPos: number, scope: 'row' | 'column'): TrayItem | null {
  const cells = tableLineSelection(viewOf(editor).state.doc, cellPos, scope);
  return cells === null ? null : cellsItem(editor, cells);
}
