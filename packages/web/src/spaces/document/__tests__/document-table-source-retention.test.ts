// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { act } from '@testing-library/react';
import { Selection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { mergeSelectedCells } from '@web/spaces/document/document-table-run';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

interface OpenedBody {
  readonly doc: Y.Doc;
  readonly editor: Editor;
  readonly manager: Y.UndoManager;
  readonly host: HTMLElement;
}

interface Pair {
  readonly author: OpenedBody;
  readonly peer: OpenedBody;
}

const opened: OpenedBody[] = [];

afterEach(() => {
  act(() => {
    for (const body of opened.splice(0).reverse()) {
      body.editor.unmount();
      body.manager.destroy();
      body.doc.destroy();
      body.host.remove();
    }
  });
});

/** Opens the actual body factory and history over production bytes. @throws {Error} If construction fails. */
function open(bytes: Uint8Array): OpenedBody {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const body = { doc, editor, manager, host };
  opened.push(body);
  editor.mount(host);
  return body;
}

/** Makes two peers share exactly one initialized table. @throws {Error} If the editor rejects the fixture. */
function pair(): Pair {
  const author = open(encodeInitialSpaceContent('document'));
  author.editor.replaceBlocks(author.editor.document, [
    { type: 'paragraph', content: 'lead' },
    tableBlock({ rows: [{ cells: ['L', 'R'] }] }),
  ] as never);
  const peer = open(Y.encodeStateAsUpdate(author.doc));
  author.manager.clear();
  peer.manager.clear();
  author.manager.stopCapturing();
  peer.manager.stopCapturing();
  return { author, peer };
}

/** Finds a displayed cell by its exact current text. @throws {Error} If the fixture cell is absent. */
function cellAt(editor: Editor, text: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.type.spec['tableRole'] === 'cell' && node.textContent === text) found = pos;
  });
  if (found < 0) throw new Error(`Missing cell ${text}`);
  return found;
}

/** Runs the production cell-merge command on the author. @throws {Error} If the fixture is invalid. */
function merge(author: OpenedBody): void {
  const view = author.editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(CellSelection.create(
    view.state.doc,
    cellAt(author.editor, 'L'),
    cellAt(author.editor, 'R'),
  )));
  mergeSelectedCells(author.editor);
}

/** Types through the peer's actual editor while the original right cell exists. @throws {Error} If the selection is invalid. */
function typeOnPeer(peer: OpenedBody): void {
  const view = peer.editor.prosemirrorView;
  const position = cellAt(peer.editor, 'R');
  const end = position + view.state.doc.nodeAt(position)!.nodeSize - 1;
  const selection = Selection.findFrom(view.state.doc.resolve(end), -1, true)!;
  view.dispatch(view.state.tr.setSelection(selection).insertText('_PEER'));
}

/** Delivers real Yjs updates in either order, including duplicates. @throws {Error} If Yjs rejects an update. */
function exchange(value: Pair, authorFirst: boolean): void {
  for (let round = 0; round < 5; round += 1) {
    const toPeer = Y.encodeStateAsUpdate(value.author.doc, Y.encodeStateVector(value.peer.doc));
    const toAuthor = Y.encodeStateAsUpdate(value.peer.doc, Y.encodeStateVector(value.author.doc));
    const frames = authorFirst
      ? [[value.peer.doc, toPeer], [value.author.doc, toAuthor]] as const
      : [[value.author.doc, toAuthor], [value.peer.doc, toPeer]] as const;
    for (const [doc, frame] of frames) {
      Y.applyUpdate(doc, frame, 'peer');
      Y.applyUpdate(doc, frame, 'peer');
    }
  }
}

/** Reads every cell's ordered blocks and checks actual table geometry. @throws {Error} If TableMap rejects the table. */
function cells(editor: Editor): string[][] {
  const content: string[][] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name !== 'docTable') return true;
    expect(TableMap.get(node).problems).toBeNull();
    node.forEach((row) => row.forEach((cell) => {
      const blocks: string[] = [];
      cell.forEach((block) => blocks.push(block.textContent));
      content.push(blocks);
    }));
    return false;
  });
  return content;
}

describe('table source retention', () => {
  it.each([true, false])('preserves late peer text from the merged source cell with author-first delivery %s', (authorFirst) => {
    act(() => {
      const value = pair();
      merge(value.author);
      expect(cells(value.author.editor)).toEqual([['L', 'R']]);
      typeOnPeer(value.peer);
      expect(cells(value.peer.editor)).toEqual([['L'], ['R_PEER']]);

      exchange(value, authorFirst);

      expect(cells(value.author.editor)).toEqual([['L', 'R_PEER']]);
      expect(value.peer.editor.prosemirrorState.doc.toJSON()).toEqual(value.author.editor.prosemirrorState.doc.toJSON());
    });
  });

  it('restores both original cells and late peer text with one undo', () => {
    act(() => {
      const value = pair();
      merge(value.author);
      typeOnPeer(value.peer);
      exchange(value, true);
      expect(value.author.manager.undoStack).toHaveLength(1);

      value.author.manager.undo();
      exchange(value, false);

      expect(cells(value.author.editor)).toEqual([['L'], ['R_PEER']]);
      expect(cells(value.peer.editor)).toEqual([['L'], ['R_PEER']]);
    });
  });

  it('reads retained merged source text from a fresh serialized document', () => {
    act(() => {
      const value = pair();
      merge(value.author);
      typeOnPeer(value.peer);
      exchange(value, true);

      const reloaded = open(Y.encodeStateAsUpdate(value.author.doc));

      expect(cells(reloaded.editor)).toEqual([['L', 'R_PEER']]);
      expect(reloaded.editor.prosemirrorState.doc.toJSON()).toEqual(value.author.editor.prosemirrorState.doc.toJSON());
    });
  });
});
