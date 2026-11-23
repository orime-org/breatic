// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The table frame moves a new `<table>` into its scroller when the frame's
 * React root commits, after ProseMirror has written the selection into it.
 * A selection with any end in that table is the same once the frame has
 * moved it and ProseMirror has read the page selection back (inner#1125).
 */

import { act } from '@testing-library/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { para } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

/**
 * A focused editor holding a line, a 2x2 table and a line, with undo on.
 * @returns The editor, its view and its undo manager.
 */
function open(): { editor: Editor; view: EditorView; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    para('above'),
    tableBlock({ rows: [{ cells: ['aa', 'bb'] }, { cells: ['cc', 'dd'] }] }),
    para('below'),
  ] as never);
  manager.stopCapturing();
  const view = editor.prosemirrorView!;
  view.focus();
  return { editor, view, manager };
}

/** The position `offset` characters into the text node that reads `words`. */
function textAt(view: EditorView, words: string, offset: number): number {
  let found = -1;
  view.state.doc.descendants((node: PMNode, pos: number) => {
    if (found < 0 && node.isText && node.text === words) found = pos + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no text reads "${words}"`);
  return found;
}

/**
 * Deletes a selection taking the table with it, undoes it, lets the frame of
 * the table that comes back commit, and has ProseMirror read the page
 * selection.
 * @param view - The view.
 * @param manager - The undo manager.
 * @param anchor - Where the selection starts.
 * @param head - Where it ends.
 * @returns The selection the undo put back, and the one after the read.
 */
async function deleteAndUndo(
  view: EditorView,
  manager: Y.UndoManager,
  anchor: number,
  head: number,
): Promise<{ restored: [number, number]; read: [number, number] }> {
  act(() => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  });
  act(() => {
    view.dispatch(view.state.tr.deleteSelection());
  });
  manager.stopCapturing();
  act(() => {
    manager.undo();
  });
  const restored: [number, number] = [view.state.selection.anchor, view.state.selection.head];
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => {
    (view as unknown as { domObserver: { flush: () => void } }).domObserver.flush();
  });
  return { restored, read: [view.state.selection.anchor, view.state.selection.head] };
}

describe('a selection the table frame moves (inner#1125)', () => {
  it('keeps a selection whose head lies in the table and whose anchor lies above it', async () => {
    const { view, manager } = open();
    const { restored, read } = await deleteAndUndo(view, manager, textAt(view, 'above', 2), textAt(view, 'dd', 1));
    expect(read).toEqual(restored);
  });

  it('keeps a selection whose anchor lies in the table and whose head lies below it', async () => {
    const { view, manager } = open();
    const { restored, read } = await deleteAndUndo(view, manager, textAt(view, 'aa', 1), textAt(view, 'below', 2));
    expect(read).toEqual(restored);
  });
});
