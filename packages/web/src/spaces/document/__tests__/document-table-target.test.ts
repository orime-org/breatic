// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 §5.0, A17: the cell a table menu was opened on follows every
 * change to the document, so the command lands on the row, column or cell the
 * reader chose; when that cell is gone the target is gone too.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { cellAt, deleteRowAt, insertColumn, insertRow, setCellsAttr } from '@web/spaces/document/document-table-run';
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens a mounted editor holding a paragraph and a 2 × 2 table.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
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
 * The text of the target cell.
 * @param editor - The editor.
 * @returns It, or null with no target.
 */
function targetText(editor: Editor): string | null {
  const pos = tableTargetOf(editor.prosemirrorState);
  return pos === null ? null : (editor.prosemirrorState.doc.nodeAt(pos)?.textContent ?? null);
}

describe('the target cell of a table menu', () => {
  it('is nothing until a menu sets it, and nothing once it clears it', () => {
    const editor = open();
    expect(tableTargetOf(editor.prosemirrorState)).toBeNull();

    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'b2'));
    expect(targetText(editor)).toBe('b2');

    setTableTarget(editor.prosemirrorView!, null);
    expect(tableTargetOf(editor.prosemirrorState)).toBeNull();
  });

  it('follows its cell when text is typed before the table', () => {
    const editor = open();
    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'b2'));
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.insertText('more text ', 1));

    expect(targetText(editor)).toBe('b2');
  });

  it('stays on its row when a row is added above it', () => {
    const editor = open();
    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'b2'));

    insertRow(editor, cellOf(editor, 'a1'), 'above');

    const pos = tableTargetOf(editor.prosemirrorState)!;
    expect(targetText(editor)).toBe('b2');
    expect(cellAt(editor.prosemirrorState.doc, pos)).toMatchObject({ top: 2, left: 1 });
  });

  it('stays on its cell when a column is added right before it', () => {
    const editor = open();
    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'b2'));

    insertColumn(editor, cellOf(editor, 'b2'), 'left');

    expect(targetText(editor)).toBe('b2');
  });

  it.each([
    ['fill', 'backgroundColor', 'red'],
    ['alignment', 'textAlignment', 'center'],
  ] as const)('stays on its cell when that cell takes a new %s', (_what, name, value) => {
    // The fill and alignment submenus stay open after a pick, so the next
    // pick has to reach the same cell.
    const editor = open();
    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'b2'));

    setCellsAttr(editor, cellOf(editor, 'b2'), 'cell', name, value);

    expect(targetText(editor)).toBe('b2');
  });

  it('is gone when its row is deleted', () => {
    const editor = open();
    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'b2'));

    deleteRowAt(editor, cellOf(editor, 'a2'));

    expect(tableTargetOf(editor.prosemirrorState)).toBeNull();
  });

  it('is gone when the table is deleted', () => {
    const editor = open();
    setTableTarget(editor.prosemirrorView!, cellOf(editor, 'a1'));

    editor.removeBlocks([(editor.document[1] as { id: string }).id]);

    expect(tableTargetOf(editor.prosemirrorState)).toBeNull();
  });
});
