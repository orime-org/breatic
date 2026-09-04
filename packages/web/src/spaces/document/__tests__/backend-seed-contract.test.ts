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
 * The seed writes ONE empty paragraph, and that is the contract. An empty
 * fragment is not a safe resting state under this schema — `document-body`
 * carries the two merges that measured it — so a seed that stopped writing
 * that block would leave the first two clients each filling the gap
 * themselves.
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
  adoptDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { blockTexts } from '@web/spaces/document/__tests__/document-body-fixtures';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const NAME = 'project-p/document-s';

describe('a document opened straight from the backend seed', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  const containers: HTMLElement[] = [];

  beforeEach(() => {
    doc = new Y.Doc();
    // The bytes the backend persists when the Space is created — not a
    // reconstruction of them.
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    containers.splice(0).forEach((element) => {
      element.remove();
    });
    awareness.destroy();
    doc.destroy();
  });

  /**
   * Mounts the real editor over the seeded doc, on the page.
   *
   * On the page because the collaboration binding is built by the sync
   * plugin's view: an unmounted editor is bound to nothing, and every case
   * below would be measuring a private document.
   * @returns The editor and its undo manager.
   */
  async function open(): Promise<DocumentEditorHandle> {
    const rendered = renderHook(() =>
      useDocumentEditor({ doc, name: NAME, caretProvider: { awareness } }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    const handle = rendered.result.current as DocumentEditorHandle;
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    adoptDocumentEditor(handle, container);
    return handle;
  }

  /** Replaces the whole body with one paragraph. */
  function write(handle: DocumentEditorHandle, text: string): void {
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: text },
      ] as never);
    });
  }

  it('arrives holding one empty paragraph, and nothing else', () => {
    // Read before any editor exists: this is what the backend persists, and
    // it is the contract. A seed writing a different node would be inventing
    // a shape this schema may not know.
    expect(blockTexts(doc)).toEqual(['']);
  });

  it('opens on exactly that block, with no local fill-in', async () => {
    const { editor } = await open();
    // Binding the seed produces the document the seed describes. A second
    // block appearing here would be this client papering over the seed, and
    // broadcasting that repair as its own edit.
    expect(editor.document).toHaveLength(1);
    expect(editor.prosemirrorState.doc.textContent).toBe('');
  });

  it('names every attribute the schema declares a default for', async () => {
    // The seed exists so that the first client to bind invents nothing. An
    // attribute it leaves out is one the schema will supply from its default
    // the first time anyone edits — a write carried to every peer that says
    // nothing about what the reader did.
    //
    // Compared against the schema rather than against a list written here, so
    // that a tenth attribute added to the paragraph turns this red instead of
    // going unnoticed.
    const { editor } = await open();
    const declared = Object.keys(
      editor.prosemirrorState.schema.nodes['paragraph']?.spec.attrs ?? {},
    );

    const seeded = documentBodyFragment(doc).toString();
    const named = [...seeded.matchAll(/<paragraph ([^>]*)>/g)]
      .flatMap((match) => [...(match[1] ?? '').matchAll(/(\w+)=/g)])
      .map((attr) => attr[1]);
    expect(named.sort()).toEqual(declared.sort());

    // And that the values match what the schema would have supplied: a seeded
    // attribute the schema reads differently is one it overwrites on the first
    // edit, which the name comparison above cannot see. Read off the block
    // that was seeded, since typing into an empty document also leaves a fresh
    // block behind it.
    const attributesOfFirst = (): string =>
      /<paragraph ([^>]*)>/.exec(documentBodyFragment(doc).toString())?.[1] ?? '';
    const before = attributesOfFirst();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('typing', 2));
    expect(attributesOfFirst()).toBe(before);
  });

  it('gives the user nothing to undo — the seed is not their edit', async () => {
    const { undoManager } = await open();
    // This also guards the other failure mode: if the seeded bytes held
    // something the schema did not recognise, binding would repair it on the
    // spot and that repair would land here as an entry.
    expect(undoManager.undoStack).toHaveLength(0);
  });

  it('keeps redo alive after the user undoes everything they wrote', async () => {
    const handle = await open();
    const { editor, undoManager } = handle;

    write(handle, 'a sentence worth keeping');
    await waitFor(() =>
      expect(editor.prosemirrorState.doc.textContent).toContain(
        'a sentence worth keeping',
      ),
    );

    act(() => {
      undoManager.undo();
    });
    expect(undoManager.redoStack).toHaveLength(1);

    // The moment the bug used to strike: what undo left behind was a document
    // ProseMirror could not represent, so this dispatch was where it wrote a
    // filler block back, yjs read that as a fresh local edit, and the redo
    // stack was cleared. Undo now lands on the seed's own block, which is a
    // document both ends agree on, so there is nothing to reconcile.
    act(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr);
    });
    expect(undoManager.redoStack).toHaveLength(1);

    act(() => {
      undoManager.redo();
    });
    expect(editor.prosemirrorState.doc.textContent).toContain(
      'a sentence worth keeping',
    );
  });

  it('binds to the same fragment the backend wrote into', async () => {
    const handle = await open();
    write(handle, 'typed into the editor');
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
