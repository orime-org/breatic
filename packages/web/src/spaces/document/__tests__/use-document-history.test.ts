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
    });
    await waitFor(() => expect(result.current.history.canRedo).toBe(true));

    act(() => {
      result.current.editor?.commands.redo();
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

  it('gives every listener back when its editor goes away', async () => {
    // The binding subscribes to the manager on mount and hands those
    // subscriptions back by calling `destroy()` — which drops EVERY listener,
    // not just its own. That is right for an editor-owned manager and wrong
    // for one that outlives editors, in both directions: suppress the teardown
    // and subscriptions pile up, one set per rebuild, each pinning a dead
    // editor view and its ProseMirror state (measured: 2, 3, 4, 5 across four
    // rebuilds); let it run unscoped and it reaches past its own into the
    // incoming editor's, because upstream defers teardown past the next mount
    // (measured: 0 live listeners where 1 was needed).
    const fragment = documentBodyFragment(doc);
    const manager = getDocumentUndoManager(doc, NAME);
    const listenerCount = (): number =>
      (manager as unknown as { _observers: Map<string, Set<unknown>> })._observers.get(
        'stack-item-added',
      )?.size ?? 0;

    /** Lets the deferred teardown (`setTimeout(…, 1)` upstream) actually run. */
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };

    const whileLive: number[] = [];
    const afterTeardown: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const mounted = renderHook(() =>
        useDocumentEditor({ fragment, undoManager: manager }),
      );
      await waitFor(() => expect(mounted.result.current).not.toBeNull());
      act(() => {
        mounted.result.current!.commands.insertContent(`round ${round} `);
      });
      await settle();
      whileLive.push(listenerCount());
      mounted.unmount();
      await settle();
      afterTeardown.push(listenerCount());
    }

    // The invariant: an editor that is gone holds nothing.
    expect(afterTeardown).toEqual([0, 0, 0, 0]);
    // And the live cost is flat, not cumulative. Two rather than one because
    // `useEditor` builds a second instance per mount — upstream's own
    // behaviour, not something this module asks for; what matters here is that
    // the number is the same on the fourth rebuild as on the first. If a
    // release changes it, this line should fail and be re-measured, not
    // loosened.
    expect(whileLive).toEqual([2, 2, 2, 2]);
  });

  it('still records edits made AFTER coming back', async () => {
    // Keeping the old history is only half of it — the manager also has to keep
    // capturing. A manager that survived the switch but stopped listening would
    // look fine (old stack intact, undo still "available") while quietly
    // dropping everything typed from then on.
    const fragment = documentBodyFragment(doc);
    const undoManager = getDocumentUndoManager(doc, NAME);

    const first = renderHook(() =>
      useDocumentEditor({ fragment, undoManager }),
    );
    await waitFor(() => expect(first.result.current).not.toBeNull());
    act(() => {
      first.result.current!.commands.setContent('<p>before switch</p>');
    });
    await waitFor(() => expect(undoManager.undoStack.length).toBe(1));
    first.unmount();

    // Close the capture window, the way a pause in typing does. Without this
    // the two edits merge into one entry — yjs coalesces anything inside its
    // capture timeout — and the assertion below would be measuring the merge
    // rather than whether the manager is still listening.
    undoManager.stopCapturing();

    const second = renderHook(() =>
      useDocumentEditor({
        fragment,
        undoManager: getDocumentUndoManager(doc, NAME),
      }),
    );
    await waitFor(() => expect(second.result.current).not.toBeNull());
    act(() => {
      second.result.current!.commands.setContent('<p>after switch</p>');
    });

    // The post-switch edit has to land on the stack as its own entry.
    await waitFor(() =>
      expect(getDocumentUndoManager(doc, NAME).undoStack.length).toBe(2),
    );

    act(() => {
      second.result.current!.commands.undo();
    });
    const text = documentBodyFragment(doc).toArray().map(String).join('');
    expect(text).not.toContain('after switch');
    expect(text).toContain('before switch');
  });
});
