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
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  caretAtStartOf,
  readerPlace,
  restoreAfterRowDrag,
  restoreReaderPlace,
} from '@web/spaces/document/document-drag-selection';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { BodyEdgeSelection, bodyEdgePos } from '@web/spaces/document/document-body-edge-selection';

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
  // The reader is working in the body: it holds the focus.
  editor.prosemirrorView.dom.focus();
  return editor;
}

/**
 * Puts a selection over the first row's own content.
 * @param editor - The editor to write to.
 */
function selectTheRow(editor: ReturnType<typeof buildDocumentEditor>): void {
  const view = editor.prosemirrorView;
  const first = (editor.document[0] as unknown as Seen).id;
  // A text selection: `selectionOverBlockContent` is the one row-to-selection
  // mapping this Space has. What these cases read is where the restore lands,
  // which is the same whatever selection it replaces.
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

describe('putting back a selection that reaches past the last block', () => {
  it('keeps it reaching the end after a row moved', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'alpha' },
      { type: 'paragraph', content: 'beta' },
      { type: 'divider' },
    ] as never);
    const view = editor.prosemirrorView;
    const alphaText = 3;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, alphaText + 1, 'end')));
    const held = readerPlace(view.state);
    if (held === undefined) throw new Error('no place');

    // The drag: `beta` goes to the top.
    const group = view.state.doc.firstChild!;
    const beta = group.child(1);
    const betaPos = 1 + group.child(0).nodeSize;
    view.dispatch(view.state.tr.delete(betaPos, betaPos + beta.nodeSize).insert(1, beta));
    selectTheRow(editor);

    restoreReaderPlace(view, held);

    const { selection, doc } = view.state;
    expect(selection).toBeInstanceOf(BodyEdgeSelection);
    expect(doc.resolve(selection.anchor).parent.textContent).toBe('alpha');
    expect(selection.anchor - doc.resolve(selection.anchor).start()).toBe(1);
    expect(selection.head).toBe(bodyEdgePos(doc, 'end'));
  });
});

describe('a drag started from a body that does not hold the focus (inner#1127)', () => {
  it('has no place of the reader’s to hand back', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    selectTheRow(editor);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();

    expect(readerPlace(view.state)).toBeUndefined();
    outside.remove();
  });

  it('puts the caret at the start of the moved row', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    const second = (editor.document[1] as unknown as Seen).id;

    restoreAfterRowDrag(view, undefined, second);

    const { selection } = view.state;
    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('beta');
    expect(selection.$from.parentOffset).toBe(0);
  });

  it('selects a moved divider whole', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'alpha' },
      { type: 'divider' },
    ] as never);
    const view = editor.prosemirrorView;
    const divider = (editor.document[1] as unknown as Seen).id;

    restoreAfterRowDrag(view, undefined, divider);

    const { selection } = view.state;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect((selection as NodeSelection).node.type.name).toBe('divider');
  });
});
