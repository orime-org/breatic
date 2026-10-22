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
  TABLE_CONTROL,
  type TableHandlesState,
} from '@web/spaces/document/document-table-handles';
import { STRIP_SIZE, TABLE_STRIP_OUTSET, tableStripLeft } from '@web/spaces/document/document-strip-alignment';
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
function pointAt(editor: Editor, words: string, buttons = 0): void {
  wordsOf(editor, words).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10, buttons }));
}

/**
 * The element holding some words.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The element.
 */
function wordsOf(editor: Editor, words: string): Element {
  return [...editor.prosemirrorView.dom.querySelectorAll('*')].find(
    (el) => el.childElementCount === 0 && el.textContent === words,
  )!;
}

/**
 * The id of the table block.
 * @param editor - The editor.
 * @returns The id.
 */
function tableId(editor: Editor): string {
  return (editor.document as { id: string; type: string }[]).find((block) => block.type === 'docTable')!.id;
}

/**
 * The position before the cell holding some words.
 * @param editor - The editor.
 * @param words - The cell's words.
 * @returns The position.
 */
function cellPos(editor: Editor, words: string): number {
  let at = -1;
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'docTableCell' && node.textContent === words) at = pos;
    return at < 0;
  });
  return at;
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

  it('is gone once the pointer leaves the body (inner#1402)', () => {
    const editor = open();
    pointAt(editor, 'a1');

    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 900, clientY: 900 }));

    expect(hovered(editor)?.show).toBe(false);
  });

  it('stays while the pointer is on a table control outside the body', () => {
    const editor = open();
    pointAt(editor, 'a1');
    const control = document.createElement('div');
    control.setAttribute(TABLE_CONTROL, '');
    document.body.appendChild(control);

    control.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 900, clientY: 900 }));

    expect(hovered(editor)).toMatchObject({ show: true, rowIndex: 0, colIndex: 0 });
  });

  it('comes back over the still copy a closing control leaves, read off the pointer\'s place', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dom.querySelector('tbody')!.getBoundingClientRect = () => new DOMRect(200, 100, 240, 80);
    view.dom.querySelector('[data-node-type="docTable"]')!.getBoundingClientRect = () => new DOMRect(200, 96, 600, 88);
    pointAt(editor, 'a1');
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 900, clientY: 900 }));
    const copy = document.createElement('div');
    copy.setAttribute(TABLE_CONTROL, '');
    document.body.appendChild(copy);

    copy.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 120 }));

    expect(hovered(editor)).toMatchObject({ show: true, block: { id: tableId(editor) }, rowIndex: undefined });
  });

  it('names the position before the cell, and follows it through an edit above', () => {
    const editor = open();
    pointAt(editor, 'b2');
    const before = cellPos(editor, 'b2');
    expect(hovered(editor)?.cellPos).toBe(before);

    editor.insertBlocks([{ type: 'paragraph', content: 'more' }] as never, editor.document[0]!, 'before');

    expect(hovered(editor)?.cellPos).toBe(cellPos(editor, 'b2'));
    expect(cellPos(editor, 'b2')).not.toBe(before);
  });

  it('reads nothing while the handles are hidden, whatever changes in the document', () => {
    const editor = open();
    pointAt(editor, 'a1');
    pointAt(editor, 'lead');
    const hidden = hovered(editor);

    editor.insertBlocks([{ type: 'paragraph', content: 'more' }] as never, editor.document[0]!, 'after');

    expect(hovered(editor)).toBe(hidden);
  });

  it('names the table, and no row or column, with the pointer in the gutter beside it (user 2026-10-21)', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dom.querySelector('tbody')!.getBoundingClientRect = () => new DOMRect(200, 100, 240, 80);
    view.dom.querySelector('[data-node-type="docTable"]')!.getBoundingClientRect = () => new DOMRect(200, 96, 600, 88);

    view.dom.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 120 }));

    expect(hovered(editor)).toMatchObject({ show: true, block: { id: tableId(editor) }, rowIndex: undefined, colIndex: undefined });
  });

  it('names a table nested two levels deep with the pointer where its strip stands', () => {
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
      extensions: [documentTableHandlesExtension()],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      {
        type: 'paragraph',
        content: 'outer',
        children: [{ type: 'paragraph', content: 'inner', children: [tableBlock({ rows: [{ cells: ['a1', 'b1'] }] })] }],
      },
    ] as never);
    const view = editor.prosemirrorView;
    // The body's edge at 100, the table two 24px indent steps in at 148.
    (view.dom.firstElementChild as HTMLElement).getBoundingClientRect = () => new DOMRect(100, 0, 600, 400);
    view.dom.querySelector('tbody')!.getBoundingClientRect = () => new DOMRect(148, 100, 200, 60);
    const frame = view.dom.querySelector('[data-node-type="docTable"]')!;
    frame.getBoundingClientRect = () => new DOMRect(148, 96, 552, 68);
    const strip = tableStripLeft(view.dom)!;

    view.dom.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: strip + 1, clientY: 120 }));

    expect(strip).toBe(100 - TABLE_STRIP_OUTSET - STRIP_SIZE);
    expect(hovered(editor)).toMatchObject({ show: true, block: { id: frame.getAttribute('data-id') }, rowIndex: undefined });
  });

  it('is gone with the pointer in the gutter beside no table', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dom.querySelector('tbody')!.getBoundingClientRect = () => new DOMRect(200, 100, 240, 80);
    view.dom.querySelector('[data-node-type="docTable"]')!.getBoundingClientRect = () => new DOMRect(200, 96, 600, 88);
    pointAt(editor, 'a1');

    view.dom.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 300 }));

    expect(hovered(editor)?.show).toBe(false);
  });

  it('is gone while a press in a cell drags a selection', () => {
    const editor = open();
    pointAt(editor, 'a1');
    wordsOf(editor, 'a1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));

    pointAt(editor, 'b2', 1);

    expect(hovered(editor)?.show).toBe(false);
  });

  it('comes back on the next move after a drag the browser ended without a release', () => {
    const editor = open();
    wordsOf(editor, 'a1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    wordsOf(editor, 'a1').dispatchEvent(new Event('dragend', { bubbles: true }));

    pointAt(editor, 'b2');

    expect(hovered(editor)).toMatchObject({ show: true, rowIndex: 1, colIndex: 1 });
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
