// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Whether undo / redo are currently available.
 *
 * This cannot be read off the editor's transaction stream, which is why it has
 * its own hook and its own tests. Undo fills the redo stack AFTER the document
 * change has already been dispatched, so anything that samples availability
 * during a transaction sees the stack as it was a moment earlier and then never
 * hears about the correction. Measured: after `undo()`, exactly one transaction
 * fires and `can().redo()` is already true by the time it settles — but a
 * transaction-driven subscriber has by then read `false` and stopped listening.
 * The result is a redo button that stays dead until some unrelated edit happens
 * to wake it up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { useDocumentHistory } from '@web/spaces/document/use-document-history';

interface Harness {
  editor: Editor | null;
  history: { canUndo: boolean; canRedo: boolean };
}

describe('useDocumentHistory', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });
  afterEach(() => {
    doc.destroy();
  });

  /** Mounts the editor and the history reader together. */
  async function mount(): Promise<{ result: { current: Harness } }> {
    const fragment = doc.getXmlFragment('content');
    const rendered = renderHook<Harness, void>(() => {
      const editor = useDocumentEditor({ fragment });
      const history = useDocumentHistory(editor);
      return { editor, history };
    });
    await waitFor(() => expect(rendered.result.current.editor).not.toBeNull());
    return rendered;
  }

  it('reports nothing available on a fresh document', async () => {
    const { result } = await mount();
    expect(result.current.history).toEqual({ canUndo: false, canRedo: false });
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

    // The whole reason this hook exists: redo must become available here, with
    // no further editing to nudge it.
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

  it('reports nothing available when there is no editor yet', () => {
    const { result } = renderHook(() => useDocumentHistory(null));
    expect(result.current).toEqual({ canUndo: false, canRedo: false });
  });
});
