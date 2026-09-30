// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124 A6: a selection reaching past the last block survives what Yjs does to
 * the document (design §5.10.6). The binding rebuilds the selection after
 * every remote change and every undo from relative positions, and rebuilt
 * every type it did not know as a text selection, pulling the edge back.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { BodyEdgeSelection, bodyEdgePos } from '@web/spaces/document/document-body-edge-selection';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Mounts an editor on a document, with the undo the Space gives it.
 * @param doc - The Yjs document.
 * @returns The editor and its undo manager.
 */
function mount(doc: Y.Doc): { editor: Editor; manager: Y.UndoManager } {
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return { editor, manager };
}

/**
 * Lets the undo manager's deferred work run.
 * @returns When it has.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

/**
 * Where the text of the block holding these words starts.
 * @param view - The view.
 * @param words - The block's text.
 * @returns The position.
 */
function textStart(view: EditorView, words: string): number {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === words) at = pos + 1;
    return at < 0;
  });
  return at;
}

/**
 * Two editors on two documents that pass every update to each other.
 * @returns Ours and theirs.
 */
function pair(): { ours: Editor; theirs: Editor; manager: Y.UndoManager } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(b, update, 'peer');
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'peer') Y.applyUpdate(a, update, 'peer');
  });
  const { editor: ours, manager } = mount(a);
  const { editor: theirs } = mount(b);
  ours.replaceBlocks(ours.document, [
    { type: 'paragraph', content: 'Above' },
    { type: 'paragraph', content: 'Middle' },
    { type: 'divider' },
  ] as never);
  // Close the undo unit the document was built in, or undo takes it back too.
  manager.stopCapturing();
  return { ours, theirs, manager };
}

describe('a selection past the last block, with Yjs rebuilding it', () => {
  it('keeps its edge when a collaborator types elsewhere', () => {
    const { ours, theirs } = pair();
    const view = ours.prosemirrorView!;
    const at = textStart(view, 'Middle') + 2;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, at, 'end')));

    const peer = theirs.prosemirrorView!;
    peer.dispatch(peer.state.tr.insertText('Well ', textStart(peer, 'Above')));

    expect(view.state.doc.textContent).toContain('Well Above');
    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
      at + 'Well '.length,
      bodyEdgePos(view.state.doc, 'end'),
    ]);
  });

  it('comes back after the deletion it made is undone', async () => {
    const { ours, manager } = pair();
    const view = ours.prosemirrorView!;
    const at = textStart(view, 'Middle') + 2;
    // Selecting and deleting are two dispatches, as they are for a reader.
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, at, 'end')));
    view.dispatch(view.state.tr.deleteSelection());
    await settle();
    manager.stopCapturing();
    expect(view.state.selection).toBeInstanceOf(TextSelection);

    ours.undo();
    await settle();

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([
      at,
      bodyEdgePos(view.state.doc, 'end'),
    ]);
  });
});
