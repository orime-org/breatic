// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reader can do to a thread from its card (#18, A7 · A8 · A9 · A10 ·
 * A11 · A12 · A17).
 *
 * The rights are `annotationRights`, delivered with canvas annotations, so a
 * comment and a canvas note answer the same question the same way: the author
 * may withdraw their own, an owner may remove anybody's, and nobody may
 * rewrite what somebody else said. Resolving is not the author's privilege —
 * settling a discussion belongs to whoever may write.
 *
 * WHAT THE CARD OFFERS AND WHAT THE STORE ALLOWS ARE TWO ANSWERS TO ONE
 * QUESTION. The store asks its auth before every write, so a control the card
 * should not have drawn would fail rather than damage anything; what these
 * cases hold is that the card does not draw it.
 *
 * TDD: red because the card has no actions yet.
 */

import {
  render,
  screen,
  waitFor,
  renderHook,
  act,
  cleanup,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { CommentsExtension } from '@blocknote/core/comments';
import type { ProjectRole } from '@breatic/shared';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { NOTE_MAX_CHARS } from '@web/spaces/canvas/annotation/caps';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { replyToThread } from '@web/spaces/document/document-comment-thread-actions';
import { postComment } from '@web/spaces/document/document-comment-post';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Who the reader is while these cases run. */
const ME = 'u1';

describe('what a card lets a reader do', () => {
  const NAME = 'project-p/document-comment-actions';
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;
  let role: ProjectRole;

  beforeEach(async () => {
    role = 'editor';
    useCurrentUserStore.setState({
      user: { id: ME, name: 'Me', email: 'me@example.com' },
    } as never);
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({
        doc,
        name: NAME,
        caretProvider: { awareness },
        readWho: () => ({ role, viewerId: ME }),
      }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
    useCurrentUserStore.setState({ user: null } as never);
  });

  /**
   * Mounts the chrome, puts one line in the body, and opens the panel.
   * @param myRole - The role the chrome is drawn for.
   */
  async function open(myRole: ProjectRole = 'editor'): Promise<void> {
    role = myRole;
    render(<DocumentEditor handle={handle} myRole={myRole} readOnly={myRole === 'viewer'} />);
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: 'alpha bravo charlie' },
      ] as never);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await user.click(await screen.findByTestId('doc-doc-menu-comments'));
    await screen.findByTestId('doc-comment-rail');
  }

  /**
   * Writes one comment over the first word.
   * @param body - What it says.
   */
  async function comment(body: string): Promise<void> {
    let run: { from: number; to: number } | undefined;
    handle.editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.isText && run === undefined) {
        run = { from: pos, to: pos + node.nodeSize };
      }
      return true;
    });
    const view = handle.editor.prosemirrorView!;
    await act(async () => {
      view.dispatch(
        view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, {
          from: run!.from,
          to: run!.from + 5,
        }),
      );
      await postComment(handle.editor, body);
    });
  }

  /**
   * Opens the only thread, which is what puts its controls on screen.
   */
  async function read(): Promise<void> {
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
  }

  /**
   * Answers the only thread, the way a peer's reply arrives.
   * @param body - What the reply says.
   */
  async function answer(body: string): Promise<void> {
    const store = handle.editor.getExtension(CommentsExtension)!.threadStore;
    const threadId = [...store.getThreads().keys()][0]!;
    await act(async () => {
      await replyToThread(handle.editor, threadId, body);
    });
  }

  /** The only thread in the document. */
  function onlyThread(): { resolved: boolean; comments: unknown[] } {
    const store = handle.editor.getExtension(CommentsExtension)!.threadStore;
    return [...store.getThreads().values()][0] as never;
  }

  it('takes a reply and shows it under the first comment', async () => {
    await open();
    await comment('the first thing');
    await read();

    await userEvent.type(
      await screen.findByTestId('doc-comment-reply-input'),
      'the second thing',
    );
    await userEvent.click(screen.getByTestId('doc-comment-reply-save'));

    expect(await screen.findByText('the second thing')).toBeInTheDocument();
    await waitFor(() => {
      expect(onlyThread().comments).toHaveLength(2);
    });
  });

  it('refuses to send an empty reply', async () => {
    await open();
    await comment('the first thing');
    await read();

    await userEvent.type(
      await screen.findByTestId('doc-comment-reply-input'),
      '   ',
    );
    await userEvent.click(screen.getByTestId('doc-comment-reply-save'));

    expect(onlyThread().comments).toHaveLength(1);
  });

  it('resolves a thread, which takes it out of the unresolved group', async () => {
    await open();
    await comment('done with this');
    await read();

    await userEvent.click(await screen.findByTestId('doc-comment-resolve'));

    await waitFor(() => {
      expect(onlyThread().resolved).toBe(true);
    });
    expect(screen.queryByTestId('doc-comment-card')).toBeNull();
  });

  it('reopens a resolved thread from the all filter', async () => {
    await open();
    await comment('done with this');
    await read();
    await userEvent.click(await screen.findByTestId('doc-comment-resolve'));
    await waitFor(() => expect(onlyThread().resolved).toBe(true));

    await userEvent.click(screen.getByTestId('doc-comment-rail-filter-all'));
    await read();
    await userEvent.click(await screen.findByTestId('doc-comment-reopen'));

    await waitFor(() => {
      expect(onlyThread().resolved).toBe(false);
    });
  });

  it('lets the author withdraw the thread they opened', async () => {
    await open();
    await comment('never mind');
    await read();

    await userEvent.click(await screen.findByTestId('doc-comment-delete'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-comment-card')).toBeNull();
    });
    expect(
      handle.editor.getExtension(CommentsExtension)!.threadStore.getThreads()
        .size,
    ).toBe(0);
  });

  it('keeps its controls until the reader opens the thread', async () => {
    // The panel is a column of threads to read. Every card carrying a reply
    // box and two buttons is a column of controls, and only one of them is
    // about the thread the reader is on (user 2026-09-22).
    await open();
    await comment('something to answer');
    await screen.findByTestId('doc-comment-card');

    expect(screen.queryByTestId('doc-comment-reply-input')).toBeNull();
    expect(screen.queryByTestId('doc-comment-resolve')).toBeNull();
    expect(screen.queryByTestId('doc-comment-delete')).toBeNull();
  });

  it('offers them once the reader opens it', async () => {
    await open();
    await comment('something to answer');

    await read();

    expect(
      await screen.findByTestId('doc-comment-reply-input'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('doc-comment-resolve')).toBeInTheDocument();
    expect(screen.getByTestId('doc-comment-delete')).toBeInTheDocument();
  });

  it('bounds a reply at the length one person may write on a comment', async () => {
    await open();
    await comment('the first thing');
    await read();

    expect(screen.getByTestId('doc-comment-reply-input')).toHaveAttribute(
      'maxlength',
      String(NOTE_MAX_CHARS),
    );
  });

  it('offers nothing to press until the reply box holds words', async () => {
    await open();
    await comment('the first thing');
    await read();

    expect(screen.queryByTestId('doc-comment-reply-save')).toBeNull();
    expect(screen.queryByTestId('doc-comment-reply-cancel')).toBeNull();

    await userEvent.type(
      screen.getByTestId('doc-comment-reply-input'),
      'half a thought',
    );

    expect(screen.getByTestId('doc-comment-reply-save')).toBeInTheDocument();
    expect(screen.getByTestId('doc-comment-reply-cancel')).toBeInTheDocument();
  });

  it('throws the words away when the reply is called off', async () => {
    await open();
    await comment('the first thing');
    await read();
    await userEvent.type(
      screen.getByTestId('doc-comment-reply-input'),
      'never mind',
    );

    await userEvent.click(screen.getByTestId('doc-comment-reply-cancel'));

    expect(screen.getByTestId('doc-comment-reply-input')).toHaveValue('');
    expect(screen.queryByTestId('doc-comment-reply-save')).toBeNull();
    expect(onlyThread().comments).toHaveLength(1);
  });

  it('sends the reply on Enter', async () => {
    await open();
    await comment('the first thing');
    await read();

    await userEvent.type(
      screen.getByTestId('doc-comment-reply-input'),
      'answered from the keyboard{Enter}',
    );

    expect(
      await screen.findByText('answered from the keyboard'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(onlyThread().comments).toHaveLength(2);
    });
  });

  it('keeps the words while an input method is composing them', async () => {
    // A reader choosing characters presses Enter to pick one, and that press
    // belongs to the IME. `KeyboardEvent.isComposing` is what says so.
    await open();
    await comment('the first thing');
    await read();
    const box = screen.getByTestId('doc-comment-reply-input');
    await userEvent.type(box, 'half a thought');

    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });

    expect(onlyThread().comments).toHaveLength(1);
    expect(box).toHaveValue('half a thought');
  });

  it('takes Shift+Enter as a line inside the reply', async () => {
    await open();
    await comment('the first thing');
    await read();
    const box = screen.getByTestId('doc-comment-reply-input');
    await userEvent.type(box, 'one');

    await userEvent.type(box, '{Shift>}{Enter}{/Shift}two');

    expect(onlyThread().comments).toHaveLength(1);
    expect(box).toHaveValue('one\ntwo');
  });

  it('folds a thread nobody is reading down to two comments', async () => {
    // The first comment and the most recent one, which is how CKEditor's
    // sidebar folds an inactive thread (`maxCommentsWhenCollapsed`, 2).
    await open();
    await comment('the first');
    await answer('the second');
    await answer('the third');
    await answer('the fourth');

    expect(screen.getAllByTestId('doc-comment-entry')).toHaveLength(2);
    expect(screen.getByText('the first')).toBeInTheDocument();
    expect(screen.getByText('the fourth')).toBeInTheDocument();
    expect(screen.queryByText('the second')).toBeNull();
    expect(screen.getByTestId('doc-comment-folded-count')).toHaveTextContent(
      '2',
    );
  });

  it('shows every comment once the reader opens it', async () => {
    await open();
    await comment('the first');
    await answer('the second');
    await answer('the third');
    await answer('the fourth');

    await read();

    expect(screen.getAllByTestId('doc-comment-entry')).toHaveLength(4);
    expect(screen.getByText('the second')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-comment-folded-count')).toBeNull();
  });

  it('leaves a thread with nothing to hold back unfolded', async () => {
    await open();
    await comment('the first');
    await answer('the second');

    expect(screen.getAllByTestId('doc-comment-entry')).toHaveLength(2);
    expect(screen.queryByTestId('doc-comment-folded-count')).toBeNull();
  });

  it('offers a viewer nothing to write with', async () => {
    // A17: they read the whole panel and may not write in it. The store would
    // refuse anyway; what this holds is that the card does not offer.
    await open('editor');
    await comment('something to look at');
    await screen.findByTestId('doc-comment-card');

    cleanup();
    await open('viewer');

    expect(await screen.findByTestId('doc-comment-card')).toBeInTheDocument();
    await read();
    expect(screen.queryByTestId('doc-comment-reply-input')).toBeNull();
    expect(screen.queryByTestId('doc-comment-resolve')).toBeNull();
    expect(screen.queryByTestId('doc-comment-delete')).toBeNull();
  });
});
