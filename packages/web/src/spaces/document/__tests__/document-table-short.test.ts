// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A17: a table with a row short of cells stays short until a
 * command acts on it, and everything that reads the table's grid meanwhile
 * treats the missing cell as no cell. The table map holds 0 there, which is
 * the offset of the first row, not of a cell.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection, columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { holdColumnWidths } from '@web/spaces/document/document-table-column-widths';
import { canDragFrom, startTableDrag } from '@web/spaces/document/document-table-drag';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Opens an editor on one table with the rows given, short ones included.
 * @param rows - The rows.
 * @returns The editor.
 */
function open(rows: TableInput['rows']): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'lead' }, tableBlock({ rows })] as never);
  return editor;
}

/**
 * The table and where it stands.
 * @param editor - The editor.
 * @returns The table node and the position before it.
 */
function tableOf(editor: Editor): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found === null && node.type.name === 'docTable') found = { node, pos };
    return found === null;
  });
  return found!;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - Its words.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'docTableCell' && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The table as cell texts, each row as many cells as it has.
 * @param editor - The editor.
 * @returns One array per row.
 */
function grid(editor: Editor): string[][] {
  const rows: string[][] = [];
  tableOf(editor).node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
}

/**
 * Sends a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @param shiftKey - Whether Shift is held.
 */
function press(editor: Editor, key: string, shiftKey = false): void {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
}

/**
 * Puts the caret in a cell, on its last line.
 * @param editor - The editor.
 * @param text - The cell's words.
 */
function caretIn(editor: Editor, text: string): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(cellOf(editor, text) + 1))));
  // jsdom has no layout: the caret is on the cell's last line.
  view.endOfTextblock = (): boolean => true;
}

/**
 * The words of the cell the caret or a cell selection's head is in.
 * @param editor - The editor.
 * @returns The words.
 */
function headCell(editor: Editor): string {
  const { selection } = editor.prosemirrorState;
  const $head = selection instanceof CellSelection ? selection.$headCell : selection.$head;
  if ($head.nodeAfter?.type.spec['tableRole'] === 'cell') return $head.nodeAfter.textContent;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    if ($head.node(depth).type.spec['tableRole'] === 'cell') return $head.node(depth).textContent;
  }
  return '';
}

/** A 3 × 3 table whose last row lacks its last cell. */
const LAST_ROW_SHORT: TableInput['rows'] = [
  { cells: ['a1', 'b1', 'c1'] },
  { cells: ['a2', 'b2', 'c2'] },
  { cells: ['a3', 'b3'] },
];

describe('cells selected across a missing cell (A17)', () => {
  it('cover only cells, so Backspace empties those and nothing else', () => {
    const editor = open(LAST_ROW_SHORT);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'c2'), cellOf(editor, 'b3'))));
    const covered: string[] = [];
    (view.state.selection as CellSelection).forEachCell((cell) => covered.push(cell.type.name));

    expect(covered).toEqual(['docTableCell', 'docTableCell', 'docTableCell']);
    press(editor, 'Backspace');
    expect(grid(editor)).toEqual([
      ['a1', 'b1', 'c1'],
      ['a2', '', ''],
      ['a3', ''],
    ]);
  });

  it('paint only cells', () => {
    const editor = open(LAST_ROW_SHORT);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'c2'), cellOf(editor, 'b3'))));

    const painted = Array.from(view.dom.querySelectorAll('.selectedCell'), (element) => element.tagName);
    expect(painted).toEqual(['TD', 'TD', 'TD']);
  });

  it('copy only cells', () => {
    const editor = open(LAST_ROW_SHORT);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'c2'), cellOf(editor, 'b3'))));
    const slice = view.state.selection.content();

    const roles: string[] = [];
    slice.content.forEach((row) => row.forEach((cell) => roles.push(String(cell.type.spec['tableRole']))));
    expect(roles).toEqual(['cell', 'cell', 'cell']);
    expect(slice.content.textBetween(0, slice.content.size)).not.toContain('a1');
  });

  it('take a whole column from the column\'s first cell, past a row short of it', () => {
    const editor = open([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }, { cells: ['a3', 'b3', 'c3'] }]);
    const column = CellSelection.colSelection(editor.prosemirrorState.doc.resolve(cellOf(editor, 'c3')));

    expect(column.$anchorCell.nodeAfter?.textContent).toBe('c2');
    expect(column.$headCell.nodeAfter?.textContent).toBe('c3');
  });
});

describe('arrow keys past a missing cell (A17)', () => {
  const MIDDLE_ROW_SHORT: TableInput['rows'] = [{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2'] }, { cells: ['a3', 'b3', 'c3'] }];

  it('move the caret down to the next cell of the column', () => {
    const editor = open(MIDDLE_ROW_SHORT);
    caretIn(editor, 'c1');
    press(editor, 'ArrowDown');

    expect(headCell(editor)).toBe('c3');
  });

  it('extend a cell selection down to the next cell of the column', () => {
    const editor = open(MIDDLE_ROW_SHORT);
    caretIn(editor, 'c1');
    press(editor, 'ArrowDown', true);

    expect(editor.prosemirrorState.selection).toBeInstanceOf(CellSelection);
    expect(headCell(editor)).toBe('c3');
  });
});

describe('a column edge dragged on a table with a missing cell (A12, A17)', () => {
  it('holds the width of each cell there is', () => {
    const editor = open(LAST_ROW_SHORT);
    const { pos } = tableOf(editor);
    const tr = holdColumnWidths(editor.prosemirrorState.tr, pos, [100, 110, 120]);

    const widths: unknown[][] = [];
    tr.doc.nodeAt(pos)!.forEach((row) => {
      const cells: unknown[] = [];
      row.forEach((cell) => cells.push(cell.attrs['colwidth']));
      widths.push(cells);
    });
    expect(widths).toEqual([
      [[100], [110], [120]],
      [[100], [110], [120]],
      [[100], [110]],
    ]);
  });

  it('sets the column\'s width and lets the next drag start', () => {
    const editor = open(LAST_ROW_SHORT);
    const view = editor.prosemirrorView!;
    const handle = cellOf(editor, 'c1');
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: handle }));
    view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 100 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300 }));

    expect(columnResizingPluginKey.getState(view.state)?.dragging).toBeFalsy();
    expect(view.state.doc.nodeAt(cellOf(editor, 'c1'))!.attrs['colwidth']).not.toBeNull();
    expect(view.state.doc.nodeAt(cellOf(editor, 'c2'))!.attrs['colwidth']).toEqual(view.state.doc.nodeAt(cellOf(editor, 'c1'))!.attrs['colwidth']);
  });

  it('holds each column at a cell\'s drawn width, though the first row lacks that column', () => {
    const editor = open([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }]);
    const view = editor.prosemirrorView!;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function width(this: HTMLElement) {
      return this.tagName === 'TR' ? 300 : 100;
    });
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellOf(editor, 'a1') }));
    view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 100 }));

    expect(view.state.doc.nodeAt(cellOf(editor, 'c2'))!.attrs['colwidth']).toEqual([100]);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100 }));
  });

  it('draws the resize handle only in cells', () => {
    const editor = open(LAST_ROW_SHORT);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellOf(editor, 'c1') }));

    const handles = Array.from(view.dom.querySelectorAll('.column-resize-handle'));
    expect(handles).toHaveLength(2);
    expect(handles.every((element) => element.closest('td, th') !== null)).toBe(true);
  });
});

describe('dragging a line of a table with a missing cell (A7, A17)', () => {
  it('can start from any row and any column', () => {
    const editor = open([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }, { cells: ['a3', 'b3', 'c3'] }]);
    const doc = editor.prosemirrorState.doc;

    for (const text of ['a1', 'a2', 'a3', 'c3']) {
      expect(canDragFrom(doc, cellOf(editor, text), 'row')).toBe(true);
      expect(canDragFrom(doc, cellOf(editor, text), 'column')).toBe(true);
    }
  });

  it('reads each column\'s edges from a cell of that column, though the first row lacks one', () => {
    const editor = open([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }, { cells: ['a3', 'b3', 'c3'] }]);
    const view = editor.prosemirrorView!;
    vi.spyOn(HTMLTableCellElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLTableCellElement) {
      const i = [...this.parentElement!.children].indexOf(this);
      return { top: 0, bottom: 30, left: i * 100, right: (i + 1) * 100 } as DOMRect;
    });
    const frame = view.dom.querySelector('table')!.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (frame !== null) frame.getBoundingClientRect = (): DOMRect => ({ top: 0, bottom: 90, left: 0, right: 300 }) as DOMRect;
    startTableDrag(view, 'column', cellOf(editor, 'a2'));
    const cell = view.nodeDOM(cellOf(editor, 'b2')) as Element;
    cell.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 205, clientY: 10 }));
    cell.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 205, clientY: 10 }));

    expect(grid(editor)[1]).toEqual(['b2', 'a2', 'c2']);
  });
});

describe('a table short of cells, before any command', () => {
  it('stays short in the document', () => {
    const editor = open(LAST_ROW_SHORT);

    expect(TableMap.get(tableOf(editor).node).problems).not.toBeNull();
  });
});
