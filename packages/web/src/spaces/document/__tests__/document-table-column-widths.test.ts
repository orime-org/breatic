// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A12: dragging a column's edge changes that column only. Before
 * the drag, every column without a stored width takes the width it is drawn
 * at, so the dragged column grows the table rather than taking room from the
 * columns the browser was sizing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { holdColumnWidths } from '@web/spaces/document/document-table-column-widths';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding one table.
 * @param rows - The table's rows.
 * @param columnWidths - The widths stored for its columns, if any.
 * @returns The editor.
 */
function open(rows: unknown[], columnWidths?: (number | undefined)[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'table', content: { type: 'tableContent', rows, columnWidths } }] as never);
  return editor;
}

/**
 * Where the table node starts.
 * @param doc - The document.
 * @returns Its position.
 */
function tableOf(doc: PMNode): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'table') at = pos;
    return at < 0;
  });
  return at;
}

/**
 * Every cell's stored width, row by row.
 * @param doc - The document.
 * @returns The widths.
 */
function widths(doc: PMNode): unknown[][] {
  const out: unknown[][] = [];
  doc.nodeAt(tableOf(doc))!.forEach((row) => {
    const cells: unknown[] = [];
    row.forEach((cell) => cells.push(cell.attrs['colwidth']));
    out.push(cells);
  });
  return out;
}

describe('holding a table\'s column widths before a column is dragged (A12)', () => {
  it('gives every column the width it is drawn at', () => {
    const editor = open([{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2', 'c2'] }]);
    const state = editor.prosemirrorState;
    const tr = holdColumnWidths(state.tr, tableOf(state.doc), [120, 407, 120]);

    expect(widths(tr.doc)).toEqual([
      [[120], [407], [120]],
      [[120], [407], [120]],
    ]);
  });

  it('keeps a width already stored', () => {
    const editor = open([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }], [undefined, 300]);
    const state = editor.prosemirrorState;
    const tr = holdColumnWidths(state.tr, tableOf(state.doc), [140, 290]);

    expect(widths(tr.doc)).toEqual([
      [[140], [300]],
      [[140], [300]],
    ]);
  });

  it('gives a cell spanning two columns the width of each', () => {
    const editor = open([
      { cells: [{ type: 'tableCell', content: 'ab', props: { colspan: 2 } }] },
      { cells: ['a2', 'b2'] },
    ]);
    const state = editor.prosemirrorState;
    const tr = holdColumnWidths(state.tr, tableOf(state.doc), [150, 200]);

    expect(widths(tr.doc)).toEqual([[[150, 200]], [[150], [200]]]);
  });

  it('changes nothing when every column already has its width', () => {
    const editor = open([{ cells: ['a'] }], [100]);
    const state = editor.prosemirrorState;

    expect(holdColumnWidths(state.tr, tableOf(state.doc), [100]).docChanged).toBe(false);
  });
});
