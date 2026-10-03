// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A7 and A17: dragging a row or a column to a gap moves it there,
 * with its words, styles and comments; the row a drag started on is followed
 * through other people's edits; a row a merged cell spans cannot be dragged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  canDragFrom,
  dragSourceOf,
  dropGapAt,
  moveToGap,
  startTableDrag,
} from '@web/spaces/document/document-table-drag';
import { insertRow } from '@web/spaces/document/document-table-run';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding a paragraph and a 3 × 3 table, or the rows given.
 * @param rows - The table's rows.
 * @returns The editor.
 */
function open(
  rows: unknown[] = [
    { cells: ['a1', 'b1', 'c1'] },
    { cells: ['a2', 'b2', 'c2'] },
    { cells: ['a3', 'b3', 'c3'] },
  ],
): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'reader' },
    { type: 'table', content: { type: 'tableContent', rows } },
  ] as never);
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
  return editor;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'tableCell' && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The table as cell texts.
 * @param editor - The editor.
 * @returns One array per row.
 */
function grid(editor: Editor): string[][] {
  const rows: string[][] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
      return false;
    }
    return true;
  });
  return rows;
}

describe('which gap the pointer is over', () => {
  // Three rows, 30 tall, from 100.
  const edges = [100, 130, 160, 190];

  it.each([
    [101, 0],
    [114, 0],
    [116, 1],
    [140, 1],
    [146, 2],
    [189, 3],
    [250, 3],
    [40, 0],
  ])('at %d it is gap %d', (pointer, gap) => {
    expect(dropGapAt(edges, pointer)).toBe(gap);
  });
});

describe('moving a row or a column to a gap (A7)', () => {
  it.each([
    [0, 3, [['a2', 'b2', 'c2'], ['a3', 'b3', 'c3'], ['a1', 'b1', 'c1']]],
    [2, 0, [['a3', 'b3', 'c3'], ['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]],
    [1, 1, [['a1', 'b1', 'c1'], ['a2', 'b2', 'c2'], ['a3', 'b3', 'c3']]],
    [1, 2, [['a1', 'b1', 'c1'], ['a2', 'b2', 'c2'], ['a3', 'b3', 'c3']]],
  ] as const)('row %d to gap %d', (row, gap, expected) => {
    const editor = open();
    const source = cellOf(editor, ['a1', 'a2', 'a3'][row]!);

    moveToGap(editor, source, 'row', gap);

    expect(grid(editor)).toEqual(expected);
  });

  it('moves a column', () => {
    const editor = open();

    moveToGap(editor, cellOf(editor, 'a1'), 'column', 2);

    expect(grid(editor)).toEqual([
      ['b1', 'a1', 'c1'],
      ['b2', 'a2', 'c2'],
      ['b3', 'a3', 'c3'],
    ]);
  });

  it('carries the marks on the words and leaves the reader where they were', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const b1 = cellOf(editor, 'b1') + 2;
    view.dispatch(view.state.tr.addMark(b1, b1 + 2, view.state.schema.marks['bold']!.create()));

    moveToGap(editor, cellOf(editor, 'a1'), 'row', 3);

    let bold = '';
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'bold')) bold = node.text ?? '';
      return true;
    });
    expect(bold).toBe('b1');
    expect(grid(editor)[2]).toEqual(['a1', 'b1', 'c1']);
    const { selection } = editor.prosemirrorState;
    expect([selection.$head.parent.textContent, selection.$head.parentOffset]).toEqual(['reader', 3]);
  });
});

describe('the row a drag started on', () => {
  it('is followed when a row lands above it during the drag (A17)', () => {
    const editor = open();
    startTableDrag(editor.prosemirrorView!, 'row', cellOf(editor, 'a2'));

    insertRow(editor, cellOf(editor, 'a1'), 'above');
    const source = dragSourceOf(editor.prosemirrorState)!;
    moveToGap(editor, source.cellPos, 'row', 0);

    expect(grid(editor)[0]).toEqual(['a2', 'b2', 'c2']);
  });

  it('cannot be a row a merged cell spans', () => {
    const editor = open([
      { cells: [{ type: 'tableCell', content: 'tall', props: { rowspan: 2 } }, 'b1'] },
      { cells: ['b2'] },
    ]);
    expect(canDragFrom(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'row')).toBe(false);
    expect(canDragFrom(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'column')).toBe(true);
  });
});
