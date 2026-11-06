// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-91: BlockNote comment writes go through
 * the size gate by kind (answer A7). New threads, new and edited comments and
 * new reactions are `add`; resolving and unresolving are `overwrite`;
 * deleting a comment or a reaction is `delete`. Reactions are not covered:
 * `documentCommentAuth.canAddReaction` refuses every reaction, so no reaction
 * can be added or seeded through the store.
 *
 * Driven through the thread store the comments extension holds on the editor
 * the cache builds for a registered document Space. A refused call is checked
 * only for writing nothing and warning once; how the BlockNote UI keeps the
 * draft is checked in the real app (A7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import type { EditorView } from '@tiptap/pm/view';
import { documentCommentThreads } from '@breatic/shared';
import { Awareness } from 'y-protocols/awareness';
import type * as ProviderModule from '@hocuspocus/provider';
import type { YjsThreadStore } from '@blocknote/core/yjs';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { COMMENT_MARK, commentsOn, threadIsPaintedIn } from '@web/spaces/document/document-comment-extension';
import { estimateNodeBytes } from '@web/data/yjs/space-write';
import { markBytes } from '@web/features/collab-editor/space-size-gate';
import { commentOn } from '@web/spaces/document/document-comment-post';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_FULL,
  F_FULL_NEAR,
  F_OVER,
  F_WARNING,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const NAME = docName.documentSpace('p1', 'd1');

// The library's own store type: the wrapper around it keeps its methods.
type Store = YjsThreadStore;

/** The board every case starts from. */
interface Board {
  doc: Y.Doc;
  store: Store;
  editor: Parameters<typeof commentOn>[0];
  th1: string;
  c1: string;
  th2: string;
}

/**
 * A one-paragraph comment body.
 * @param text - Its words.
 * @returns The body.
 */
function body(text: string): unknown {
  return [{ type: 'paragraph', content: text }];
}

/**
 * Opens the registered document with thread th1 (comment c1) and
 * the resolved thread th2, written while the size state is unknown, then
 * delivers one size push.
 * @param push - The size push.
 * @returns The board.
 */
async function open(push: DocSizePush): Promise<Board> {
  const { doc, provider } = openSizedDoc(NAME);
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  const store = commentsOn(handle.editor)!.threadStore as unknown as Store;
  handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'hello world' }] as never);
  const first = await store.createThread({ initialComment: { body: body('first') as never } });
  const c1 = first.comments[0]!.id;
  const second = await store.createThread({ initialComment: { body: body('second') as never } });
  await store.resolveThread({ threadId: second.id });
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  return { doc, store, editor: handle.editor as never, th1: first.id, c1, th2: second.id };
}

/**
 * Runs a store call, whatever a refused one answers with.
 * @param call - The call.
 * @returns When it has settled.
 */
async function attempt(call: () => unknown): Promise<void> {
  await Promise.resolve().then(call).catch(() => undefined);
}

beforeEach(() => {
  sizeGateProviders.length = 0;
});

afterEach(() => {
  cleanup();
  _resetDocumentEditorCacheForTests();
  _resetCollabSocketForTests();
  _resetForTests();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('W-91 add-kind comment writes are refused when the Space is full', () => {
  const cases: ReadonlyArray<readonly [string, (b: Board) => unknown]> = [
    ['createThread', (b) => b.store.createThread({ initialComment: { body: body('new') as never } })],
    ['addComment', (b) => b.store.addComment({ threadId: b.th1, comment: { body: body('reply') as never } })],
    ['updateComment', (b) => b.store.updateComment({ threadId: b.th1, commentId: b.c1, comment: { body: body('edited') as never } })],
  ];

  it.each(cases)('%s writes nothing and warns once', async (_name, call) => {
    const board = await open(F_FULL);
    const before = Y.encodeStateAsUpdate(board.doc);

    await attempt(() => call(board));

    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-91 delete-kind comment writes go through over the hard ceiling', () => {
  it('deletes the comment without a toast', async () => {
    const board = await open(F_OVER);

    await board.store.deleteComment({ threadId: board.th1, commentId: board.c1 });

    const live = [...board.store.getThreads().values()]
      .filter((thread) => thread.deletedAt === undefined)
      .flatMap((thread) => thread.comments.filter((c) => c.deletedAt === undefined).map((c) => c.id));
    expect(live).not.toContain(board.c1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-91 resolving is overwrite-kind', () => {
  it('resolves and unresolves at full with overwrite room left', async () => {
    const board = await open(F_FULL);

    await board.store.resolveThread({ threadId: board.th1 });
    await board.store.unresolveThread({ threadId: board.th2 });

    expect(board.store.getThread(board.th1).resolved).toBe(true);
    expect(board.store.getThread(board.th2).resolved).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each([
    ['resolveThread', (b: Board): unknown => b.store.resolveThread({ threadId: b.th1 })],
    ['unresolveThread', (b: Board): unknown => b.store.unresolveThread({ threadId: b.th2 })],
  ] as const)('%s is refused once the overwrite room is 0', async (_name, call) => {
    const board = await open(F_FULL_NEAR);
    const before = Y.encodeStateAsUpdate(board.doc);

    await attempt(() => call(board));

    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(board.store.getThread(board.th1).resolved).toBe(false);
    expect(board.store.getThread(board.th2).resolved).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_OVERWRITE_BLOCKED);
  });
});

describe('posting a comment holds room for the thread and its mark together', () => {
  /**
   * Aims at all of `hello world`.
   * @param state - The body.
   * @returns The one range.
   */
  const aim: Parameters<typeof commentOn>[2] = (state) => {
    let at = -1;
    state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText) at = pos;
      return at < 0;
    });
    return at < 0 ? null : [{ from: at, to: at + 'hello world'.length }];
  };

  it('writes neither when the room left holds less than both', async () => {
    const board = await open(F_WARNING_TIGHT);
    const before = Y.encodeStateAsUpdate(board.doc);

    const result = await commentOn(board.editor, body('new'), aim);

    expect(result).toEqual({ ok: false, reason: 'no_room', room: 1 });
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_NO_ROOM('1 B'));
  });

  it('writes the thread and marks its words when both fit', async () => {
    const board = await open(F_WARNING);

    const thread = await commentOn(board.editor, body('new'), aim);

    expect(thread).not.toBeNull();
    const id = (thread as { id: string }).id;
    expect(board.store.getThread(id)).toBeDefined();
    expect(threadIsPaintedIn((board.editor as unknown as { prosemirrorView: { state: { doc: never } } }).prosemirrorView.state.doc, id)).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('writes neither when the thread fits but its mark does not', async () => {
    const board = await open(F_WARNING);
    const view = (board.editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;
    const ranges = aim(view.state)!;
    const sized = view.state.schema.marks[COMMENT_MARK]!.create({ threadId: '00000000-0000-0000-0000-000000000000', orphan: false });
    const room = estimateNodeBytes({ initialComment: { body: body('new') } }) + markBytes(view.state.doc, ranges, sized) - 1;
    pushSize(sizeGateProviders.at(-1)!, { ...F_WARNING, room });
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(board.doc);

    const result = await commentOn(board.editor, body('new'), aim);

    expect(result).toMatchObject({ ok: false, reason: 'no_room' });
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('refuses a reply that does not fit the room left', async () => {
    const board = await open(F_WARNING_TIGHT);
    const before = Y.encodeStateAsUpdate(board.doc);

    await attempt(() => board.store.addComment({ threadId: board.th1, comment: { body: body('a reply') as never } }));

    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_NO_ROOM('1 B'));
  });
});

describe('a peer changing a thread while the Space is full', () => {
  it('syncs the comment mark here without telling this reader the Space is full', async () => {
    const board = await open(F_WARNING);
    const view = (board.editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText) at = pos;
      return at < 0;
    });
    const thread = await commentOn(board.editor, body('note'), () => [{ from: at, to: at + 5 }]);
    const id = (thread as { id: string }).id;
    pushSize(sizeGateProviders.at(-1)!, F_FULL);
    vi.mocked(toast.warning).mockClear();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(board.doc));
    const entry = documentCommentThreads(peer).get(id) as Y.Map<unknown>;
    peer.transact(() => {
      entry.set('resolved', true);
      entry.set('resolvedUpdatedAt', Date.now());
    });
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(board.doc)), 'remote');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(toast.warning).not.toHaveBeenCalled();
  });
});
