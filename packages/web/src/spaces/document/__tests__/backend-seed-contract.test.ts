// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
    Y.applyUpdate(doc, encodeInitialSpaceContent('document', 'Storyboard v3'));
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

  it('arrives with a body already in it, not one the editor filled in', () => {
    // Read before any editor exists. Every assertion below this one mounts the
    // editor first, and ProseMirror fills an empty document with a paragraph
    // as it binds — so all of them stay green against a seed that wrote
    // nothing at all. Measured: emptying the encoder leaves this the only case
    // in the file that fails. Without it the file would describe the contract
    // and check none of it.
    const body = documentBodyFragment(doc);
    expect(body.length).toBe(1);
    expect((body.get(0) as Y.XmlElement).toString()).toBe(
      '<title>Storyboard v3</title>',
    );
  });

  it('opens in the shape the schema itself would fill in, title text aside', async () => {
    const { editor } = await open();
    // Comparing against what the schema fills an empty document with, rather
    // than writing the shape out by hand. The literal shape carries attributes
    // contributed by extensions, so a hand-written expectation would be wrong
    // the moment an extension adds another one, and wrong in a way that says
    // nothing about the seed.
    //
    // The one legitimate difference is the title's text: the schema fills in
    // an empty title, the backend writes the Space's name into it. Everything
    // else — node types, nesting, attributes — has to match, because any other
    // difference means the backend invented a shape the editor would then
    // quietly repair.
    const asSchemaWouldFill = editor.schema.topNodeType
      .createAndFill()
      ?.toJSON();
    const seeded = editor.state.doc.toJSON() as {
      content?: { content?: unknown }[];
    };
    expect(seeded.content?.[0]?.content).toBeDefined();
    delete seeded.content?.[0]?.content;
    expect(seeded).toEqual(asSchemaWouldFill);
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

    // The moment the bug used to strike: with an empty fragment, this
    // dispatch is where ProseMirror writes its paragraph back, yjs reads that
    // as a fresh local edit, and the redo stack is cleared — the text just
    // undone gone for good. With the body seeded there is nothing to
    // reconcile, so redo survives.
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
