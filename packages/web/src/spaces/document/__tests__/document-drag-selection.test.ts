// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A11.2: a drag never ends with a node selection standing.
 *
 * The library carries a row drag on a node selection it puts on the row, and
 * that selection is still there when the drag ends. Nothing is drawn for one
 * any more (user 2026-09-18), so what a surviving one costs the reader is the
 * bubble bar: it comes up for any selection that is not empty, and a node
 * selection is not empty — measured 2026-09-18, a drag whose row a co-editor
 * deleted mid-flight ended with `bar: true` over a row nobody selected.
 *
 * So putting the reader back is two things, and only the first depends on
 * knowing where they were: a text selection goes down whatever happens, and
 * the remembered place decides where.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  caretAtStartOf,
  readerPlace,
  restoreReaderPlace,
} from '@web/spaces/document/document-drag-selection';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as this file reads it. */
interface Seen {
  id: string;
}

/**
 * Opens an editor holding two rows.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha' },
    { type: 'paragraph', content: 'beta' },
  ] as never);
  return editor;
}

/**
 * Puts the kind of selection a row drag leaves behind on the first row.
 * @param editor - The editor to write to.
 */
function selectTheRow(editor: ReturnType<typeof buildDocumentEditor>): void {
  const view = editor.prosemirrorView;
  const first = (editor.document[0] as unknown as Seen).id;
  // `selectionOverBlockContent` builds a text selection; the drag's is a node
  // one, so this reaches for the node selection the same way the library does.
  const over = selectionOverBlockContent(view.state.doc, first);
  view.dispatch(view.state.tr.setSelection(over));
}

describe('putting the reader back after a drag', () => {
  it('goes back to where they were when that row is still there', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    const second = (editor.document[1] as unknown as Seen).id;
    // The reader is in the row that is NOT the one about to be dragged.
    view.dispatch(
      view.state.tr.setSelection(
        selectionOverBlockContent(view.state.doc, second),
      ),
    );
    const held = readerPlace(view.state);
    if (held === undefined) throw new Error('no place');
    selectTheRow(editor);

    restoreReaderPlace(view, held);

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(
      view.state.doc.resolve(view.state.selection.from).parent.textContent,
    ).toBe('beta');
    expect(second).toBeDefined();
  });

  it('leaves a text selection even when the row it remembers is gone', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    selectTheRow(editor);

    restoreReaderPlace(view, caretAtStartOf('a-row-that-is-gone'));

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.empty).toBe(true);
  });
});
