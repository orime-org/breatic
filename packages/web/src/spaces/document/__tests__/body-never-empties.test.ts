// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The body holds a block for as long as the document exists — not only at the
 * moment it is created.
 *
 * The backend writes one block when the Space is created, which settles the
 * single-writer case: one person can undo all the way back and the block they
 * started from is still there. It does not settle the collaborative case. That
 * first block belongs to the document, not to whoever typed into it, and a
 * co-editor deleting the paragraph it became is an ordinary edit. Once it is
 * gone every remaining block was made by somebody, and undo takes back what its
 * owner made — so undoing the last of them empties the body outright.
 *
 * What that costs, measured before the filter was restored: the body reaches
 * zero blocks while the editor still holds the one its schema insists on. The
 * next dispatch — a click, or the window regaining focus — reconciles the two
 * by writing that block into Yjs, and yjs reads the write as a fresh local
 * edit: the redo stack is cleared and the text just undone is gone for good,
 * with the deletion synced to everyone.
 *
 * The rule that stops it is the one an earlier version of `document-undo` had
 * and that was removed in `e61298d4` on the grounds that a body now arrives
 * with a paragraph in it. That reasoning reads "born with one" as "always has
 * one", which holds until a second person edits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

describe('a document body never runs out of blocks', () => {
  let docA: Y.Doc;
  let docB: Y.Doc;
  let awA: Awareness;
  let awB: Awareness;

  beforeEach(() => {
    const seed = encodeInitialSpaceContent('document');
    docA = new Y.Doc();
    docB = new Y.Doc();
    Y.applyUpdate(docA, seed);
    Y.applyUpdate(docB, seed);
    awA = new Awareness(docA);
    awB = new Awareness(docB);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awA.destroy();
    awB.destroy();
    docA.destroy();
    docB.destroy();
  });

  /**
   * Ship what `from` knows and `to` does not, tagged as a remote edit — the
   * shape a co-editor's work arrives in, and what keeps it off the local stack.
   * @param from - The doc whose state to send.
   * @param to - The doc receiving it.
   */
  function sync(from: Y.Doc, to: Y.Doc): void {
    Y.applyUpdate(
      to,
      Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)),
      'remote-peer',
    );
  }

  /**
   * Mount a real editor over a doc.
   * @param doc - The document Space's Y.Doc.
   * @param awareness - That client's awareness.
   * @param name - Cache key; must differ per client.
   * @returns The editor handle.
   */
  async function open(
    doc: Y.Doc,
    awareness: Awareness,
    name: string,
  ): Promise<NonNullable<ReturnType<typeof useDocumentEditor>>> {
    const rendered = renderHook(() =>
      useDocumentEditor({ doc, name, caretProvider: { awareness } }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    return rendered.result.current as NonNullable<
      ReturnType<typeof useDocumentEditor>
    >;
  }

  it('survives a co-editor deleting the first block and me undoing the rest', async () => {
    const A = await open(docA, awA, 'p/document-a');
    const B = await open(docB, awB, 'p/document-b');
    const bodyA = documentBodyFragment(docA);

    // A types two paragraphs. The first is the block the Space was created
    // with, now carrying A's text; the second is A's own.
    act(() => {
      A.editor.commands.insertContent('alice one');
    });
    act(() => {
      A.editor.commands.enter();
    });
    act(() => {
      A.editor.commands.insertContent('alice two');
    });
    await waitFor(() => expect(bodyA.length).toBe(2));
    act(() => sync(docA, docB));
    await waitFor(() => expect(B.editor.getText()).toContain('alice two'));

    // B removes the first paragraph. B's own document still has a block left,
    // so nothing on B's side objects.
    act(() => {
      const firstSize = B.editor.state.doc.child(0).nodeSize;
      B.editor.commands.deleteRange({ from: 0, to: firstSize });
    });
    act(() => sync(docB, docA));
    await waitFor(() => expect(bodyA.length).toBe(1));

    // A undoes. Everything A made is now gone — but the body must not be.
    act(() => {
      A.editor.commands.undo();
    });
    expect(bodyA.length).toBeGreaterThanOrEqual(1);

    // And the redo A is entitled to has to survive the next dispatch, which is
    // where the reconciliation write used to land.
    expect(A.editor.can().redo()).toBe(true);
    act(() => {
      A.editor.view.dispatch(A.editor.state.tr);
    });
    expect(A.editor.can().redo()).toBe(true);

    act(() => {
      A.editor.commands.redo();
    });
    expect(A.editor.getText()).toContain('alice two');
  });

  // The block left standing decides nothing — these two exist because an
  // earlier attempt made it decide everything. That attempt refused the
  // deletion inside the delete filter, which works only when the survivor is a
  // plain paragraph. A container was kept as an empty shell (yjs deletes
  // children first, and they are not direct children of the body), the schema
  // rejects `<bulletList>` with no items, and y-tiptap's error recovery then
  // deleted it — body at zero again, by a longer road. A block with
  // attributes was kept and stripped of them: an h3 came back an h1.
  it.each([
    ['a bullet list', (e: { commands: { toggleBulletList: () => void } }) => e.commands.toggleBulletList()],
    ['a blockquote', (e: { commands: { toggleBlockquote: () => void } }) => e.commands.toggleBlockquote()],
    ['a level-3 heading', (e: { commands: { toggleHeading: (a: { level: 3 }) => void } }) => e.commands.toggleHeading({ level: 3 })],
  ])('survives when the last block is %s', async (_label, makeBlock) => {
    const A = await open(docA, awA, `p/document-${_label.replace(/\s/g, '-')}`);
    const B = await open(docB, awB, `p/document-${_label.replace(/\s/g, '-')}-b`);
    const bodyA = documentBodyFragment(docA);

    act(() => {
      A.editor.commands.insertContent('alice one');
    });
    act(() => {
      A.editor.commands.enter();
    });
    act(() => {
      makeBlock(A.editor as never);
    });
    act(() => {
      A.editor.commands.insertContent('KEEPME');
    });
    await waitFor(() => expect(bodyA.length).toBe(2));
    act(() => sync(docA, docB));
    await waitFor(() => expect(B.editor.getText()).toContain('KEEPME'));

    act(() => {
      const firstSize = B.editor.state.doc.child(0).nodeSize;
      B.editor.commands.deleteRange({ from: 0, to: firstSize });
    });
    act(() => sync(docB, docA));
    await waitFor(() => expect(bodyA.length).toBe(1));

    act(() => {
      A.editor.commands.undo();
    });
    expect(bodyA.length).toBeGreaterThanOrEqual(1);
    expect(A.editor.can().redo()).toBe(true);

    act(() => {
      A.editor.view.dispatch(A.editor.state.tr);
    });
    expect(A.editor.can().redo()).toBe(true);

    act(() => {
      A.editor.commands.redo();
    });
    expect(A.editor.getText()).toContain('KEEPME');
  });

  it('still lets undo take back a block when another one remains', async () => {
    // The guard must not become "undo can never remove a block". With two
    // blocks present, undoing the one I just made removes it as usual.
    const A = await open(docA, awA, 'p/document-solo');
    const bodyA = documentBodyFragment(docA);

    act(() => {
      A.editor.commands.insertContent('first');
    });
    act(() => {
      A.editor.commands.enter();
    });
    act(() => {
      A.editor.commands.insertContent('second');
    });
    await waitFor(() => expect(bodyA.length).toBe(2));

    act(() => {
      A.editor.commands.undo();
    });

    expect(bodyA.length).toBeLessThan(2);
    expect(bodyA.length).toBeGreaterThanOrEqual(1);
  });
});
