// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The browser end of the contract with the backend's content seed.
 *
 * When a document Space is created, the backend writes its body without going
 * through ProseMirror. Getting that write wrong does not raise anything: the
 * first client to connect repairs the difference by deleting what its schema
 * does not recognise, and broadcasts that deletion as its own edit. So both
 * ends are pinned against the SAME function — `@breatic/shared`'s encoder,
 * which is what the backend calls too. A test that built its own bytes here
 * would be checking a copy of itself, and would stay green through exactly
 * the drift it exists to catch: the body key changing on this side, or the
 * backend starting to write a node this schema does not know.
 *
 * Everything below runs the real editor over the real bytes. Nothing is
 * hand-rolled except the doc name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import {
  _resetDocumentEditorCacheForTests,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const NAME = 'project-p/document-s';

describe('a document opened straight from the backend seed', () => {
  let doc: Y.Doc;
  let awareness: Awareness;

  beforeEach(() => {
    doc = new Y.Doc();
    // The bytes the backend persists when the Space is created — not a
    // reconstruction of them.
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /**
   * Mounts the real editor over the seeded doc.
   * @returns The editor and its undo manager.
   */
  async function open(): Promise<
    NonNullable<ReturnType<typeof useDocumentEditor>>
    > {
    const rendered = renderHook(() =>
      useDocumentEditor({ doc, name: NAME, caretProvider: { awareness } }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    return rendered.result.current as NonNullable<
      ReturnType<typeof useDocumentEditor>
    >;
  }

  it('arrives with nothing in it — the seed writes no content at all', () => {
    // Read before any editor exists: what the backend persists is an empty
    // fragment, and emptiness is the contract — a seed that started writing
    // nodes again would be inventing a shape this schema may not know.
    expect(documentBodyFragment(doc).length).toBe(0);
  });

  it('opens as a zero-block document, with no local fill-in', async () => {
    const { editor } = await open();
    // `block*` makes emptiness legal, so binding the empty seed must produce
    // an empty document — a paragraph appearing here would be the editor
    // papering over the seed, the exact hazard the old seeded-title design
    // existed to prevent and this schema dissolves.
    expect(editor.state.doc.childCount).toBe(0);
    expect(editor.state.doc.toJSON()).toEqual(
      editor.schema.topNodeType.createAndFill()?.toJSON(),
    );
  });

  it('gives the user nothing to undo — the seed is not their edit', async () => {
    const { editor, undoManager } = await open();
    // This also guards the other failure mode: if the seeded bytes held
    // something the schema did not recognise, binding would repair it on the
    // spot and that repair would land here as an entry.
    expect(undoManager.undoStack.length).toBe(0);
    expect(editor.can().undo()).toBe(false);
  });

  it('keeps redo alive after the user undoes everything they wrote', async () => {
    const { editor } = await open();

    act(() => {
      editor.commands.setContent('<p>a sentence worth keeping</p>');
    });
    await waitFor(() =>
      expect(editor.getText()).toContain('a sentence worth keeping'),
    );

    act(() => {
      editor.commands.undo();
    });
    expect(editor.can().redo()).toBe(true);

    // The moment the bug used to strike under the old `block+`-style schema:
    // an empty document was illegal, so this dispatch was where ProseMirror
    // wrote its filler paragraph back, yjs read that as a fresh local edit,
    // and the redo stack was cleared. With emptiness legal there is nothing
    // to reconcile, so redo survives.
    act(() => {
      editor.view.dispatch(editor.state.tr);
    });
    expect(editor.can().redo()).toBe(true);

    act(() => {
      editor.commands.redo();
    });
    expect(editor.getText()).toContain('a sentence worth keeping');
  });

  it('binds to the same fragment the backend wrote into', async () => {
    const { editor } = await open();
    act(() => {
      editor.commands.setContent('<p>typed into the editor</p>');
    });
    // Read through the shared accessor, which is what the backend's encoder
    // writes through — a mismatch in the key would leave this fragment empty
    // while the editor looked fine.
    await waitFor(() =>
      expect(documentBodyFragment(doc).toString()).toContain(
        'typed into the editor',
      ),
    );
  });
});
