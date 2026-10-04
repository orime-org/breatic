// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A15: Backspace and Delete over selected cells empty them; over
 * every cell of a table that is already empty they take the table away; one
 * undo brings either back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens an editor with undo tracking, holding a paragraph and a 2 × 2 table.
 * @param cells - The four cells' text.
 * @returns The editor and its undo manager.
 */
function open(cells: readonly [string, string, string, string]): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
    {
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: [cells[0], cells[1]] }, { cells: [cells[2], cells[3]] }] },
    },
  ] as never);
  manager.stopCapturing();
  return { editor, manager };
}

/**
 * Selects every cell of the table, or the first row only.
 * @param editor - The editor.
 * @param all - Every cell, or the first row.
 */
function selectCells(editor: Editor, all: boolean): void {
  const cells: number[] = [];
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cells.push(pos);
    return true;
  });
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, all ? cells[3]! : cells[1]!)),
  );
}

/**
 * Presses a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @returns Whether a handler claimed it.
 */
function press(editor: Editor, key: string): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/**
 * The top-level block types.
 * @param editor - The editor.
 * @returns Them.
 */
function types(editor: Editor): string[] {
  return (editor.document as unknown as { type: string }[]).map((block) => block.type);
}

/**
 * Every cell's text.
 * @param editor - The editor.
 * @returns Them, in order.
 */
function texts(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'tableCell') out.push(node.textContent);
    return true;
  });
  return out;
}

describe('deleting over selected cells (A15)', () => {
  it.each(['Backspace', 'Delete'])('%s empties the selected cells', (key) => {
    const { editor } = open(['a1', 'b1', 'a2', 'b2']);
    selectCells(editor, false);

    press(editor, key);

    expect(texts(editor)).toEqual(['', '', 'a2', 'b2']);
  });

  it.each(['Backspace', 'Delete'])('%s over a whole empty table takes it away, and undo brings it back', (key) => {
    const { editor, manager } = open(['', '', '', '']);
    selectCells(editor, true);

    press(editor, key);
    expect(types(editor)).toEqual(['paragraph']);

    manager.undo();
    expect(types(editor)).toEqual(['paragraph', 'table']);
  });

  it('keeps a table whose cells are not all selected', () => {
    const { editor } = open(['', '', '', '']);
    selectCells(editor, false);

    press(editor, 'Delete');

    expect(types(editor)).toEqual(['paragraph', 'table']);
  });
});
