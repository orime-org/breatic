// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel down the right-hand side, and the way in (#18, A4 · A5 · A9 ·
 * A13 · A15 · A18).
 *
 * One rule governs when it appears: the reader opens it. A comment arriving
 * from a peer while they are typing moves nothing on screen — it marks the
 * `⋯` button and waits (§5). That is the rule Gate 1 was opened over: a panel
 * that shows itself pushes the body sideways under a caret somebody is using.
 *
 * The cards are `commentRail`'s reading drawn out: unresolved first in body
 * order, resolved behind their own heading, orphans saying the text they were
 * about is gone.
 *
 * TDD: red because neither the menu row nor the panel exists yet.
 */

import { render, screen, waitFor, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentCommentThreads } from '@breatic/shared';

import { toast } from '@web/lib/toast';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftRangeIn,
} from '@web/spaces/document/document-comment-draft-range';
import {
  selectThreads,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import {
  COMMENT_MARK,
  asCommentBody,
} from '@web/spaces/document/document-comment-extension';
import { postComment } from '@web/spaces/document/document-comment-post';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// The real one throughout, wrapped so one case can ask for the answer it
// gives when there is no range left to aim at.
vi.mock('@web/spaces/document/document-comment-post', async (real) => {
  const actual =
    await real<typeof import('@web/spaces/document/document-comment-post')>();
  return { ...actual, postComment: vi.fn(actual.postComment) };
});

describe('the comment panel', () => {
  const NAME = 'project-p/document-comment-rail';
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({
        doc,
        name: NAME,
        caretProvider: { awareness },
        readWho: () => ({ role: 'editor', viewerId: 'u1' }),
      }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /**
   * Mounts the editor's chrome and puts one line in the body.
   *
   * The content goes in after the render: the editor is mounted by
   * `DocumentEditor`'s own effect, and writing blocks into an unmounted one
   * leaves the body empty.
   */
  function show(myRole: 'editor' | 'viewer' = 'editor'): void {
    const rendered = render(
      <DocumentEditor
        handle={handle}
        myRole={myRole}
        readOnly={myRole === 'viewer'}
      />,
    );
    // One case takes the right to write away mid-draft. Both props move
    // together, the way they do in the product: `readOnly` is what decides
    // whether the chrome carrying the notice is mounted at all, and it turns
    // over on the same change that makes the reader a viewer (A22).
    asRole = (next) => {
      rendered.rerender(
        <DocumentEditor
          handle={handle}
          myRole={next}
          readOnly={next === 'viewer'}
        />,
      );
    };
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: 'alpha bravo charlie' },
      ] as never);
    });
  }

  /** Renders again under a different role, set by the last `show`. */
  let asRole: (next: 'editor' | 'viewer') => void;

  /** The words the open draft is aimed at, as the body stands. */
  function aimedWords(): string {
    const at = draftRangeIn(handle.editor.prosemirrorState);
    if (at === null) return '';
    return handle.editor.prosemirrorState.doc.textBetween(at.from, at.to);
  }

  /** Puts the focus somewhere the reader could have put it: the body. */
  async function clickTheBody(): Promise<void> {
    await userEvent.click(handle.editor.prosemirrorView!.dom);
  }

  /** Where the first run of text sits. */
  function firstRun(): { from: number; to: number } {
    let at: { from: number; to: number } | undefined;
    handle.editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.isText && at === undefined) {
        at = { from: pos, to: pos + node.nodeSize };
      }
      return true;
    });
    return at!;
  }

  /**
   * Puts one comment on part of the first line, the way a peer's arrives: a
   * thread in the store and a mark over the words.
   *
   * Deliberately not through the entries and `postComment`. That path opens a
   * draft, and a draft opens the panel (A1) — which is the very thing several
   * of these cases are here to say does not happen on its own.
   * @param from - How far into the line it starts.
   * @param to - Where it ends.
   * @param body - What the comment says.
   */
  async function comment(
    from: number,
    to: number,
    body: string,
  ): Promise<void> {
    const run = firstRun();
    const comments = handle.editor.getExtension(CommentsExtension)!;
    await act(async () => {
      const thread = await comments.threadStore.createThread({
        initialComment: { body: asCommentBody(body) },
      });
      const view = handle.editor.prosemirrorView!;
      const mark = view.state.schema.marks[COMMENT_MARK]!.create({
        threadId: thread.id,
        orphan: false,
      });
      view.dispatch(
        view.state.tr.addMark(run.from + from, run.from + to, mark),
      );
    });
  }

  /**
   * Aims a draft at part of the first line, without posting it.
   * @param from - How far into the line it starts.
   * @param to - Where it ends.
   */
  function aimDraft(from: number, to: number): void {
    const run = firstRun();
    const view = handle.editor.prosemirrorView!;
    act(() => {
      view.dispatch(
        view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, {
          from: run.from + from,
          to: run.from + to,
        }),
      );
    });
  }

  /** Opens the whole-document menu and presses the comments row. */
  async function pressCommentsRow(): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await user.click(await screen.findByTestId('doc-doc-menu-comments'));
  }

  it('stays away until the reader opens it', () => {
    show();
    expect(screen.queryByTestId('doc-comment-rail')).toBeNull();
  });

  it('opens from the menu row', async () => {
    show();

    await pressCommentsRow();

    expect(await screen.findByTestId('doc-comment-rail')).toBeInTheDocument();
  });

  it('closes from its own close button', async () => {
    show();
    await pressCommentsRow();
    await screen.findByTestId('doc-comment-rail');

    await userEvent.click(screen.getByTestId('doc-comment-rail-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-comment-rail')).toBeNull();
    });
  });

  it('marks the button while something is unresolved, and only then', async () => {
    show();
    expect(screen.queryByTestId('doc-doc-menu-dot')).toBeNull();

    await comment(0, 5, 'first');

    await waitFor(() => {
      expect(screen.getByTestId('doc-doc-menu-dot')).toBeInTheDocument();
    });
  });

  it('does not open itself when a comment arrives', async () => {
    // A15: the reader is typing and a peer comments. Nothing on screen may
    // move — the body would shift sideways under the caret.
    show();

    await comment(0, 5, 'from a peer');

    await waitFor(() => {
      expect(screen.getByTestId('doc-doc-menu-dot')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('doc-comment-rail')).toBeNull();
  });

  it('says nothing has been commented on when nothing has', async () => {
    show();
    await pressCommentsRow();

    expect(await screen.findByTestId('doc-comment-rail-empty')).toBeInTheDocument();
  });

  it('draws a card per thread, in body order, quoting the words', async () => {
    show();
    await comment(6, 11, 'about bravo');
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await screen.findByTestId('doc-comment-rail');

    const quotes = Array.from(
      document.querySelectorAll('[data-testid="doc-comment-card-quote"]'),
    ).map((element) => element.textContent);

    expect(quotes).toEqual(['alpha', 'bravo']);
  });

  it('shows what each comment says', async () => {
    show();
    await comment(0, 5, 'the whole point');
    await pressCommentsRow();

    expect(await screen.findByText('the whole point')).toBeInTheDocument();
  });

  it('marks the card whose highlight the reader pressed', async () => {
    // A6: pressing a highlight opens that comment. With the panel open, "open"
    // is the card being marked and brought into view.
    show();
    await comment(0, 5, 'about alpha');
    await comment(6, 11, 'about bravo');
    await pressCommentsRow();
    const cards = await screen.findAllByTestId('doc-comment-card');
    expect(cards.map((card) => card.getAttribute('data-selected'))).toEqual([
      'false',
      'false',
    ]);

    const second = cards[1]!.getAttribute('data-thread')!;
    act(() => {
      selectThreads(handle.editor, [second]);
    });

    await waitFor(() => {
      const marked = screen
        .getAllByTestId('doc-comment-card')
        .filter((card) => card.getAttribute('data-selected') === 'true');
      expect(marked.map((card) => card.getAttribute('data-thread'))).toEqual([
        second,
      ]);
    });
  });

  it('deepens the highlight of the thread being read', async () => {
    show();
    await comment(0, 5, 'about alpha');
    const threadId = [
      ...handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads()
        .keys(),
    ][0]!;

    act(() => {
      selectThreads(handle.editor, [threadId]);
    });

    const deepened = handle.editor.domElement?.querySelector(
      '.doc-comment-mark-reading',
    );
    expect(deepened?.textContent).toBe('alpha');
  });

  it('opens itself when a press in the body names a comment', async () => {
    // A6: a press opens the comment, and the panel is where a comment is
    // read (user 2026-09-22). Nothing floats over the body.
    show();
    await comment(0, 5, 'about alpha');
    expect(screen.queryByTestId('doc-comment-rail')).toBeNull();
    const threadId = [
      ...handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads()
        .keys(),
    ][0]!;

    act(() => {
      selectThreads(handle.editor, [threadId]);
    });

    const rail = await screen.findByTestId('doc-comment-rail');
    expect(rail).toHaveTextContent('about alpha');
  });

  it('marks both where two comments cover the same words', async () => {
    // A20: the reader picks, so both are marked rather than one guessed at.
    show();
    await comment(0, 11, 'the wider one');
    await comment(6, 19, 'the other one');
    const ids = [
      ...handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads()
        .keys(),
    ];

    act(() => {
      selectThreads(handle.editor, ids);
    });

    await screen.findByTestId('doc-comment-rail');
    await waitFor(() => {
      const marked = screen
        .getAllByTestId('doc-comment-card')
        .filter((card) => card.getAttribute('data-selected') === 'true');
      expect(marked).toHaveLength(2);
    });
  });

  it('takes a settled thread out of the open filter', async () => {
    // A9: the card is read again behind "all", and the open filter is what a
    // reader has left to work through.
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await screen.findAllByTestId('doc-comment-card');
    const threadId = [
      ...handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads()
        .keys(),
    ][0]!;

    await act(async () => {
      await handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.resolveThread({ threadId });
    });

    await waitFor(() => {
      expect(screen.queryAllByTestId('doc-comment-card')).toHaveLength(0);
    });
  });

  it('says so on a card whose words were deleted', async () => {
    // A13: the thread stays and stays readable, with the highlight gone.
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await screen.findByTestId('doc-comment-rail');

    const run = firstRun();
    const view = handle.editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.delete(run.from, run.from + 5));
    });

    expect(
      await screen.findByTestId('doc-comment-card-orphaned'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('doc-comment-card-quote')).toBeNull();
  });

  it('opens the comment in the body when a card is pressed', async () => {
    // The press goes the other way too: reading a card is saying which run of
    // the body is being talked about, so that run is marked.
    show();
    await comment(0, 5, 'about alpha');
    await comment(6, 11, 'about bravo');
    await pressCommentsRow();
    const cards = await screen.findAllByTestId('doc-comment-card');
    const second = cards[1]!.getAttribute('data-thread')!;

    await userEvent.click(cards[1]!);

    await waitFor(() => {
      expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([
        second,
      ]);
    });
  });

  it('takes the whole-document entry away while it is open', async () => {
    // The entry is the way in, and a way in to something already open says
    // nothing. Closing the panel is the panel's own button (user 2026-09-22).
    show();
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();

    await pressCommentsRow();

    await waitFor(() => {
      expect(screen.queryByTestId('doc-doc-menu-trigger')).toBeNull();
    });
  });

  it('brings the entry back once the panel is closed', async () => {
    show();
    await pressCommentsRow();
    await screen.findByTestId('doc-comment-rail');

    await userEvent.click(screen.getByTestId('doc-comment-rail-close'));

    await waitFor(() => {
      expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
    });
  });

  /** How many runs of the body are painted as the one being read. */
  function deepened(): number {
    return (
      handle.editor.domElement?.querySelectorAll('.doc-comment-mark-reading')
        .length ?? 0
    );
  }

  it('lets go of a card that leaves while the pointer is on it', async () => {
    // Measured 2026-09-23: resolving is pressed with the pointer on the card,
    // the card then leaves the open filter, and `onMouseLeave` never fires —
    // so those words stayed deep long after the thread was settled (A8).
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    // Resolve is offered on the card being read, so the press that settles a
    // thread always lands with the pointer on its card.
    const card = await screen.findByTestId('doc-comment-card');
    await userEvent.click(card);
    await userEvent.hover(card);
    await waitFor(() => {
      expect(deepened()).toBe(1);
    });

    await userEvent.click(screen.getByTestId('doc-comment-resolve'));
    // The paint is redrawn on the next thing the reader does in the body.
    // Measured 2026-09-23: it came back deep, one press after settling.
    act(() => {
      selectThreads(handle.editor, []);
    });

    await waitFor(() => {
      expect(deepened()).toBe(0);
    });
  });

  it('leaves a settled thread as prose while its card is read and hovered', async () => {
    // Design §9.5, invariant one. Under "all" the settled card stays on the
    // panel, so nothing releases the reading — and the paint has to refuse on
    // its own. Measured in a browser 2026-09-23: hovering the settled card
    // put the active colour back on words A8 promises read as prose.
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    await userEvent.click(screen.getByTestId('doc-comment-resolve'));
    await userEvent.click(
      screen.getByTestId('doc-comment-rail-filter-all'),
    );

    const settled = await screen.findByTestId('doc-comment-card');
    await userEvent.click(settled);
    await userEvent.hover(settled);

    await waitFor(() => {
      expect(screen.getAllByTestId('doc-comment-card')).toHaveLength(1);
    });
    expect(deepened()).toBe(0);
  });

  it('takes the paint off when the panel is closed from the keyboard', async () => {
    // Measured 2026-09-23: the pointer can rest on a card while the keyboard
    // works the close button, so `onMouseLeave` never fires and the hover
    // outlives the panel that is the only thing able to release it — one run
    // of the body stayed painted with nothing on screen to explain it.
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.hover(await screen.findByTestId('doc-comment-card'));
    await waitFor(() => {
      expect(deepened()).toBe(1);
    });

    screen.getByTestId('doc-comment-rail-close').focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByTestId('doc-comment-rail')).toBeNull();
    });
    expect(deepened()).toBe(0);
  });

  it('keeps one thread deep while another is settled', async () => {
    // The paint was carried across a change by mapping the decorations, and a
    // settle rewrites the marks of the thread it settles — which drops the
    // decoration standing over a different thread in the same body. Measured
    // 2026-09-23: reading the second of two threads, settling the first took
    // the second's paint with it while the card still said it was open.
    show();
    await comment(0, 5, 'about alpha');
    await comment(6, 11, 'about bravo');
    const ids = [
      ...handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads()
        .keys(),
    ];
    act(() => {
      selectThreads(handle.editor, [ids[1]!]);
    });
    await waitFor(() => {
      expect(deepened()).toBe(1);
    });

    const comments = handle.editor.getExtension(CommentsExtension)!;
    await act(async () => {
      await comments.threadStore.resolveThread({ threadId: ids[0]! });
    });

    await waitFor(() => {
      expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([
        ids[1],
      ]);
    });
    expect(deepened()).toBe(1);
  });

  it('keeps a half-written reply while its thread is settled and reopened', async () => {
    // The reply lived in the card's own state, so a thread settled by a peer
    // took the reader's unsent words with it when the card unmounted.
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    await userEvent.type(
      await screen.findByTestId('doc-comment-reply-input'),
      'half written',
    );

    await userEvent.click(screen.getByTestId('doc-comment-resolve'));
    await userEvent.click(screen.getByTestId('doc-comment-rail-filter-all'));
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    await userEvent.click(screen.getByTestId('doc-comment-reopen'));

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-reply-input')).toHaveValue(
        'half written',
      );
    });
  });

  it('says the filter is empty rather than the document', async () => {
    // A9: with the one comment settled, the open filter has nothing in it
    // while the document still holds a thread to read behind "all". Saying
    // "no comments yet" there sends the reader looking for something to
    // press, and the thing they want is one filter away.
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    await userEvent.click(screen.getByTestId('doc-comment-resolve'));

    const empty = await screen.findByTestId('doc-comment-rail-empty');
    expect(empty.textContent).not.toBe(
      'No comments yet. Select some text, or use the handle beside a line.',
    );
    expect(empty.textContent).toBe('Nothing unresolved.');
  });

  it('offers its controls on one of two overlapping threads, not both', async () => {
    // A20: pressing where two comments overlap lists both so the reader can
    // pick. Opening both puts two reply boxes on screen at once and neither
    // of them is the one they meant.
    show();
    await comment(0, 11, 'the wider one');
    await comment(6, 19, 'the other one');
    await pressCommentsRow();
    const ids = [
      ...handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads()
        .keys(),
    ];

    act(() => {
      selectThreads(handle.editor, ids);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('doc-comment-card')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('doc-comment-reply-input')).toHaveLength(1);
  });

  it('stops watching a card once it has left the panel', async () => {
    // By the node, not by the call count: the primitives the panel is built
    // from watch elements of their own, so a bare `toHaveBeenCalled` passes
    // without the panel releasing anything.
    const released = vi.spyOn(
      globalThis.ResizeObserver.prototype,
      'unobserve',
    );
    /** Whether a card's own element has been handed back. */
    const releasedACard = (): boolean =>
      released.mock.calls.some(
        ([node]) => (node as HTMLElement | undefined)?.dataset?.thread !== undefined,
      );

    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    released.mockClear();
    expect(releasedACard()).toBe(false);

    await userEvent.click(screen.getByTestId('doc-comment-resolve'));

    await waitFor(() => {
      expect(releasedACard()).toBe(true);
    });
    released.mockRestore();
  });

  describe('the card a new comment is written in', () => {
    it('opens the rail and puts a card in it', async () => {
      // A1 · A2: the entries aim a draft, and that is what the rail answers.
      show();

      aimDraft(0, 5);

      await waitFor(() => {
        expect(screen.getByTestId('doc-comment-rail')).toBeInTheDocument();
      });
      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
    });

    it('carries no button until the reader writes something', async () => {
      // A29. The reply box answers the same way, and for the same reason: a
      // control that would send nothing has no business being on screen.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      expect(screen.queryByTestId('doc-comment-draft-save')).toBeNull();
      expect(screen.queryByTestId('doc-comment-draft-cancel')).toBeNull();

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'worth saying',
      );

      expect(screen.getByTestId('doc-comment-draft-save')).toBeInTheDocument();
      expect(
        screen.getByTestId('doc-comment-draft-cancel'),
      ).toBeInTheDocument();
    });

    it('offers neither resolve nor delete, there being no thread yet', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'worth saying',
      );

      expect(screen.queryByTestId('doc-comment-resolve')).toBeNull();
      expect(screen.queryByTestId('doc-comment-delete')).toBeNull();
    });

    it('says nothing about an empty rail while a card is waiting to be filled', async () => {
      // A1's commonest path is the first comment on a document that has none,
      // and the empty-rail line would be arguing with the card on screen.
      show();

      aimDraft(0, 5);

      await screen.findByTestId('doc-comment-draft-card');
      expect(screen.queryByTestId('doc-comment-rail-empty')).toBeNull();
    });

    it('lets an empty draft go when the focus leaves, and keeps the rail', async () => {
      // A30. The rail stays because opening it was the reader's own doing.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      await clickTheBody();

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
      expect(screen.getByTestId('doc-comment-rail')).toBeInTheDocument();
    });

    it('keeps a draft that has words in it when the focus leaves', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );

      await clickTheBody();

      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
      expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue(
        'half a thought',
      );
    });

    it('writes the comment on save, and the card becomes a real one', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'said something',
      );

      await userEvent.click(screen.getByTestId('doc-comment-draft-save'));

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
      expect(screen.getByTestId('doc-comment-card')).toBeInTheDocument();
    });

    it('stays away while no draft is open', async () => {
      show();

      await pressCommentsRow();

      expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
    });

    it('says so when the thread cannot be opened', async () => {
      // The store asks its auth before writing, and the words may be gone by
      // the time the press lands. Whether that happens is not ours to
      // promise; whether the reader is told is.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      const comments = handle.editor.getExtension(CommentsExtension)!;
      vi.spyOn(comments.threadStore, 'createThread').mockRejectedValue(
        new Error('refused'),
      );

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'a thought',
      );
      await userEvent.click(screen.getByTestId('doc-comment-draft-save'));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled();
      });
    });

    it('keeps the words when the thread cannot be opened', async () => {
      // The reply box answers the same refusal by keeping what was typed, and
      // this is the one write that carries the reader's only copy of it.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      const comments = handle.editor.getExtension(CommentsExtension)!;
      vi.spyOn(comments.threadStore, 'createThread').mockRejectedValue(
        new Error('refused'),
      );

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'a thought',
      );
      await userEvent.click(screen.getByTestId('doc-comment-draft-save'));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled();
      });
      expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue(
        'a thought',
      );
    });

    it('leaves the card open when the post wrote nothing', async () => {
      // `postComment` answers null when there is no range left to aim at,
      // which means what a refusal means: nothing was written. Closing on it
      // takes the card away before the effect watching the range can raise
      // A21's notice, so the reader is left with no comment and no account.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      vi.mocked(postComment).mockResolvedValueOnce(null);

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'a thought',
      );
      await userEvent.click(screen.getByTestId('doc-comment-draft-save'));

      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
    });

    it('marks the words it was aimed at with what was written', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'a first thought',
      );
      await userEvent.click(screen.getByTestId('doc-comment-draft-save'));

      await waitFor(() => {
        expect([...documentCommentThreads(doc).keys()]).toHaveLength(1);
      });
      const comments = handle.editor.getExtension(CommentsExtension)!;
      const stored = [...comments.threadStore.getThreads().values()][0];
      expect(JSON.stringify(stored?.comments[0]?.body)).toContain(
        'a first thought',
      );
    });

    it('refuses to write words that are only spaces', async () => {
      // `reduceDraft` answers a save on blank words by leaving the draft
      // alone, so the card stays and nothing is made. The pair of buttons
      // never appears over them either (A29), which leaves the Enter key as
      // the way to ask.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), '   ');
      await userEvent.keyboard('{Enter}');

      expect([...documentCommentThreads(doc).keys()]).toHaveLength(0);
      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
    });

    it('throws the words away on Escape, per the demo', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'never mind',
      );
      await userEvent.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
      expect([...documentCommentThreads(doc).keys()]).toHaveLength(0);
    });

    it('closes on Escape with nothing typed', async () => {
      // A reader who presses the entry and changes their mind before typing.
      // Discarding and saving differ here: a save on blank words leaves the
      // draft alone, so the card would stay.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      await userEvent.click(screen.getByTestId('doc-comment-draft-input'));
      await userEvent.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
    });

    it('closes the draft in the plugin too, not only on screen', async () => {
      // The range IS whether a draft is open, so a save that took the card
      // off screen but left the range behind would leave the plugin saying
      // one is still open — and whoever reads it next would believe it.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'done',
      );
      await userEvent.click(screen.getByTestId('doc-comment-draft-save'));

      await waitFor(() => {
        expect(draftRangeIn(handle.editor.prosemirrorState)).toBeNull();
      });
    });

    it('follows the words when a peer inserts text above', async () => {
      // The range is mapped through every edit, so it keeps naming the same
      // words rather than whatever now sits at those offsets.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      expect(aimedWords()).toBe('bravo');

      const view = handle.editor.prosemirrorView!;
      act(() => {
        view.dispatch(view.state.tr.insertText('xx ', firstRun().from));
      });

      await waitFor(() => {
        expect(aimedWords()).toBe('bravo');
      });
      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
    });

    it('says so when the words it was aimed at are deleted', async () => {
      // A21. The card outlives its range for exactly this: the reader is owed
      // an account of a closing that was not their doing.
      show();
      const run = firstRun();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'about this',
      );

      const view = handle.editor.prosemirrorView!;
      act(() => {
        view.dispatch(view.state.tr.delete(run.from, run.from + 5));
      });

      await waitFor(() => {
        expect(
          screen.getByTestId('doc-comment-draft-dropped'),
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('doc-comment-draft-input')).toBeNull();
    });

    it('takes that notice away when the reader is done with it', async () => {
      // Nothing else can: the range is already gone, so the two gestures the
      // card otherwise closes on have nothing left to clear.
      show();
      const run = firstRun();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'about this',
      );
      const view = handle.editor.prosemirrorView!;
      act(() => {
        view.dispatch(view.state.tr.delete(run.from, run.from + 5));
      });
      await screen.findByTestId('doc-comment-draft-dropped');

      await userEvent.click(screen.getByTestId('doc-comment-draft-dismiss'));

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
    });

    it('says so when the reader loses the right to write mid-draft', async () => {
      // A22. The same debt as A21, from the other direction.
      show('editor');
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a',
      );

      act(() => {
        asRole('viewer');
      });

      await waitFor(() => {
        expect(
          screen.getByTestId('doc-comment-draft-dropped'),
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('doc-comment-draft-input')).toBeNull();
    });
  });

});
