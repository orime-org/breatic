// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Undo / redo availability for the toolbar.
 *
 * Two traps are covered here, both of which produce a button that lies about
 * what it will do:
 *
 * - Undo fills the redo stack AFTER dispatching its document change, so
 *   anything sampling availability during that transaction reads a stale
 *   empty stack and never hears the correction.
 * - yjs discards "dead" stack entries — ones whose content a collaborator has
 *   since deleted — WITHOUT announcing it, so an events-only mirror keeps a
 *   button lit that does nothing when clicked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { useDocumentHistory } from '@web/spaces/document/use-document-history';
import {
  getDocumentUndoManager,
  _resetDocumentUndoCacheForTests,
} from '@web/spaces/document/document-undo';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

interface Harness {
  editor: Editor | null;
  history: ReturnType<typeof useDocumentHistory>;
}

/** Applies one doc's state to another tagged as a remote peer's change. */
function syncAsRemote(target: Y.Doc, source: Y.Doc): void {
  Y.applyUpdate(
    target,
    Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)),
    'remote-peer',
  );
}

describe('useDocumentHistory', () => {
  let doc: Y.Doc;
  const NAME = 'project-p/document-s';

  beforeEach(() => {
    doc = new Y.Doc();
  });
  afterEach(() => {
    _resetDocumentUndoCacheForTests();
    doc.destroy();
  });

  /** Mounts an editor sharing the document's cached undo manager. */
  async function mount(): Promise<{ result: { current: Harness } }> {
    const fragment = documentBodyFragment(doc);
    const undoManager = getDocumentUndoManager(doc, NAME);
    const rendered = renderHook<Harness, void>(() => {
      const editor = useDocumentEditor({ fragment, undoManager });
      const history = useDocumentHistory(undoManager);
      return { editor, history };
    });
    await waitFor(() => expect(rendered.result.current.editor).not.toBeNull());
    return rendered;
  }

  it('reports nothing available on a fresh document', async () => {
    const { result } = await mount();
    expect(result.current.history.canUndo).toBe(false);
    expect(result.current.history.canRedo).toBe(false);
  });

  it('reports undo available once this client edits', async () => {
    const { result } = await mount();
    act(() => {
      result.current.editor?.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));
    expect(result.current.history.canRedo).toBe(false);
  });

  it('reports redo available right after an undo', async () => {
    const { result } = await mount();
    act(() => {
      result.current.editor?.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));

    act(() => {
      result.current.editor?.commands.undo();
      result.current.history.sync();
    });

    await waitFor(() => expect(result.current.history.canRedo).toBe(true));
  });

  it('drops redo again once the redone edit is back', async () => {
    const { result } = await mount();
    act(() => {
      result.current.editor?.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));
    act(() => {
      result.current.editor?.commands.undo();
      result.current.history.sync();
    });
    await waitFor(() => expect(result.current.history.canRedo).toBe(true));

    act(() => {
      result.current.editor?.commands.redo();
      result.current.history.sync();
    });

    await waitFor(() => expect(result.current.history.canRedo).toBe(false));
    expect(result.current.history.canUndo).toBe(true);
  });

  it('goes quiet when there is no manager', () => {
    const { result } = renderHook(() => useDocumentHistory(null));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('stops offering undo once a peer has deleted the edit it would restore', async () => {
    const { result } = await mount();
    const fragment = documentBodyFragment(doc);

    act(() => {
      result.current.editor?.commands.setContent('<p>mine</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));

    // A peer deletes what this client wrote. The entry on our stack is now
    // dead: undoing it would change nothing.
    const peer = new Y.Doc();
    syncAsRemote(peer, doc);
    peer.getXmlFragment('content').delete(0, peer.getXmlFragment('content').length);
    act(() => syncAsRemote(doc, peer));
    await waitFor(() => expect(fragment.length).toBe(0));

    act(() => {
      result.current.editor?.commands.undo();
      result.current.history.sync();
    });

    // yjs discards the dead entry silently — without the re-read after undo,
    // the button would stay lit forever and every click would do nothing.
    await waitFor(() => expect(result.current.history.canUndo).toBe(false));
    peer.destroy();
  });
});

describe('document undo manager — outlives the editor', () => {
  const NAME = 'project-p/document-survives';
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });
  afterEach(() => {
    _resetDocumentUndoCacheForTests();
    doc.destroy();
  });

  it('keeps the undo history across a Space tab switch', async () => {
    const fragment = documentBodyFragment(doc);
    const undoManager = getDocumentUndoManager(doc, NAME);

    const first = renderHook(() =>
      useDocumentEditor({ fragment, undoManager }),
    );
    await waitFor(() => expect(first.result.current).not.toBeNull());
    act(() => {
      first.result.current!.commands.setContent('<p>written before the switch</p>');
    });
    await waitFor(() => expect(undoManager.canUndo()).toBe(true));

    // Switching Space tabs remounts the body — SpaceOutlet is keyed on the id.
    first.unmount();

    const second = renderHook(() =>
      useDocumentEditor({
        fragment,
        undoManager: getDocumentUndoManager(doc, NAME),
      }),
    );
    await waitFor(() => expect(second.result.current).not.toBeNull());

    // The history has to still be there. A manager owned by the editor would
    // have died with it, leaving the text but no way to take it back.
    expect(getDocumentUndoManager(doc, NAME).canUndo()).toBe(true);
    act(() => {
      second.result.current!.commands.undo();
    });
    expect(
      documentBodyFragment(doc).toArray().map(String).join(''),
    ).not.toContain('written before the switch');
  });
});
