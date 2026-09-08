// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A10 的选区那半: undo puts the caret back where the undone edit
 * started.
 *
 * Restoring the text without the selection is a half-restore the user has to
 * finish by hand — after undoing a deletion the caret sits wherever it was
 * when they pressed the key, not around the text that just came back.
 *
 * y-prosemirror stores the pre-edit selection on the undo stack item and hands
 * it to the sync binding on `stack-item-popped`
 * (`y-prosemirror.cjs:2174-2179`), which the binding then replays inside
 * `_typeChanged` (`:708`). Whether those two happen in that order is a
 * question about yjs's emit timing rather than about either of them, so it is
 * asserted here rather than reasoned about: `collab-undo-selection.ts` exists
 * because on `@tiptap/y-tiptap` they happen in the opposite order.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  createDocumentUndo,
} from '@web/spaces/document/document-undo-blocknote';

const SENTENCE = 'alpha beta gamma';
const DELETED = 'beta ';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** How long the binding needs to answer a Yjs change. */
const SETTLE_MS = 40;

/**
 * Waits for the binding to have answered.
 * @returns A promise resolving after the binding has run.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

/**
 * The absolute range a substring of the document's text occupies.
 * @param editor - The editor to search.
 * @param needle - The substring to find.
 * @returns The range, as ProseMirror positions.
 * @throws {Error} When the substring is not in the document.
 */
function rangeOf(
  editor: ReturnType<typeof buildDocumentEditor>,
  needle: string,
): { from: number; to: number } {
  const { doc } = editor.prosemirrorView!.state;
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null || !node.isText) {
      return;
    }
    const at = (node.text ?? '').indexOf(needle);
    if (at !== -1) {
      found = { from: pos + at, to: pos + at + needle.length };
    }
  });
  if (found === null) {
    throw new Error(`"${needle}" is not in the document`);
  }
  return found;
}

/**
 * Opens an editor holding one sentence, with its own undo manager.
 * @returns The editor and the manager.
 */
async function openWithSentence(): Promise<{
  editor: ReturnType<typeof buildDocumentEditor>;
  manager: Y.UndoManager;
}> {
  const doc = new Y.Doc();
  const { manager, extension: undoExtension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [undoExtension],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);

  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: SENTENCE },
  ] as never);
  await settle();
  // Close the undo unit so the deletion below becomes its own entry.
  manager.stopCapturing();
  return { editor, manager };
}

describe('undo restores the selection, not only the text', () => {
  it('selects the text it just put back', async () => {
    const { editor, manager } = await openWithSentence();
    const view = editor.prosemirrorView!;
    const deleted = rangeOf(editor, DELETED);

    // Selecting and deleting are two dispatches, as they are for a user:
    // "the selection before the edit" is read off the state the deleting
    // transaction starts from, so folding them together would make the
    // recorded selection the caret from before the drag.
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, deleted.from, deleted.to),
      ),
    );
    view.dispatch(view.state.tr.deleteSelection());
    await settle();
    manager.stopCapturing();
    expect(view.state.doc.textContent).toBe('alpha gamma');

    // Put the caret somewhere else first, or the assertion below would hold
    // even with no restore at all.
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 3)),
    );

    editor.undo();
    await settle();

    expect(view.state.doc.textContent).toBe(SENTENCE);
    const { from, to } = view.state.selection;
    expect({ from, to }).toEqual(rangeOf(editor, DELETED));
  });

  it('puts the caret back at the split after undoing an Enter', async () => {
    // Splitting a block makes a block, and a new block needs an id, so
    // BlockNote's `uniqueID` plugin stamps one from an `appendTransaction`
    // (`blocks-CzQLehlc.js:168-169`). Measured: one Enter therefore lands TWO
    // doc-changing transactions in a single dispatch, the second appended.
    //
    // That matters because the undo plugin recomputes `prevSel` on every
    // transaction from the state BEFORE it (`y-prosemirror.cjs:2151`), so
    // after such a dispatch it holds the selection from between the two — the
    // caret AFTER the split — and that is what gets stored on the stack item.
    // Block-creating edits are the common case here rather than an edge one.
    const { editor, manager } = await openWithSentence();
    const view = editor.prosemirrorView!;
    const splitAt = rangeOf(editor, 'alpha').to;

    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, splitAt, splitAt),
      ),
    );
    view.someProp('handleKeyDown', (handler) =>
      handler(view, new KeyboardEvent('keydown', { key: 'Enter' })),
    );
    await settle();
    manager.stopCapturing();
    expect(editor.document).toHaveLength(2);

    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 3)),
    );

    editor.undo();
    await settle();

    expect(editor.document).toHaveLength(1);
    const { from, to } = view.state.selection;
    expect({ from, to }).toEqual({ from: splitAt, to: splitAt });
  });
});
