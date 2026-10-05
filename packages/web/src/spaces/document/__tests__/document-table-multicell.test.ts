// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A9: with several cells selected, the bubble bar's styles reach
 * the words in every one of them, not only in the cell the selection ended in.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { alignFace, MIXED_ALIGNMENT, runAlignment } from '@web/spaces/document/document-align-run';
import { setColour } from '@web/spaces/document/document-colour-run';
import { canLinkSpan } from '@web/spaces/document/document-link';
import {
  canMergeCells,
  cellFillFace,
  mergeSelectedCells,
  setCellFill,
} from '@web/spaces/document/document-table-run';
import { everyRunCarries, markTypeOf } from '@web/spaces/document/document-style-range';
import { writeStyle } from '@web/spaces/document/document-style-write';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens a mounted editor holding a 2 × 2 table.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] },
    },
  ] as never);
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
 * Selects the cells from one to another.
 * @param editor - The editor.
 * @param anchor - The anchor cell's text.
 * @param head - The head cell's text.
 */
function selectCells(editor: Editor, anchor: string, head: string): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(
      CellSelection.create(view.state.doc, cellOf(editor, anchor), cellOf(editor, head)),
    ),
  );
}

/**
 * The marks on each cell's text, by cell text.
 * @param editor - The editor.
 * @returns Mark names per cell.
 */
function marksByCell(editor: Editor): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'tableCell') {
      const names = new Set<string>();
      node.descendants((child) => {
        child.marks.forEach((mark) => names.add(mark.type.name));
      });
      out[node.textContent] = [...names].sort();
      return false;
    }
    return true;
  });
  return out;
}

describe('styles over several selected cells (A9)', () => {
  it('bold reaches every selected cell', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b2');

    writeStyle(editor, true, ['bold']);

    expect(marksByCell(editor)).toEqual({ a1: ['bold'], b1: ['bold'], a2: ['bold'], b2: ['bold'] });
  });

  it('reads as on only when every selected cell carries it', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const a1 = cellOf(editor, 'a1') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a1, a1 + 2)));
    writeStyle(editor, true, ['bold']);

    selectCells(editor, 'a1', 'b2');
    const state = editor.prosemirrorState;
    expect(everyRunCarries(state, markTypeOf(state, 'bold')!)).toBe(false);
  });

  it('a text colour reaches every selected cell', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b1');

    setColour(editor, 'textColor', 'blue');

    expect(marksByCell(editor)).toEqual({ a1: ['textColor'], b1: ['textColor'], a2: [], b2: [] });
  });
});

/**
 * One attribute of every cell, by cell text.
 * @param editor - The editor.
 * @param name - The attribute.
 * @returns The values.
 */
function cellAttr(editor: Editor, name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'tableCell') {
      out[node.textContent] = node.attrs[name];
      return false;
    }
    return true;
  });
  return out;
}

describe('the bubble bar over cells (A9)', () => {
  it('aligns the selected cells and reads their alignment', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b1');

    runAlignment(editor, 'center');

    expect(cellAttr(editor, 'textAlignment')).toEqual({ a1: 'center', b1: 'center', a2: 'left', b2: 'left' });
    expect(alignFace(editor)).toBe('center');
    selectCells(editor, 'a1', 'a2');
    expect(alignFace(editor)).toBe(MIXED_ALIGNMENT);
  });

  it('aligns the one cell a text selection sits in', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const b2 = cellOf(editor, 'b2') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, b2, b2 + 1)));

    runAlignment(editor, 'right');

    expect(cellAttr(editor, 'textAlignment')).toEqual({ a1: 'left', b1: 'left', a2: 'left', b2: 'right' });
  });

  it('fills the selected cells and reads their fill', () => {
    const editor = open();
    selectCells(editor, 'a2', 'b2');
    expect(cellFillFace(editor.prosemirrorState)).toBe('none');

    setCellFill(editor, 'green');
    expect(cellAttr(editor, 'backgroundColor')).toEqual({ a1: 'default', b1: 'default', a2: 'green', b2: 'green' });
    expect(cellFillFace(editor.prosemirrorState)).toBe('green');

    setCellFill(editor, undefined);
    expect(cellAttr(editor, 'backgroundColor')).toEqual({ a1: 'default', b1: 'default', a2: 'default', b2: 'default' });
  });

  it('has no cell fill to offer outside a table', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(cellFillFace(editor.prosemirrorState)).toBeUndefined();
  });

  it('greys the link over several cells', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b1');
    const state = editor.prosemirrorState;
    expect(canLinkSpan(state, state.selection.from, state.selection.to)).toBe(false);
  });
});

describe('merging the selected cells (A10)', () => {
  it('offers to merge only over two cells or more', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const b2 = cellOf(editor, 'b2') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, b2)));
    expect(canMergeCells(editor.prosemirrorState)).toBe(false);

    selectCells(editor, 'a1', 'b1');
    expect(canMergeCells(editor.prosemirrorState)).toBe(true);
  });

  it('keeps the words of every cell in the merged cell, in reading order', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b2');

    mergeSelectedCells(editor);

    const lines: string[] = [];
    let cells = 0;
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'tableCell') cells += 1;
      if (node.type.name === 'tableParagraph') lines.push(node.textContent);
      return true;
    });
    expect(cells).toBe(1);
    expect(lines.join(' ')).toBe('a1 b1 a2 b2');
  });
});
