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

import {
  render,
  screen,
  waitFor,
  renderHook,
  act,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';

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
import { openCommentDraft } from '@web/spaces/document/document-comment-entries';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { rowById } from '@web/spaces/document/document-row-by-id';
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
  function show(
    myRole: 'editor' | 'viewer' = 'editor',
    lines: readonly string[] = ['alpha bravo charlie'],
  ): void {
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
    let current = rendered;
    mountBody = () => {
      current = render(
        <DocumentEditor
          handle={handle}
          myRole={myRole}
          readOnly={myRole === 'viewer'}
        />,
      );
    };
    unmountBody = () => {
      current.unmount();
    };
    remount = () => {
      unmountBody();
      mountBody();
    };
    act(() => {
      handle.editor.replaceBlocks(
        handle.editor.document,
        lines.map((content) => ({ type: 'paragraph', content })) as never,
      );
    });
  }

  /** Renders again under a different role, set by the last `show`. */
  let asRole: (next: 'editor' | 'viewer') => void;

  /**
   * Takes the chrome off and puts it back over the same editor, which is
   * what a Space tab switch does: the editor belongs to the document and
   * outlives the mount.
   */
  let remount: () => void;

  /** The two halves of a tab switch, for a case that acts in between. */
  let unmountBody: () => void;
  let mountBody: () => void;

  /**
   * Makes an edit on a second replica and brings it in, the way a peer's
   * edit arrives: through Yjs, not through a ProseMirror transaction.
   * @param edit - What the peer does to the first line's text.
   */
  function peerEdits(edit: (line: Y.XmlText) => void): void {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const find = (at: Y.XmlElement | Y.XmlFragment): Y.XmlText | null => {
      for (const child of at.toArray()) {
        if (child instanceof Y.XmlText) return child;
        if (child instanceof Y.XmlElement) {
          const inner = find(child);
          if (inner !== null) return inner;
        }
      }
      return null;
    };
    const line = find(documentBodyFragment(peer))!;
    peer.transact(() => {
      edit(line);
    });
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    });
    peer.destroy();
  }

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

  /**
   * Where each line's text starts, in body order.
   * @param state - The editor state to read; the reader's own by default.
   * @returns One position per run of text.
   */
  function lineStarts(
    state = handle.editor.prosemirrorState,
  ): readonly number[] {
    const at: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.isText) at.push(pos);
      return true;
    });
    return at;
  }

  /**
   * A second editor over a copy of the body, whose every change comes in to
   * the reader's the way a co-editor's does. Its own editor makes the changes,
   * so a block split or joined is rebuilt in the shared document exactly as a
   * peer's would be.
   * @returns The peer's editor.
   */
  async function peerEditor(): Promise<DocumentEditorHandle> {
    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
    peerDoc.on('update', (update: Uint8Array) => {
      act(() => {
        Y.applyUpdate(doc, update);
      });
    });
    const peerAwareness = new Awareness(peerDoc);
    const { result } = renderHook(() =>
      useDocumentEditor({
        doc: peerDoc,
        name: 'project-p/document-comment-rail-peer',
        caretProvider: { awareness: peerAwareness },
        readWho: () => ({ role: 'editor', viewerId: 'u2' }),
      }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    const peer = result.current!;
    const host = document.createElement('div');
    document.body.append(host);
    render(<DocumentEditor handle={peer} myRole='editor' />, {
      container: host,
    });
    peers.push(peerAwareness);
    return peer;
  }

  /** The peers' awareness, destroyed with the case. */
  const peers: Awareness[] = [];
  afterEach(() => {
    for (const peer of peers.splice(0)) peer.destroy();
  });

  /**
   * Presses a key in the peer's editor with the caret at a position.
   * @param peer - The peer's editor.
   * @param at - Where the caret is.
   * @param key - The key.
   */
  async function peerPresses(
    peer: DocumentEditorHandle,
    at: number,
    key: string,
  ): Promise<void> {
    const { TextSelection } = await import('@tiptap/pm/state');
    act(() => {
      const view = peer.editor.prosemirrorView!;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, at)),
      );
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });
  }

  /** The body's lines as the reader's editor has them. */
  function lines(): readonly string[] {
    return handle.editor.document.map((block) =>
      (block.content as unknown as readonly { text: string }[])
        .map((run) => run.text)
        .join(''),
    );
  }

  /**
   * Aims a draft at an absolute range.
   * @param from - Its start.
   * @param to - Its end.
   */
  function aimAt(from: number, to: number): void {
    act(() => {
      openCommentDraft(handle.editor, { from, to });
    });
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
    act(() => {
      openCommentDraft(handle.editor, {
        from: run.from + from,
        to: run.from + to,
      });
    });
  }

  /** The body's paint over the words a draft is aimed at, if any. */
  function draftPaint(): HTMLElement | null {
    return handle.editor.prosemirrorView!.dom.querySelector<HTMLElement>(
      '.doc-comment-draft-mark',
    );
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

  it('keeps a half-written reply across a Space tab switch', async () => {
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    await userEvent.type(
      await screen.findByTestId('doc-comment-reply-input'),
      'half written',
    );

    // The card being read is kept in the editor, so the panel comes back
    // open on it by itself.
    remount();

    expect(
      await screen.findByTestId('doc-comment-reply-input'),
    ).toHaveValue('half written');
  });

  it('drops a half-written reply when the reader closes the panel', async () => {
    // Closing the panel is the reader's own doing, unlike a tab switch
    // (design §9.6).
    show();
    await comment(0, 5, 'about alpha');
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));
    await userEvent.type(
      await screen.findByTestId('doc-comment-reply-input'),
      'half written',
    );

    await userEvent.click(screen.getByTestId('doc-comment-rail-close'));
    await pressCommentsRow();
    await userEvent.click(await screen.findByTestId('doc-comment-card'));

    expect(await screen.findByTestId('doc-comment-reply-input')).toHaveValue('');
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

    it('lets an empty draft go on a press in the body, and keeps the rail', async () => {
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

    it('lets an empty draft go on a press on blank panel space', async () => {
      // A30: blank panel space is outside the card, and takes no focus.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      fireEvent.pointerDown(screen.getByTestId('doc-comment-rail'));

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
    });

    it('keeps an empty draft on a press inside the card, off the box', async () => {
      // The card's own padding is the draft; a browser drops the focus to the
      // page on that press, which must not read as the reader leaving.
      show();
      aimDraft(0, 5);
      const card = await screen.findByTestId('doc-comment-draft-card');

      fireEvent.pointerDown(card);
      act(() => {
        screen.getByTestId('doc-comment-draft-input').blur();
      });

      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
    });

    it('keeps an empty draft when the focus moves without a press', async () => {
      // A menu handing the focus back to the body as it closes (the block
      // handle's comment entry does exactly this), or the reader switching
      // windows: neither is the reader pressing somewhere else.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      act(() => {
        handle.editor.prosemirrorView!.focus();
      });

      expect(screen.getByTestId('doc-comment-draft-card')).toBeInTheDocument();
    });

    it('keeps its words and its place when a peer edits elsewhere', async () => {
      // A peer's edit arrives as one replacement of the whole body, so
      // following it by the transaction's mapping lost the range every time.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');

      peerEdits((line) => {
        line.insert(line.length, 'x');
      });

      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue('half');
      expect(draftPaint()?.textContent).toBe('bravo');
    });

    it('follows its words when a peer deletes something before them', async () => {
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');

      peerEdits((line) => {
        line.delete(0, 6);
      });

      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(draftPaint()?.textContent).toBe('bravo');
    });

    it('keeps its place when the reader undoes an edit elsewhere', async () => {
      // An undo comes back through Yjs as well, as one replacement of the
      // whole body.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      // Its own undo step, apart from the line `show` wrote.
      handle.undoManager.stopCapturing();
      act(() => {
        const view = handle.editor.prosemirrorView!;
        view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 3));
      });
      handle.undoManager.stopCapturing();

      act(() => {
        handle.undoManager.undo();
      });

      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(draftPaint()?.textContent).toBe('bravo');
    });

    it('leaves out what a peer types right after its words', async () => {
      // Words typed against the end are not the ones the reader chose.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');

      peerEdits((line) => {
        line.insert(11, 'QQ');
      });

      expect(draftPaint()?.textContent).toBe('bravo');
    });

    it('keeps out what the reader typed after its words when a peer edits', async () => {
      // The reader's own typing and a later peer edit must agree on the range:
      // the peer edit carries it from where it is now.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      const run = firstRun();
      act(() => {
        const view = handle.editor.prosemirrorView!;
        view.dispatch(view.state.tr.insertText('zz', run.from + 11));
      });

      peerEdits((line) => {
        line.insert(0, 'q');
      });

      expect(draftPaint()?.textContent).toBe('bravo');
    });

    it('keeps its words when the reader turns their line into a heading', async () => {
      // Changing the block's type makes new text underneath the same words; a
      // later peer edit must not read that as the words being deleted.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
      act(() => {
        handle.editor.updateBlock(handle.editor.document[0]!, {
          type: 'heading',
          props: { level: 2 },
        } as never);
      });

      peerEdits((line) => {
        line.insert(line.length, '!');
      });

      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(draftPaint()?.textContent).toBe('bravo');
      expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue('half');
    });

    it('keeps its range when the reader deletes its last word\'s last letter and a peer edits', async () => {
      // The end names the last letter it covers; losing that letter shortens
      // the range, it does not reach into the words after it.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      const run = firstRun();
      act(() => {
        const view = handle.editor.prosemirrorView!;
        view.dispatch(view.state.tr.delete(run.from + 10, run.from + 11));
      });

      peerEdits((line) => {
        line.insert(0, 'q');
      });

      expect(draftPaint()?.textContent).toBe('brav');
    });

    it('keeps to its words when it ends where the next line starts', async () => {
      // A drag to the start of the next line ends the range there; the words
      // it covers are still only the ones on the first line.
      show('editor', ['alpha bravo charlie', 'delta echo foxtrot']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second!);
      await screen.findByTestId('doc-comment-draft-card');

      peerEdits((line) => {
        line.insert(0, 'Z');
      });

      expect(aimedWords()).toBe('bravo charlie');
    });

    it('keeps to its words when the reader empties the second line of it and a peer edits', async () => {
      // The reader's own deletion leaves the end at the start of the next
      // line; the next peer edit must still see only the first line's words.
      show('editor', ['alpha bravo charlie', 'delta echo foxtrot']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 4);
      await screen.findByTestId('doc-comment-draft-card');
      act(() => {
        const view = handle.editor.prosemirrorView!;
        view.dispatch(view.state.tr.delete(second!, second! + 4));
      });

      peerEdits((line) => {
        line.insert(0, 'Z');
      });

      expect(aimedWords()).toBe('bravo charlie');
    });

    it('says so rather than moving to the same word elsewhere when its words are deleted', async () => {
      show('editor', ['alpha bravo', 'bravo charlie']);
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');

      peerEdits((line) => {
        line.delete(6, 5);
      });

      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('shrinks when a peer deletes letters inside its words and both ends stand', async () => {
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');

      peerEdits((line) => {
        line.delete(8, 1);
      });

      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('brvo');
    });

    it.each([
      // [what the peer does, the edit, the line after it, the words it covers]
      ['deletes its first letters', 6, 2, '', 'alpha avo charlie', 'avo'],
      ['deletes its last letters', 9, 2, '', 'alpha bra charlie', 'bra'],
      ['types over its first letter', 6, 1, 'X', 'alpha Xravo charlie', 'Xravo'],
      ['types over its last two letters', 9, 2, 'n', 'alpha bran charlie', 'bra'],
    ])(
      'keeps what is left of its words when a peer %s',
      async (_what, at, length, typed, after, words) => {
        // An end whose letter is deleted stands where that letter was.
        show();
        aimDraft(6, 11);
        await screen.findByTestId('doc-comment-draft-card');
        await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');

        peerEdits((line) => {
          line.delete(at, length);
          if (typed !== '') line.insert(at, typed);
        });

        expect(lines()).toEqual([after]);
        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe(words);
        expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue('half');
      },
    );

    it.each([
      [
        'moves their line and retypes it at once',
        async (peer: DocumentEditorHandle): Promise<void> => {
          act(() => {
            peer.editor.transact(() => {
              peer.editor.setTextCursorPosition(peer.editor.document[1]!);
              peer.editor.moveBlocksDown();
              peer.editor.updateBlock(peer.editor.document[2]!, {
                content: 'delta ekko foxtrot',
              } as never);
            });
          });
        },
        'ekko',
      ],
    ])(
      'follows its words when a peer %s',
      async (_what, change, words) => {
        show('editor', ['alpha bravo charlie', 'delta echo foxtrot', 'golf']);
        const second = lineStarts()[1]!;
        aimAt(second + 6, second + 10);
        await screen.findByTestId('doc-comment-draft-card');
        const peer = await peerEditor();

        await change(peer);

        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe(words);
      },
    );

    it.each([
      [
        'turns their line into a heading',
        async (peer: DocumentEditorHandle): Promise<void> => {
          act(() => {
            peer.editor.updateBlock(peer.editor.document[1]!, {
              type: 'heading',
              props: { level: 2 },
            } as never);
          });
        },
      ],
      [
        'moves their line to the end',
        async (peer: DocumentEditorHandle): Promise<void> => {
          act(() => {
            peer.editor.setTextCursorPosition(peer.editor.document[1]!);
            peer.editor.moveBlocksDown();
          });
        },
      ],
      [
        'moves the line below up past theirs',
        async (peer: DocumentEditorHandle): Promise<void> => {
          act(() => {
            peer.editor.setTextCursorPosition(peer.editor.document[2]!);
            peer.editor.moveBlocksUp();
          });
        },
      ],
      [
        'moves the last line to the top, across theirs',
        async (peer: DocumentEditorHandle): Promise<void> => {
          act(() => {
            const view = peer.editor.prosemirrorView!;
            const last = peer.editor.document[2]!;
            peer.editor.setTextCursorPosition(last);
            let row: { from: number; to: number; node: never } | null = null;
            view.state.doc.descendants((node, pos) => {
              if (node.attrs['id'] !== last.id) return true;
              row = { from: pos, to: pos + node.nodeSize, node: node as never };
              return false;
            });
            const tr = view.state.tr;
            tr.delete(row!.from, row!.to);
            tr.insert(1, row!.node);
            view.dispatch(tr);
          });
        },
      ],
    ])(
      'stays on its words when a peer %s',
      async (_what, change) => {
        // The peer's editor writes each of these back into Yjs by deleting
        // lines' letters and writing them again, while every line keeps its
        // id and its words.
        show('editor', ['alpha bravo charlie', 'delta echo foxtrot', 'golf']);
        const second = lineStarts()[1]!;
        aimAt(second + 6, second + 10);
        await screen.findByTestId('doc-comment-draft-card');
        await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
        const peer = await peerEditor();

        await change(peer);

        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe('echo');
        expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue('half');
      },
    );

    describe('after a peer rewrites its line, which takes the line\'s old letters out of the document', () => {
      /**
       * Opens a draft on "bravo" and has a peer turn its line into a heading,
       * which deletes the line's old element; Yjs collects its letters at the
       * end of that change.
       * @returns The peer's editor.
       */
      async function afterPeerRewrite(): Promise<DocumentEditorHandle> {
        show('editor', ['one', 'alpha bravo charlie', 'three']);
        const second = lineStarts()[1]!;
        aimAt(second + 6, second + 11);
        await screen.findByTestId('doc-comment-draft-card');
        const peer = await peerEditor();
        act(() => {
          peer.editor.updateBlock(peer.editor.document[1]!, {
            type: 'heading',
            props: { level: 2 },
          } as never);
        });
        return peer;
      }

      it('shows the peer\'s next edit and stays on its words', async () => {
        const peer = await afterPeerRewrite();

        act(() => {
          const view = peer.editor.prosemirrorView!;
          const at = lineStarts(peer.editor.prosemirrorState)[0]!;
          view.dispatch(view.state.tr.insertText('ZZ', at));
        });

        expect(lines()).toEqual(['ZZone', 'alpha bravo charlie', 'three']);
        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe('bravo');
      });

      it('keeps what is left of its words when the peer then deletes its first letter', async () => {
        const peer = await afterPeerRewrite();

        act(() => {
          const view = peer.editor.prosemirrorView!;
          const at = lineStarts(peer.editor.prosemirrorState)[1]! + 6;
          view.dispatch(view.state.tr.delete(at, at + 1));
        });

        expect(lines()).toEqual(['one', 'alpha ravo charlie', 'three']);
        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe('ravo');
      });

      it('takes the reader\'s own undo and stays on its words', async () => {
        show('editor', ['one', 'alpha bravo charlie', 'three']);
        handle.undoManager.stopCapturing();
        act(() => {
          const view = handle.editor.prosemirrorView!;
          view.dispatch(view.state.tr.insertText('Q', lineStarts()[2]!));
        });
        handle.undoManager.stopCapturing();
        const second = lineStarts()[1]!;
        aimAt(second + 6, second + 11);
        await screen.findByTestId('doc-comment-draft-card');
        const peer = await peerEditor();
        act(() => {
          peer.editor.updateBlock(peer.editor.document[1]!, {
            type: 'heading',
            props: { level: 2 },
          } as never);
        });

        act(() => {
          handle.undoManager.undo();
        });

        expect(lines()).toEqual(['one', 'alpha bravo charlie', 'three']);
        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe('bravo');
      });
    });

    it('stays on its words when a peer moves up a line that starts with the same letter', async () => {
      // Rewriting "two…" into "three" keeps their shared first letter, so the
      // letter the start names survives, but in the other line.
      show('editor', ['one', 'two carrying the comment', 'three']);
      aimAt(lineStarts()[1]!, lineStarts()[1]! + 24);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      act(() => {
        peer.editor.setTextCursorPosition(peer.editor.document[2]!);
        peer.editor.moveBlocksUp();
      });

      expect(lines()).toEqual(['one', 'three', 'two carrying the comment']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('two carrying the comment');
    });

    it('stays on its words across two lines when a peer moves another line across both', async () => {
      show('editor', ['alpha bravo', 'charlie delta', 'echo']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      // One transaction: in two, the line would first land between them.
      act(() => {
        peer.editor.transact(() => {
          peer.editor.setTextCursorPosition(peer.editor.document[2]!);
          peer.editor.moveBlocksUp();
          peer.editor.moveBlocksUp();
        });
      });

      expect(lines()).toEqual(['echo', 'alpha bravo', 'charlie delta']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravocharlie');
    });

    it('says so when a peer moves its last line above its first', async () => {
      show('editor', ['alpha bravo', 'charlie delta']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      act(() => {
        peer.editor.setTextCursorPosition(peer.editor.document[1]!);
        peer.editor.moveBlocksUp();
      });

      expect(lines()).toEqual(['charlie delta', 'alpha bravo']);
      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('takes in a line a peer adds between its two lines', async () => {
      show('editor', ['alpha bravo', 'charlie delta']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      act(() => {
        peer.editor.insertBlocks(
          [{ type: 'paragraph', content: 'echo' }] as never,
          peer.editor.document[0]!,
          'after',
        );
      });

      expect(lines()).toEqual(['alpha bravo', 'echo', 'charlie delta']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravoechocharlie');
    });

    it('takes in a line a peer moves between its two lines', async () => {
      // Whatever lies between its ends is its range, the way a comment range
      // is everywhere; here the peer's move puts "echo" there.
      show('editor', ['alpha bravo', 'charlie delta', 'echo']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      act(() => {
        peer.editor.setTextCursorPosition(peer.editor.document[1]!);
        peer.editor.moveBlocksDown();
      });

      expect(lines()).toEqual(['alpha bravo', 'echo', 'charlie delta']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravoechocharlie');
    });

    it('takes in the line a peer swaps into its middle while rewriting its last', async () => {
      // Its last line is rewritten, so its end lines are asked. What lies
      // between them is its range, whichever line that now is.
      show('editor', ['alpha bravo', 'mike', 'charlie delta', 'november']);
      const [first, , third] = lineStarts();
      aimAt(first! + 6, third! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      act(() => {
        const view = peer.editor.prosemirrorView!;
        const [, mike, , november] = peer.editor.document;
        const rows = new Map<string, { from: number; to: number; node: never }>();
        view.state.doc.descendants((node, pos) => {
          const id: unknown = node.attrs['id'];
          if (typeof id === 'string' && (id === mike!.id || id === november!.id)) {
            rows.set(id, { from: pos, to: pos + node.nodeSize, node: node as never });
            return false;
          }
          return true;
        });
        const m = rows.get(mike!.id)!;
        const n = rows.get(november!.id)!;
        const charlie = peer.editor.document[2]!;
        peer.editor.transact((tr) => {
          tr.replaceWith(n.from, n.to, m.node).replaceWith(m.from, m.to, n.node);
          peer.editor.updateBlock(charlie, {
            type: 'heading',
            props: { level: 2 },
          } as never);
        });
      });

      expect(lines()).toEqual(['alpha bravo', 'november', 'charlie delta', 'mike']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravonovembercharlie');
    });

    it.each([
      // [which line the reader moves, which arrow, the words it covers after]
      ['its last line down past another', 2, 'ArrowDown', 'bravoechocharlie'],
      ['its first line up past another', 1, 'ArrowUp', 'bravozerocharlie'],
    ] as const)(
      'keeps each end on its own line when the reader moves %s',
      async (_what, row, key, words) => {
        // A move takes the line out and puts the same line back; each end
        // follows its own line, and whatever lies between them is the range.
        show('editor', ['zero', 'alpha bravo', 'charlie delta', 'echo']);
        const starts = lineStarts();
        aimAt(starts[1]! + 6, starts[2]! + 7);
        await screen.findByTestId('doc-comment-draft-card');

        act(() => {
          const view = handle.editor.prosemirrorView!;
          handle.editor.setTextCursorPosition(handle.editor.document[row]!);
          view.someProp('handleKeyDown', (handler) =>
            handler(
              view,
              new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true }),
            ),
          );
        });

        expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
        expect(aimedWords()).toBe(words);
      },
    );

    it('says so when the reader moves its last line above its first', async () => {
      show('editor', ['alpha bravo', 'charlie delta']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');

      act(() => {
        const view = handle.editor.prosemirrorView!;
        handle.editor.setTextCursorPosition(handle.editor.document[1]!);
        view.someProp('handleKeyDown', (handler) =>
          handler(
            view,
            new KeyboardEvent('keydown', {
              key: 'ArrowUp',
              ctrlKey: true,
              shiftKey: true,
            }),
          ),
        );
      });

      expect(lines()).toEqual(['charlie delta', 'alpha bravo']);
      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('keeps each end on its own line when the reader drags its last line down', async () => {
      show('editor', ['alpha bravo', 'charlie delta', 'echo']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const [, charlie, echo] = handle.editor.document;

      act(() => {
        const view = handle.editor.prosemirrorView!;
        moveRowTo(view, charlie!.id, rowById(view.state.doc, echo!.id)!.to);
      });

      expect(lines()).toEqual(['alpha bravo', 'echo', 'charlie delta']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravoechocharlie');
    });

    it('keeps each end on its own when a peer moves its last line and edits its first elsewhere', async () => {
      // Each end is judged on what happened to it: the first line changed
      // outside the range, its start letter is still there.
      show('editor', ['alpha bravo', 'charlie delta', 'echo']);
      const [first, second] = lineStarts();
      aimAt(first! + 6, second! + 7);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      const at = lineStarts(peer.editor.prosemirrorState)[0]!;
      const charlie = peer.editor.document[1]!;
      act(() => {
        peer.editor.transact((tr) => {
          tr.insertText('!', at);
          peer.editor.setTextCursorPosition(charlie);
          peer.editor.moveBlocksDown();
        });
      });

      expect(lines()).toEqual(['!alpha bravo', 'echo', 'charlie delta']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravoechocharlie');
    });

    it('stays on its words when the reader moves the line they are on', async () => {
      show('editor', ['alpha bravo', 'charlie delta']);
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');

      act(() => {
        const view = handle.editor.prosemirrorView!;
        handle.editor.setTextCursorPosition(handle.editor.document[0]!);
        view.someProp('handleKeyDown', (handler) =>
          handler(
            view,
            new KeyboardEvent('keydown', {
              key: 'ArrowDown',
              ctrlKey: true,
              shiftKey: true,
            }),
          ),
        );
      });

      expect(lines()).toEqual(['charlie delta', 'alpha bravo']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravo');
    });

    it('stays on its words when the reader undoes moving another line across them', async () => {
      show('editor', ['w', 'bravo charlie', 'z']);
      aimAt(lineStarts()[1]!, lineStarts()[1]! + 5);
      await screen.findByTestId('doc-comment-draft-card');
      handle.undoManager.stopCapturing();
      act(() => {
        handle.editor.setTextCursorPosition(handle.editor.document[2]!);
        handle.editor.moveBlocksUp();
      });
      handle.undoManager.stopCapturing();

      act(() => {
        handle.undoManager.undo();
      });

      expect(lines()).toEqual(['w', 'bravo charlie', 'z']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravo');
    });

    it('stays on its words when a peer presses Enter at the start of their line', async () => {
      show('editor', ['one', 'two carrying three']);
      const second = lineStarts()[1]!;
      aimAt(second + 4, second + 12);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      await peerPresses(peer, lineStarts(peer.editor.prosemirrorState)[1]!, 'Enter');

      expect(lines()).toEqual(['one', '', 'two carrying three']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('carrying');
    });

    it('stays on its words when the reader presses Enter at the start of their line and undoes it', async () => {
      show('editor', ['one', 'two carrying three']);
      const second = lineStarts()[1]!;
      aimAt(second + 4, second + 12);
      await screen.findByTestId('doc-comment-draft-card');
      handle.undoManager.stopCapturing();
      await peerPresses(handle, second, 'Enter');
      handle.undoManager.stopCapturing();

      act(() => {
        handle.undoManager.undo();
      });

      expect(lines()).toEqual(['one', 'two carrying three']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('carrying');
    });

    it('stays on its words when the reader undoes typing in their line and moving it, made together', async () => {
      show('editor', ['alpha bravo', 'charlie delta']);
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      handle.undoManager.stopCapturing();
      act(() => {
        const view = handle.editor.prosemirrorView!;
        view.dispatch(view.state.tr.insertText('X', lineStarts()[0]!));
        handle.editor.setTextCursorPosition(handle.editor.document[0]!);
        view.someProp('handleKeyDown', (handler) =>
          handler(
            view,
            new KeyboardEvent('keydown', {
              key: 'ArrowDown',
              ctrlKey: true,
              shiftKey: true,
            }),
          ),
        );
      });
      handle.undoManager.stopCapturing();

      act(() => {
        handle.undoManager.undo();
      });

      expect(lines()).toEqual(['alpha bravo', 'charlie delta']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('bravo');
    });

    it('keeps the words it is on when a peer splits their line inside them', async () => {
      // The peer's editor writes the second half as new letters in a new row,
      // so the end stands where its last letter was.
      show('editor', ['alpha bravo charlie', 'delta echo foxtrot', 'golf']);
      const second = lineStarts()[1]!;
      aimAt(second + 6, second + 10);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      await peerPresses(peer, lineStarts(peer.editor.prosemirrorState)[1]! + 8, 'Enter');

      expect(lines()).toEqual(['alpha bravo charlie', 'delta ec', 'ho foxtrot', 'golf']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('ec');
    });

    it('says so when a peer joins its line onto the one above', async () => {
      // The row it was in is gone and its letters were written anew into the
      // row above: neither Yjs nor the row can say where its words are.
      show('editor', ['alpha bravo charlie', 'delta echo foxtrot', 'golf']);
      const second = lineStarts()[1]!;
      aimAt(second + 6, second + 10);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      await peerPresses(peer, lineStarts(peer.editor.prosemirrorState)[1]!, 'Backspace');

      expect(lines()).toEqual(['alpha bravo charliedelta echo foxtrot', 'golf']);
      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('says so when a peer presses Enter before its words in their line', async () => {
      // The peer's editor writes the second half, words and all, as new
      // letters in a new row; the reader's own selection comes back empty
      // from the same change (y-prosemirror #204).
      show('editor', ['one', 'alpha bravo charlie', 'three']);
      const second = lineStarts()[1]!;
      aimAt(second + 6, second + 11);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      await peerPresses(peer, lineStarts(peer.editor.prosemirrorState)[1]! + 3, 'Enter');

      expect(lines()).toEqual(['one', 'alp', 'ha bravo charlie', 'three']);
      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('stays on what is left when a peer deletes its last letter and undoes it', async () => {
      // A peer's undo reaches the reader as new letters; Yjs follows undone
      // deletions only in the document that did the undo (yjs#638).
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();
      act(() => {
        const view = peer.editor.prosemirrorView!;
        const at = lineStarts(peer.editor.prosemirrorState)[0]! + 10;
        view.dispatch(view.state.tr.delete(at, at + 1));
      });
      peer.undoManager.stopCapturing();

      act(() => {
        peer.undoManager.undo();
      });

      expect(lines()).toEqual(['alpha bravo charlie']);
      expect(aimedWords()).toBe('brav');
    });

    it('keeps a range when a peer deletes the same word before its words', async () => {
      // The peer's editor keeps the first "the " and deletes the second, the
      // one the start names; the start stands where that letter was.
      show('editor', ['the the cat']);
      aimDraft(4, 11);
      await screen.findByTestId('doc-comment-draft-card');
      const peer = await peerEditor();

      act(() => {
        const view = peer.editor.prosemirrorView!;
        const at = lineStarts(peer.editor.prosemirrorState)[0]!;
        view.dispatch(view.state.tr.delete(at, at + 4));
      });

      expect(lines()).toEqual(['the cat']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('cat');
    });

    it('shrinks when the reader undoes words they typed that it starts on', async () => {
      // Undoing is deleting those words, the way pressing Backspace over them
      // would be: the rest of its words stay.
      show('editor', ['alpha bravo']);
      handle.undoManager.stopCapturing();
      act(() => {
        const view = handle.editor.prosemirrorView!;
        view.dispatch(view.state.tr.insertText('new ', lineStarts()[0]!));
      });
      handle.undoManager.stopCapturing();
      aimDraft(0, 9);
      await screen.findByTestId('doc-comment-draft-card');

      act(() => {
        handle.undoManager.undo();
      });

      expect(lines()).toEqual(['alpha bravo']);
      expect(screen.queryByTestId('doc-comment-draft-dropped')).toBeNull();
      expect(aimedWords()).toBe('alpha');
    });

    it('says so when a peer deletes the words it is on', async () => {
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');

      peerEdits((line) => {
        line.delete(6, 5);
      });

      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('keeps a half-written comment across a Space tab switch', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );

      remount();

      expect(
        await screen.findByTestId('doc-comment-draft-input'),
      ).toHaveValue('half a thought');
    });

    it('posts what was written after a Space tab switch', async () => {
      // The draft is one thing kept by the editor, so the card mounted again
      // over it is the same draft: Save sends what the reader wrote.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );

      remount();
      await userEvent.click(await screen.findByTestId('doc-comment-draft-save'));

      await waitFor(() => {
        expect(screen.queryByTestId('doc-comment-draft-card')).toBeNull();
      });
      const threads = await handle.editor
        .getExtension(CommentsExtension)!
        .threadStore.getThreads();
      expect(threads.size).toBe(1);
      expect(draftPaint()).toBeNull();
    });

    it('says so after a tab switch when the words went while it was away', async () => {
      // A21 while the card is not mounted: the editor keeps syncing, so the
      // draft learns its words are gone whether or not anyone is drawing it.
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
      unmountBody();

      peerEdits((line) => {
        line.delete(6, 5);
      });
      mountBody();

      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('keeps a notice on screen across a tab switch', async () => {
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      peerEdits((line) => {
        line.delete(6, 5);
      });
      await screen.findByTestId('doc-comment-draft-dropped');

      remount();

      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
    });

    it('leaves another card being read after a tab switch', async () => {
      // The card being read changes when the reader presses one, not when the
      // panel is mounted again.
      show();
      await comment(0, 5, 'about alpha');
      aimDraft(12, 19);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'words');
      await userEvent.click(screen.getByTestId('doc-comment-card'));
      const reading = selectedThreadsIn(handle.editor.prosemirrorState);

      remount();
      await screen.findByTestId('doc-comment-draft-card');

      expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual(reading);
    });

    it('starts empty once the panel was closed on it and a new one opens', async () => {
      // Closing the panel throws the draft away (design §9.4): a new one
      // over the same words starts from nothing.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'thrown away',
      );
      await userEvent.click(screen.getByTestId('doc-comment-rail-close'));

      aimDraft(0, 5);

      expect(
        await screen.findByTestId('doc-comment-draft-input'),
      ).toHaveValue('');
    });

    it('keeps a draft that has words in it on a press in the body', async () => {
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

    it('carries what was written to other words the entry is pressed over', async () => {
      // A draft with words in it ends on cancel or save only (user
      // 2026-09-24); pressing the entry again moves it (design §9.4.1).
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );
      await clickTheBody();

      aimDraft(12, 19);

      expect(aimedWords()).toBe('charlie');
      expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue(
        'half a thought',
      );
    });

    it('puts the keyboard in the box again when the entry is pressed over other words', async () => {
      // Pressing the entry is asking to write, however the card got there:
      // the first time it mounts, the next time it only moves.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
      await clickTheBody();

      aimDraft(12, 19);

      await waitFor(() => {
        expect(screen.getByTestId('doc-comment-draft-input')).toHaveFocus();
      });
    });

    it('puts the caret after what was written when the entry is pressed over other words', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
      await clickTheBody();

      aimDraft(12, 19);

      await waitFor(() => {
        expect(screen.getByTestId('doc-comment-draft-input')).toHaveFocus();
      });
      const box = screen.getByTestId<HTMLTextAreaElement>('doc-comment-draft-input');
      expect([box.selectionStart, box.selectionEnd]).toEqual([4, 4]);
    });

    it('puts the caret after what was written when a tab switch brings the card back', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');

      remount();

      const box = await screen.findByTestId<HTMLTextAreaElement>('doc-comment-draft-input');
      await waitFor(() => {
        expect(box).toHaveFocus();
      });
      expect([box.selectionStart, box.selectionEnd]).toEqual([4, 4]);
    });

    it('leaves the caret where the reader puts it while they write', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      const box = screen.getByTestId<HTMLTextAreaElement>('doc-comment-draft-input');
      await userEvent.type(box, 'half');

      box.setSelectionRange(1, 1);
      await userEvent.type(box, 'xy', {
        initialSelectionStart: 1,
        initialSelectionEnd: 1,
      });

      expect(box).toHaveValue('hxyalf');
    });

    it('leaves the keyboard in the box while a peer edit moves its words', async () => {
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      const box = screen.getByTestId('doc-comment-draft-input');
      await userEvent.type(box, 'half');

      peerEdits((line) => {
        line.insert(0, 'q');
      });

      expect(screen.getByTestId('doc-comment-draft-input')).toBe(box);
      expect(box).toHaveFocus();
    });

    it('carries what was written out of a notice when the entry is pressed', async () => {
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
      peerEdits((line) => {
        line.delete(6, 5);
      });
      await screen.findByTestId('doc-comment-draft-dropped');

      aimDraft(0, 5);

      expect(aimedWords()).toBe('alpha');
      expect(
        await screen.findByTestId('doc-comment-draft-input'),
      ).toHaveValue('half');
    });

    it('opens the panel on a notice after a tab switch while another thing was pressed', async () => {
      // The draft not being the card read does not make it any less open:
      // the panel is open whenever a draft is (design §9.6).
      show();
      aimDraft(6, 11);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(screen.getByTestId('doc-comment-draft-input'), 'half');
      await clickTheBody();
      unmountBody();

      peerEdits((line) => {
        line.delete(6, 5);
      });
      mountBody();

      expect(
        await screen.findByTestId('doc-comment-draft-dropped'),
      ).toBeInTheDocument();
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

    it('paints the words it is aimed at in the colours of a comment being read', async () => {
      // user 2026-09-24: the words belong to a comment from the moment the
      // entry is pressed, so they wear the comment colours, not the colour
      // of a selection.
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');

      const paint = draftPaint();
      expect(paint?.textContent).toBe('alpha');
      expect(paint?.classList.contains('doc-comment-mark-reading')).toBe(true);
      expect(
        handle.editor.prosemirrorView!.dom.querySelector('[data-show-selection]'),
      ).toBeNull();
      expect(
        screen.getByTestId('doc-comment-draft-card').dataset.selected,
      ).toBe('true');
    });

    it('gives the column to another card that is pressed, keeping its words and its colour', async () => {
      // One card in the panel is active at a time, a draft among them.
      show();
      await comment(6, 11, 'about bravo');
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );

      await userEvent.click(screen.getByTestId('doc-comment-card'));

      await waitFor(() => {
        expect(screen.getByTestId('doc-comment-card').dataset.selected).toBe(
          'true',
        );
      });
      expect(
        screen.getByTestId('doc-comment-draft-card').dataset.selected,
      ).toBe('false');
      expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue(
        'half a thought',
      );
      const paint = draftPaint();
      expect(paint?.textContent).toBe('alpha');
      expect(paint?.classList.contains('doc-comment-mark-reading')).toBe(false);
    });

    it('deepens its words while the pointer rests on its card, as a thread card does (A24)', async () => {
      show();
      await comment(6, 11, 'about bravo');
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );
      await userEvent.click(screen.getByTestId('doc-comment-card'));
      await waitFor(() => {
        expect(
          draftPaint()?.classList.contains('doc-comment-mark-reading'),
        ).toBe(false);
      });

      await userEvent.hover(screen.getByTestId('doc-comment-draft-card'));

      expect(
        draftPaint()?.classList.contains('doc-comment-mark-reading'),
      ).toBe(true);

      await userEvent.unhover(screen.getByTestId('doc-comment-draft-card'));

      expect(
        draftPaint()?.classList.contains('doc-comment-mark-reading'),
      ).toBe(false);
    });

    it('takes the column back when the draft card is pressed again', async () => {
      show();
      await comment(6, 11, 'about bravo');
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'half a thought',
      );
      await userEvent.click(screen.getByTestId('doc-comment-card'));

      await userEvent.click(screen.getByTestId('doc-comment-draft-card'));

      await waitFor(() => {
        expect(
          screen.getByTestId('doc-comment-draft-card').dataset.selected,
        ).toBe('true');
      });
      expect(screen.getByTestId('doc-comment-card').dataset.selected).toBe(
        'false',
      );
      expect(
        draftPaint()?.classList.contains('doc-comment-mark-reading'),
      ).toBe(true);
    });

    it('takes the colours off the words when it is cancelled', async () => {
      show();
      aimDraft(0, 5);
      await screen.findByTestId('doc-comment-draft-card');
      await userEvent.type(
        screen.getByTestId('doc-comment-draft-input'),
        'never mind',
      );

      await userEvent.click(screen.getByTestId('doc-comment-draft-cancel'));

      await waitFor(() => {
        expect(draftPaint()).toBeNull();
      });
      expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([]);
    });

    it('leaves no card being read once it is saved', async () => {
      // user 2026-09-24: saving is the comment being finished, so nothing in
      // the panel carries on as the one being read.
      show();
      await comment(6, 11, 'about bravo');
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
      expect(screen.getAllByTestId('doc-comment-card')).toHaveLength(2);
      for (const card of screen.getAllByTestId('doc-comment-card')) {
        expect(card.dataset.selected).toBe('false');
      }
      expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([]);
      expect(draftPaint()).toBeNull();
    });

    it('touches nothing of a viewer\'s when the panel opens with no draft', async () => {
      // A viewer has no draft to lose, so opening the panel is no reason to
      // write a selection or a draft range into their editor.
      show('viewer');
      // A comment on the page, so the panel draws its column of cards — the
      // draft card lives in that column.
      await comment(0, 5, 'already here');
      const view = handle.editor.prosemirrorView!;
      const dispatch = view.dispatch.bind(view);
      const drafts: unknown[] = [];
      view.dispatch = (tr) => {
        if (tr.getMeta(DOCUMENT_COMMENT_DRAFT_RANGE) !== undefined) {
          drafts.push(tr.getMeta(DOCUMENT_COMMENT_DRAFT_RANGE));
        }
        dispatch(tr);
      };

      await pressCommentsRow();
      await screen.findByTestId('doc-comment-rail');

      expect(drafts).toEqual([]);
      view.dispatch = dispatch;
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
      // A save on blank words leaves the draft alone, so the card stays and
      // nothing is made. The pair of buttons
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
