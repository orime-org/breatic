// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 design 5.4 (A6): which cell of which table the pointer is over,
 * the state the row and column handles stand on. BlockNote's own table
 * handles know only its built-in table, so the layout table has its own.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  documentTableHandlesExtension,
  type TableHandlesState,
} from '@web/spaces/document/document-table-handles';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding a paragraph and a 2 × 2 table.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentTableHandlesExtension()],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'lead' },
    tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
  ] as never);
  return editor;
}

/**
 * The extension's state.
 * @param editor - The editor.
 * @returns The state.
 */
function hovered(editor: Editor): TableHandlesState | undefined {
  return editor.getExtension(documentTableHandlesExtension)!.store.state;
}

/**
 * Moves the pointer over the element holding some words.
 * @param editor - The editor.
 * @param words - The words.
 */
function pointAt(editor: Editor, words: string): void {
  const element = [...editor.prosemirrorView.dom.querySelectorAll('*')].find(
    (el) => el.childElementCount === 0 && el.textContent === words,
  )!;
  element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
}

/**
 * The id of the table block.
 * @param editor - The editor.
 * @returns The id.
 */
function tableId(editor: Editor): string {
  return (editor.document as { id: string; type: string }[]).find((block) => block.type === 'docTable')!.id;
}

describe('the cell the pointer is over', () => {
  it('names the table, the row and the column', () => {
    const editor = open();

    pointAt(editor, 'b2');

    expect(hovered(editor)).toMatchObject({ show: true, block: { id: tableId(editor) }, rowIndex: 1, colIndex: 1 });
  });

  it('is gone once the pointer leaves the table', () => {
    const editor = open();
    pointAt(editor, 'a1');

    pointAt(editor, 'lead');

    expect(hovered(editor)?.show).toBe(false);
  });

  it('reads nothing while the handles are hidden, whatever changes in the document', () => {
    const editor = open();
    pointAt(editor, 'a1');
    pointAt(editor, 'lead');
    const hidden = hovered(editor);

    editor.insertBlocks([{ type: 'paragraph', content: 'more' }] as never, editor.document[0]!, 'after');

    expect(hovered(editor)).toBe(hidden);
  });

  it('stays on its cell while frozen', () => {
    const editor = open();
    pointAt(editor, 'a1');
    editor.getExtension(documentTableHandlesExtension)!.freezeHandles();

    pointAt(editor, 'b2');

    expect(hovered(editor)).toMatchObject({ rowIndex: 0, colIndex: 0 });
    editor.getExtension(documentTableHandlesExtension)!.unfreezeHandles();
    pointAt(editor, 'b2');
    expect(hovered(editor)).toMatchObject({ rowIndex: 1, colIndex: 1 });
  });

  it('is none in a body that cannot be edited', () => {
    const editor = open();
    editor.isEditable = false;

    pointAt(editor, 'a1');

    expect(hovered(editor)?.show ?? false).toBe(false);
  });

  it('is cleared when the table is deleted', () => {
    const editor = open();
    pointAt(editor, 'a1');

    editor.removeBlocks([tableId(editor)]);

    expect(hovered(editor)).toBeUndefined();
  });

  it('moves to the last row when the row it was on is deleted', () => {
    const editor = open();
    pointAt(editor, 'b2');
    const view = editor.prosemirrorView;
    let lastRow = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'docTableRow') lastRow = pos;
      return true;
    });

    view.dispatch(view.state.tr.delete(lastRow, lastRow + view.state.doc.nodeAt(lastRow)!.nodeSize));

    expect(hovered(editor)).toMatchObject({ rowIndex: 0, colIndex: 1 });
  });
});
