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
import { CellSelection, columnResizingPluginKey, TableMap, updateColumnsOnResize } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { holdColumnWidths } from '@web/spaces/document/document-table-column-widths';
import { canDragFrom, startTableDrag } from '@web/spaces/document/document-table-drag';
import { squareTable } from '@web/spaces/document/document-table-nodes';
import { canMergeCells, headerOn, insertColumn } from '@web/spaces/document/document-table-run';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
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
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300 }));

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
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100 }));
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

describe('a short table evened by a command (A17)', () => {
  it('fills each short row at its end, where its missing cells are drawn', () => {
    for (const [rows, expected] of [
      [
        [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }],
        [['a1', 'b1', ''], ['a2', 'b2', 'c2']],
      ],
      [
        [{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2'] }, { cells: ['a3', 'b3'] }],
        [['a1', 'b1', 'c1'], ['a2', 'b2', ''], ['a3', 'b3', '']],
      ],
    ] as const) {
      const editor = open(rows as unknown as TableInput['rows']);
      const view = editor.prosemirrorView!;
      const tr = view.state.tr;
      squareTable(tr, tableOf(editor).pos);
      view.dispatch(tr);

      expect(grid(editor)).toEqual(expected);
      expect(TableMap.get(tableOf(editor).node).problems).toBeNull();
    }
  });

  it('gives a filled cell its column\'s width', () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2'] }], columnWidths: [100, 140] })] as never);
    const tr = editor.prosemirrorState.tr;
    squareTable(tr, tableOf(editor).pos);
    editor.prosemirrorView!.dispatch(tr);

    expect(tableOf(editor).node.child(1).child(1).attrs['colwidth']).toEqual([140]);
  });
});

describe('Tab at the end of a short row (A17)', () => {
  it('moves into the missing cell, evened, and adds no row', () => {
    const editor = open([{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2'] }]);
    caretIn(editor, 'b2');
    press(editor, 'Tab');

    expect(grid(editor)).toEqual([
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', ''],
    ]);
    const { node, pos } = tableOf(editor);
    const map = TableMap.get(node);
    const missing = pos + 1 + map.map[map.width + 2]!;
    const { $head } = editor.prosemirrorState.selection;
    expect($head.pos).toBeGreaterThan(missing);
    expect($head.pos).toBeLessThan(missing + node.nodeAt(map.map[map.width + 2]!)!.nodeSize);
  });
});

/**
 * A short table and the table it evens into, each in an editor of its own.
 * @param rows - The short table's rows.
 * @returns The two editors: the short one, then the even one.
 */
function shortAndEven(rows: TableInput['rows']): [Editor, Editor] {
  const width = Math.max(...rows.map((row) => row.cells.length));
  const even = rows.map((row) => ({ cells: [...row.cells, ...Array.from({ length: width - row.cells.length }, () => '')] }));
  return [open(rows), open(even)];
}

describe('cells pasted into a short table (A16, A17)', () => {
  /**
   * Copies two cells of a table and pastes them over a target, as the editor's
   * paste does.
   * @param editor - The editor.
   * @param target - Puts the selection the paste lands on.
   */
  function pasteCells(editor: Editor, target: (view: NonNullable<Editor['prosemirrorView']>) => void): void {
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'a3'), cellOf(editor, 'b3'))));
    const slice = view.state.selection.content();
    target(view);
    view.someProp('handlePaste', (handler) => handler(view, new Event('paste') as ClipboardEvent, slice));
  }

  it('land where they land in the table evened, with the caret in a short row', () => {
    for (const editor of shortAndEven([{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2'] }, { cells: ['a3', 'b3', 'c3'] }])) {
      pasteCells(editor, (view) => view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(cellOf(editor, 'a2') + 1)))));
    }
    const [short, even] = mounted.slice(-2) as [Editor, Editor];

    expect(grid(short)).toEqual(grid(even));
  });

  it('land where they land in the table evened, over cells selected across a short first row', () => {
    for (const editor of shortAndEven([{ cells: ['a1'] }, { cells: ['a2', 'b2', 'c2'] }, { cells: ['a3', 'b3', 'c3'] }])) {
      pasteCells(editor, (view) => {
        const map = TableMap.get(tableOf(editor).node);
        const start = tableOf(editor).pos + 1;
        view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'a1'), start + map.map[map.width + 1]!)));
      });
    }
    const [short, even] = mounted.slice(-2) as [Editor, Editor];

    expect(grid(short)).toEqual(grid(even));
  });
});

describe('table tools reading a short table (A17)', () => {
  it('offer merge over cells next to two missing ones', () => {
    const editor = open([{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2'] }, { cells: ['a3', 'b3', 'c3'] }]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'a1'), cellOf(editor, 'b3'))));

    expect(canMergeCells(view.state)).toBe(true);
  });

  it('show a short header row as a header row', () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [tableBlock({ rows: [{ cells: ['h1', 'h2'] }, { cells: ['a2', 'b2', 'c2'] }], headerRows: 1 })] as never);

    expect(headerOn(editor.prosemirrorState.doc, tableOf(editor).pos + 2, 'row')).toBe(true);
  });

  it('show a header column as one though a row holds no cells', () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [tableBlock({ rows: [{ cells: ['h1', 'a1'] }, { cells: [] }, { cells: ['h3', 'a3'] }], headerCols: 1 })] as never);

    expect(headerOn(editor.prosemirrorState.doc, tableOf(editor).pos + 2, 'column')).toBe(true);
  });

  it('insert a column beside the cell the menu was opened on', () => {
    const cases: [TableInput['rows'], string, 'left' | 'right'][] = [
      [[{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }], 'a2', 'left'],
      [[{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }], 'b2', 'right'],
      [[{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2'] }], 'c1', 'right'],
      [[{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2', 'c2'] }, { cells: ['a3', 'b3', 'c3'] }], 'a3', 'right'],
    ];
    for (const [rows, text, side] of cases) {
      const [short, even] = shortAndEven(rows);
      insertColumn(short, cellOf(short, text), side);
      insertColumn(even, cellOf(even, text), side);

      expect(grid(short)).toEqual(grid(even));
    }
  });
});

describe('arrow keys out of a short table that ends the body (A17)', () => {
  it('open a line below from the last cell in reading order, and from above a missing cell', () => {
    for (const [text, key] of [['a2', 'ArrowRight'], ['b1', 'ArrowDown']] as const) {
      const editor = open([{ cells: ['a1', 'b1'] }, { cells: ['a2'] }]);
      const view = editor.prosemirrorView!;
      const cell = cellOf(editor, text);
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(cell + view.state.doc.nodeAt(cell)!.nodeSize - 1), -1)));
      view.endOfTextblock = (): boolean => true;
      press(editor, key);

      expect(editor.document).toHaveLength(3);
      expect(headCell(editor)).toBe('');
    }
  });
});

describe('column widths of a table whose first row is short (A12, A17)', () => {
  const widthsShort: TableInput['rows'] = [
    { cells: [{ content: 'a1', props: { colwidth: [100] } }, { content: 'b1', props: { colwidth: [140] } }] },
    { cells: [{ content: 'a2', props: { colwidth: [100] } }, { content: 'b2', props: { colwidth: [140] } }, { content: 'c2', props: { colwidth: [260] } }] },
  ];

  it('draws a column for every column of the grid, at its stored width', () => {
    const editor = open(widthsShort);

    const cols = Array.from(editor.prosemirrorView!.dom.querySelectorAll('colgroup col'), (col) => (col as HTMLElement).style.width);
    expect(cols).toEqual(['100px', '140px', '260px']);
  });

  it('places a row\'s cells past a cell spanning it from above', () => {
    const editor = open([
      { cells: [{ content: 'a1', props: { rowspan: 2, colwidth: [100] } }, { content: 'b1', props: { colwidth: [140] } }] },
      { cells: [{ content: 'b2', props: { colwidth: [140] } }, { content: 'c2', props: { colwidth: [260] } }] },
    ]);

    const cols = Array.from(editor.prosemirrorView!.dom.querySelectorAll('colgroup col'), (col) => (col as HTMLElement).style.width);
    expect(cols).toEqual(['100px', '140px', '260px']);
  });

  it('reads a column\'s drawn width from a cell of that column alone, below a merged first row', () => {
    const editor = open([{ cells: [{ content: 'ab', props: { colspan: 2 } }] }, { cells: ['a2', 'b2'] }]);
    const view = editor.prosemirrorView!;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function width(this: HTMLElement) {
      return this.tagName === 'TD' ? 100 : 0;
    });
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellOf(editor, 'a2') }));
    view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 100 }));

    expect(view.state.doc.nodeAt(cellOf(editor, 'ab'))!.attrs['colwidth']).toEqual([100, 100]);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100 }));
  });

  it('draws every column while a column edge is dragged', () => {
    const editor = open(widthsShort);
    const table = editor.prosemirrorView!.dom.querySelector('table')!;
    updateColumnsOnResize(tableOf(editor).node, table.querySelector('colgroup')!, table, 25, 0, 120);

    const cols = Array.from(table.querySelectorAll('colgroup col'), (col) => (col as HTMLElement).style.width);
    expect(cols).toEqual(['120px', '140px', '260px']);
  });

  it('keeps the width repairs of a short table, which add no cell', () => {
    const editor = open([
      { cells: [{ content: 'a1', props: { colwidth: [300] } }, { content: 'b1', props: { colwidth: [300] } }, { content: 'c1', props: { colwidth: [300] } }] },
      { cells: ['a2', 'b2'] },
    ]);

    const row = tableOf(editor).node.child(1);
    expect([row.child(0).attrs['colwidth'], row.child(1).attrs['colwidth']]).toEqual([[300], [300]]);
    expect(row.childCount).toBe(2);
  });
});

describe('the kind of cell a short row lacks (A17)', () => {
  it('is a body cell beside a header column, and a header in a header row', () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2'] }], headerCols: 1 }),
      tableBlock({ rows: [{ cells: ['h1'] }, { cells: ['a2', 'b2'] }], headerRows: 1 }),
    ] as never);
    const kinds = (): string[][] => {
      const found: string[][] = [];
      editor.prosemirrorState.doc.descendants((node) => {
        if (node.type.name === 'docTableRow') {
          const row: string[] = [];
          node.forEach((cell) => row.push(cell.type.name));
          found.push(row);
          return false;
        }
        return true;
      });
      return found;
    };
    const missing = Array.from(editor.prosemirrorView!.dom.querySelectorAll('[data-doc-table-missing]'), (cell) => cell.tagName);
    expect(missing).toEqual(['TD', 'TH']);
    for (const block of [...editor.document].reverse()) {
      const tr = editor.prosemirrorState.tr;
      let pos = -1;
      tr.doc.descendants((node, at) => {
        if (pos < 0 && node.type.name === 'docTable' && (node.attrs['id'] as unknown) === (block as { id: string }).id) pos = at;
        return pos < 0;
      });
      squareTable(tr, pos);
      editor.prosemirrorView!.dispatch(tr);
    }

    expect(kinds()).toEqual([
      ['docTableHeader', 'docTableCell'],
      ['docTableHeader', 'docTableCell'],
      ['docTableHeader', 'docTableHeader'],
      ['docTableCell', 'docTableCell'],
    ]);
  });
});

describe('Markdown of a short table (A17)', () => {
  it('is an HTML table, so a header row shorter than the rest drops no cells', () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [tableBlock({ rows: [{ cells: ['h1', 'h2'] }, { cells: ['a2', 'b2', 'c2'] }], headerRows: 1 })] as never);

    const markdown = blocksMarkdown(editor as never, editor.document as never);
    expect(markdown).toContain('<table');
    expect(markdown).toContain('c2');
  });
});
