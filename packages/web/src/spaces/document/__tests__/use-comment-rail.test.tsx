// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The live reading behind the panel and the dot (#18, A4 · A5 · A15).
 *
 * `commentRail` already decides the order and the groups; what this covers is
 * where its two inputs come from and when they change. They sit in two
 * different places — the threads in the store, their positions in the
 * extension's own state — and neither one alone answers what the panel draws.
 *
 * IDENTITY IS PART OF THE CONTRACT. Positions are recomputed on every
 * document change, so a reading that handed back a fresh object each time
 * would re-render the panel on every keystroke. The last case pins that it
 * does not.
 *
 * TDD: red because the hook does not exist yet.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  documentCommentDraftRange,
} from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import { useCommentRail } from '@web/spaces/document/use-comment-rail';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor with comments on, holding one paragraph.
 * @returns The editor.
 */
function open(): Editor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
    extensions: [documentCommentDraftRange()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
  ] as never);
  return editor;
}

/** Where the first run of text sits. */
function firstRun(editor: Editor): { from: number; to: number } {
  let at: { from: number; to: number } | undefined;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText && at === undefined) {
      at = { from: pos, to: pos + node.nodeSize };
    }
    return true;
  });
  return at!;
}

/**
 * Writes one comment over a range, the way the composer does.
 * @param editor - The editor.
 * @param range - Which words it is about.
 * @param body - What it says.
 */
async function comment(
  editor: Editor,
  range: { from: number; to: number },
  body: string,
): Promise<void> {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, range));
  await postComment(editor, body);
}

/** The only thread in the document. */
function onlyThreadId(editor: Editor): string {
  const comments = editor.getExtension(CommentsExtension)!;
  return [...comments.threadStore.getThreads().keys()][0]!;
}

describe('useCommentRail', () => {
  it('reads an empty rail while nothing has been commented on', () => {
    const editor = open();
    const { result } = renderHook(() => useCommentRail(editor));

    expect(result.current.unresolved).toEqual([]);
    expect(result.current.resolved).toEqual([]);
  });

  it('picks up a comment as it is posted, and marks the button', async () => {
    const editor = open();
    const run = firstRun(editor);
    const { result } = renderHook(() => useCommentRail(editor));

    await act(async () => {
      await comment(editor, { from: run.from, to: run.from + 5 }, 'first');
    });

    await waitFor(() => {
      expect(result.current.unresolved.length).toBeGreaterThan(0);
    });
    expect(result.current.unresolved).toHaveLength(1);
    expect(result.current.unresolved[0]?.settled).toBe(false);
  });

  it('moves a resolved thread into its own group and drops the mark', async () => {
    const editor = open();
    const run = firstRun(editor);
    const { result } = renderHook(() => useCommentRail(editor));
    await act(async () => {
      await comment(editor, { from: run.from, to: run.from + 5 }, 'first');
    });
    await waitFor(() => expect(result.current.unresolved.length).toBeGreaterThan(0));

    const threadId = onlyThreadId(editor);
    await act(async () => {
      await editor
        .getExtension(CommentsExtension)!
        .threadStore.resolveThread({ threadId });
    });

    await waitFor(() => {
      expect(result.current.unresolved).toHaveLength(0);
    });
    expect(result.current.resolved).toHaveLength(1);
    expect(result.current.resolved[0]?.settled).toBe(true);
  });

  it('keeps a comment whose words were deleted, as an orphan', async () => {
    const editor = open();
    const run = firstRun(editor);
    const { result } = renderHook(() => useCommentRail(editor));
    await act(async () => {
      await comment(editor, { from: run.from, to: run.from + 5 }, 'first');
    });
    await waitFor(() => expect(result.current.unresolved.length).toBeGreaterThan(0));

    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.delete(run.from, run.from + 5));
    });

    await waitFor(() => {
      expect(result.current.unresolved).toHaveLength(1);
    });
    // Still the reader's to deal with, so the button stays marked (§9.2).
    expect(result.current.unresolved.length).toBeGreaterThan(0);
  });

  it('drops an orphan that was deleted, which the body never hears about', async () => {
    // The one change that reaches the threads without touching the document:
    // the text is already gone, so the library's mark sync walks a body with
    // no marks to write and the position table is never recomputed. Read off
    // the positions alone, the deleted card would stay on the panel.
    const editor = open();
    const run = firstRun(editor);
    const { result } = renderHook(() => useCommentRail(editor));
    await act(async () => {
      await comment(editor, { from: run.from, to: run.from + 5 }, 'first');
    });
    await waitFor(() => expect(result.current.unresolved.length).toBeGreaterThan(0));

    const threadId = onlyThreadId(editor);
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.delete(run.from, run.from + 5));
    });
    await waitFor(() =>
      expect(result.current.unresolved).toHaveLength(1),
    );

    await act(async () => {
      await editor
        .getExtension(CommentsExtension)!
        .threadStore.deleteThread({ threadId });
    });

    await waitFor(() => {
      expect(result.current.unresolved).toEqual([]);
    });
  });

  it('hands back the same reading while nothing about it changed', async () => {
    // Every document change recomputes the position table, and the panel must
    // not re-render for each of them. Typing after the commented words moves
    // no card and changes no state.
    const editor = open();
    const run = firstRun(editor);
    const { result } = renderHook(() => useCommentRail(editor));
    await act(async () => {
      await comment(editor, { from: run.from, to: run.from + 5 }, 'first');
    });
    await waitFor(() => expect(result.current.unresolved.length).toBeGreaterThan(0));

    const before = result.current;
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.insertText('xyz', run.to - 1));
    });

    expect(result.current).toBe(before);
  });
});
