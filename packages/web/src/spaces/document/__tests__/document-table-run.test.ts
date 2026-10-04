// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 §5.0 and A6, A11: every command on a table acts on the cell
 * the menu was opened on, writes in place, and leaves the reader's caret where
 * it was.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  cellAt,
  deleteColumnAt,
  deleteRowAt,
  headerOn,
  insertColumn,
  insertRow,
  setCellsAttr,
  toggleHeaderAt,
} from '@web/spaces/document/document-table-run';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens a mounted editor holding a paragraph and a 2 × 3 table.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'reader' },
    {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2', 'c2'] }],
      },
    },
  ] as never);
  // The reader's caret, in the paragraph, after "rea".
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
  return editor;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The cell's text.
 * @returns The position before the cell node.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && (node.type.name === 'tableCell' || node.type.name === 'tableHeader') && node.textContent === text) {
      at = pos;
    }
    return at < 0;
  });
  if (at < 0) throw new Error(`no cell "${text}"`);
  return at;
}

/**
 * The table, as cell texts, header cells marked with `#`.
 * @param editor - The editor.
 * @returns One array per row.
 */
function grid(editor: Editor): string[][] {
  let table: PMNode | null = null;
  editor.prosemirrorState.doc.descendants((node) => {
    if (table === null && node.type.name === 'table') table = node;
    return table === null;
  });
  if (table === null) return [];
  const rows: string[][] = [];
  (table as PMNode).forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(`${cell.type.name === 'tableHeader' ? '#' : ''}${cell.textContent}`));
    rows.push(cells);
  });
  return rows;
}

/**
 * Whether the reader's caret is still after "rea" in the paragraph.
 * @param editor - The editor.
 * @returns True when it is.
 */
function readerKept(editor: Editor): boolean {
  const { selection } = editor.prosemirrorState;
  return selection.empty && selection.$head.parent.textContent === 'reader' && selection.$head.parentOffset === 3;
}

describe('finding the cell a command acts on', () => {
  it('reads the row and column of a cell', () => {
    const editor = open();
    expect(cellAt(editor.prosemirrorState.doc, cellOf(editor, 'b2'))).toMatchObject({ top: 1, left: 1 });
  });

  it('answers nothing for a position that is not a cell', () => {
    const editor = open();
    expect(cellAt(editor.prosemirrorState.doc, 1)).toBeNull();
  });
});

describe('rows and columns off the handles (A6)', () => {
  it.each([
    ['above', [['', '', ''], ['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]],
    ['below', [['a1', 'b1', 'c1'], ['', '', ''], ['a2', 'b2', 'c2']]],
  ] as const)('inserts a row %s the target', (side, expected) => {
    const editor = open();
    insertRow(editor, cellOf(editor, 'b1'), side);
    expect(grid(editor)).toEqual(expected);
    expect(readerKept(editor)).toBe(true);
  });

  it.each([
    ['left', [['a1', '', 'b1', 'c1'], ['a2', '', 'b2', 'c2']]],
    ['right', [['a1', 'b1', '', 'c1'], ['a2', 'b2', '', 'c2']]],
  ] as const)('inserts a column to the %s of the target', (side, expected) => {
    const editor = open();
    insertColumn(editor, cellOf(editor, 'b2'), side);
    expect(grid(editor)).toEqual(expected);
    expect(readerKept(editor)).toBe(true);
  });

  it('deletes the target row and the target column', () => {
    const editor = open();
    deleteRowAt(editor, cellOf(editor, 'a2'));
    expect(grid(editor)).toEqual([['a1', 'b1', 'c1']]);
    deleteColumnAt(editor, cellOf(editor, 'b1'));
    expect(grid(editor)).toEqual([['a1', 'c1']]);
    expect(readerKept(editor)).toBe(true);
  });

  it('deletes the whole table with its last row or its last column', () => {
    const rows = open();
    deleteRowAt(rows, cellOf(rows, 'a1'));
    deleteRowAt(rows, cellOf(rows, 'a2'));
    expect(grid(rows)).toEqual([]);
    expect((rows.document as unknown as { type: string }[]).map((b) => b.type)).toEqual(['paragraph']);

    const cols = open();
    deleteColumnAt(cols, cellOf(cols, 'a1'));
    deleteColumnAt(cols, cellOf(cols, 'b1'));
    deleteColumnAt(cols, cellOf(cols, 'c1'));
    expect(grid(cols)).toEqual([]);
  });

  it('turns the first row into headers and back', () => {
    const editor = open();
    expect(headerOn(editor.prosemirrorState.doc, cellOf(editor, 'a1'), 'row')).toBe(false);

    toggleHeaderAt(editor, cellOf(editor, 'b1'), 'row');
    expect(grid(editor)).toEqual([['#a1', '#b1', '#c1'], ['a2', 'b2', 'c2']]);
    expect(headerOn(editor.prosemirrorState.doc, cellOf(editor, '#a1'.slice(1)), 'row')).toBe(true);
    expect(readerKept(editor)).toBe(true);

    toggleHeaderAt(editor, cellOf(editor, 'a1'), 'row');
    expect(grid(editor)).toEqual([['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]);
  });

  it('turns the first column into headers', () => {
    const editor = open();
    toggleHeaderAt(editor, cellOf(editor, 'a2'), 'column');
    expect(grid(editor)).toEqual([['#a1', 'b1', 'c1'], ['#a2', 'b2', 'c2']]);
  });
});

describe('cell attributes off the handles and the cell button (A6, A11)', () => {
  /**
   * One attribute of every cell, row by row.
   * @param editor - The editor.
   * @param name - The attribute.
   * @returns The values.
   */
  function attrs(editor: Editor, name: string): unknown[][] {
    const out: unknown[][] = [];
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'tableRow') {
        const row: unknown[] = [];
        node.forEach((cell) => row.push(cell.attrs[name]));
        out.push(row);
        return false;
      }
      return true;
    });
    return out;
  }

  it('aligns every cell of the row, of the column, or the one cell', () => {
    const editor = open();
    setCellsAttr(editor, cellOf(editor, 'b1'), 'row', 'textAlignment', 'center');
    setCellsAttr(editor, cellOf(editor, 'c2'), 'column', 'textAlignment', 'right');
    setCellsAttr(editor, cellOf(editor, 'a2'), 'cell', 'textAlignment', 'center');
    expect(attrs(editor, 'textAlignment')).toEqual([
      ['center', 'center', 'right'],
      ['center', 'left', 'right'],
    ]);
    expect(readerKept(editor)).toBe(true);
  });

  it('writes every cell even when the target already has the value', () => {
    const editor = open();
    setCellsAttr(editor, cellOf(editor, 'a1'), 'cell', 'backgroundColor', 'blue');
    setCellsAttr(editor, cellOf(editor, 'a1'), 'row', 'backgroundColor', 'blue');
    expect(attrs(editor, 'backgroundColor')[0]).toEqual(['blue', 'blue', 'blue']);
  });
});
