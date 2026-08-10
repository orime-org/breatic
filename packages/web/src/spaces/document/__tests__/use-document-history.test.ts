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
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@breatic/shared';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { useDocumentHistory } from '@web/spaces/document/use-document-history';

/** Applies one doc's state to another tagged as a remote peer's change. */
function syncAsRemote(target: Y.Doc, source: Y.Doc): void {
  Y.applyUpdate(
    target,
    Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)),
    'remote-peer',
  );
}


interface Harness {
  handle: ReturnType<typeof useDocumentEditor>;
  history: ReturnType<typeof useDocumentHistory>;
}

describe('useDocumentHistory', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  const NAME = 'project-p/document-s';

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /** Mounts the editor together with the history mirror that reads from it. */
  async function mount(): Promise<{
    result: { current: Harness };
    unmount: () => void;
  }> {
    const rendered = renderHook<Harness, void>(() => {
      const handle = useDocumentEditor({
        doc,
        name: NAME,
        caretProvider: { awareness },
      });
      const history = useDocumentHistory(handle?.undoManager ?? null);
      return { handle, history };
    });
    await waitFor(() => expect(rendered.result.current.handle).not.toBeNull());
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
      result.current.handle?.editor.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));
    expect(result.current.history.canRedo).toBe(false);
  });

  it('reports redo available right after an undo', async () => {
    const { result } = await mount();
    act(() => {
      result.current.handle?.editor.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));

    act(() => {
      result.current.handle?.editor.commands.undo();
    });

    await waitFor(() => expect(result.current.history.canRedo).toBe(true));
  });

  it('drops redo again once the redone edit is back', async () => {
    const { result } = await mount();
    act(() => {
      result.current.handle?.editor.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));
    act(() => {
      result.current.handle?.editor.commands.undo();
    });
    await waitFor(() => expect(result.current.history.canRedo).toBe(true));

    act(() => {
      result.current.handle?.editor.commands.redo();
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
      result.current.handle?.editor.commands.setContent('<p>mine</p>');
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
      result.current.handle?.editor.commands.undo();
    });

    // yjs discards the dead entry silently — without the re-read after undo,
    // the button would stay lit forever and every click would do nothing.
    await waitFor(() => expect(result.current.history.canUndo).toBe(false));
    peer.destroy();
  });

  it('does not accumulate subscriptions as tabs are switched', async () => {
    // The binding subscribes to the manager whenever an editor is built, and
    // releases those subscriptions by destroying it. Both halves are correct
    // only while the two share a lifetime. An earlier design gave the manager a
    // longer life than its editor and had to fight that teardown, which cost a
    // listener pair per rebuild — each pinning a dead editor view and its
    // ProseMirror state (measured: 2, 3, 4, 5 across four rebuilds). Keeping
    // the EDITOR instead means there is nothing to rebuild; this asserts that
    // property directly rather than trusting the reasoning.
    const counts: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const rendered = await mount();
      const manager = rendered.result.current.handle!.undoManager;
      act(() => {
        rendered.result.current.handle?.editor.commands.insertContent(
          `round ${round} `,
        );
      });
      counts.push(
        (manager as unknown as { _observers: Map<string, Set<unknown>> })
          ._observers.get('stack-item-added')?.size ?? 0,
      );
      // Unmounting is the tab switch; the editor deliberately stays alive.
      rendered.unmount();
    }
    // Measured: two subscriptions come with the editor itself (an editor built
    // without the history mirror below shows exactly these two) and one is the
    // mirror's. Why the binding's half is two rather than one is not something
    // this test claims to know; what it pins down is that the fourth tab switch
    // costs the same as the first. If a release changes the constant, re-measure
    // it here rather than loosening the assertion.
    expect(counts).toEqual([3, 3, 3, 3]);
  });
});
