// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126: the ends of a selection of table cells, for whoever places
 * something at an end — the text bar, a collaborator's caret, the caret a
 * closing panel leaves — are in the text of the two end cells. The cells'
 * own ends sit between cells, where there is no line of text to stand on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { caretAt, textEnds } from '@web/spaces/document/document-body-edge-selection';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens an editor on a 2 × 2 table with two corner cells selected.
 * @param anchor - The cell the selection starts on, by index.
 * @param head - The cell it ends on, by index.
 * @returns The editor.
 */
function open(anchor = 0, head = 3): Editor {
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
  const view = editor.prosemirrorView!;
  const cells: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cells.push(pos);
    return true;
  });
  view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[anchor]!, cells[head]!)));
  return editor;
}

/**
 * The words of the text block a position is in.
 * @param editor - The editor.
 * @param pos - The position.
 * @returns Its words, or null outside a text block.
 */
function lineAt(editor: Editor, pos: number): string | null {
  const $pos = editor.prosemirrorState.doc.resolve(pos);
  return $pos.parent.isTextblock ? $pos.parent.textContent : null;
}

describe('the ends of a selection of cells', () => {
  it('are in the text of the cell it started on and the one it ends on', () => {
    const editor = open();

    const { anchor, head } = textEnds(editor.prosemirrorState.selection);

    expect([lineAt(editor, anchor), lineAt(editor, head)]).toEqual(['a1', 'b2']);
  });

  it.each([
    ['a1 to b2', 0, 3],
    ['b1 to a2', 1, 2],
  ])('leave a caret where text would leave one when a panel closes over %s', (_label, anchor, head) => {
    // As over selected words: closing to the end leaves the caret after the
    // last words selected, closing to the start before the first, whichever
    // corner the selection was dragged from.
    const editor = open(anchor, head);

    const end = caretAt(editor.prosemirrorState.selection, 1);
    const start = caretAt(editor.prosemirrorState.selection, -1);

    expect([lineAt(editor, end.head), end.$head.parentOffset]).toEqual(['b2', 2]);
    expect([lineAt(editor, start.head), start.$head.parentOffset]).toEqual(['a1', 0]);
  });
});
