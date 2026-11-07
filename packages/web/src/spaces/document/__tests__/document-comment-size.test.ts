// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 6: BlockNote comment writes. The thread store the comments extension holds
 * is the real `YjsThreadStore` behind the wrapper in
 * `document-comment-thread-store.ts`. New threads, comments, reactions and
 * comment edits are `add`; resolving is `edit`; deleting a reaction or a
 * thread is `remove`. Deleting a comment is the library's own write below
 * the limit (`edit`, with `updatedAt`), and on a full Space the wrapper
 * removes the comment's map (the whole thread when it was the last one)
 * without touching `updatedAt` (`remove`). A refused write rejects with
 * `SpaceFullError` in every refusing state (spec answer Q2).
 *
 * Reactions: this product's auth refuses every reaction, so the auth module
 * is wrapped here to allow them; nothing else about the auth changes.
 *
 * The highlight cases (CM-08, CM-09) read the local decoration that paints a
 * thread's words only while the thread exists (design 5.2, answer Q3): an
 * inline decoration with the class `doc-comment-mark-live` and the thread id
 * in `data-thread-id`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CommentAuthModule from '@web/spaces/document/document-comment-auth';
import { cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import type { EditorView } from '@tiptap/pm/view';
import { Awareness } from 'y-protocols/awareness';
import type { YjsThreadStore } from '@blocknote/core/yjs';
import { documentCommentThreads } from '@breatic/shared';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));
vi.mock('@web/spaces/document/document-comment-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CommentAuthModule>();
  return {
    ...actual,
    documentCommentAuth: (readWho: Parameters<typeof actual.documentCommentAuth>[0]) => {
      const auth = actual.documentCommentAuth(readWho);
      auth.canAddReaction = (): boolean => true;
      auth.canDeleteReaction = (): boolean => true;
      return auth;
    },
  };
});

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import type { SpaceWriteKind } from '@web/data/yjs/space-write';
import { COMMENT_MARK, asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { SpaceFullError } from '@web/spaces/document/document-comment-thread-store';
import {
  _resetDocumentEditorCacheForTests, adoptDocumentEditor, getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import {
  captureWriteAsync, enterSize, expectKindShape, expectSizeToast, outcomeOf, type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const NAME = docName.documentSpace('p1', 'd1');
const SOURCE_NAME = docName.documentSpace('p1', 'src');

/** The board every store case starts from. */
interface Board {
  doc: Y.Doc;
  store: YjsThreadStore;
  view: EditorView;
  root: HTMLElement;
  t1: string;
  c1: string;
  c2: string;
  t2: string;
  c3: string;
}

/**
 * Mounts the document editor of one registered document Space.
 * @param name - Its name.
 * @returns The document, store, view, the element the editor lives in and the editor handle.
 */
function mount(name: string): Pick<Board, 'doc' | 'store' | 'view' | 'root'> & { handle: ReturnType<typeof getDocumentEditor> } {
  const doc = getDoc(name);
  const handle = getDocumentEditor(doc, name, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  const store = commentsOn(handle.editor)!.threadStore as unknown as YjsThreadStore;
  const view = (handle.editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;
  return { doc, store, view, root, handle };
}

/**
 * Thread t1 with comments c1 (reacted 👍) and c2, and the resolved thread t2
 * with its one comment c3, written while the size is unknown; t1's
 * `updatedAt` is set to 1 so a change to it shows.
 * @returns The board.
 */
async function open(): Promise<Board> {
  const mounted = mount(NAME);
  const { store, doc } = mounted;
  const first = await store.createThread({ initialComment: { body: asCommentBody('first') as never } });
  const second = await store.addComment({ threadId: first.id, comment: { body: asCommentBody('second') as never } });
  await store.addReaction({ threadId: first.id, commentId: first.comments[0].id, emoji: '👍' });
  const other = await store.createThread({ initialComment: { body: asCommentBody('third') as never } });
  await store.resolveThread({ threadId: other.id });
  doc.transact(() => { (documentCommentThreads(doc).get(first.id) as Y.Map<unknown>).set('updatedAt', 1); });
  return { ...mounted, t1: first.id, c1: first.comments[0].id, c2: second.id, t2: other.id, c3: other.comments[0].id };
}

/**
 * A thread's entry in the document.
 * @param board - The board.
 * @param id - The thread id.
 * @returns Its map, or undefined.
 */
function threadMap(board: Board, id: string): Y.Map<unknown> | undefined {
  return documentCommentThreads(board.doc).get(id) as Y.Map<unknown> | undefined;
}

/**
 * The comment ids a thread holds.
 * @param board - The board.
 * @param id - The thread id.
 * @returns The ids, in order.
 */
function commentIds(board: Board, id: string): string[] {
  const comments = threadMap(board, id)?.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
  return comments?.toArray().map((comment) => comment.get('id') as string) ?? [];
}

/** How a store call settled. */
type Settled = { value: unknown } | { error: unknown };

/**
 * Runs a store call and records how it settled.
 * @param call - The call.
 * @returns A runner for `captureWriteAsync`.
 */
function settle(call: () => Promise<unknown>): () => Promise<Settled> {
  return () => call().then((value) => ({ value }), (error: unknown) => ({ error }));
}

/** One store write and its declared kind. */
interface StoreRow {
  id: string;
  title: string;
  kind: SpaceWriteKind;
  call: (board: Board) => Promise<unknown>;
}

const ROWS: readonly StoreRow[] = [
  { id: 'CM-01', title: 'createThread', kind: 'add', call: (b) => b.store.createThread({ initialComment: { body: asCommentBody('new') as never } }) },
  { id: 'CM-01', title: 'addComment to t1', kind: 'add', call: (b) => b.store.addComment({ threadId: b.t1, comment: { body: asCommentBody('reply') as never } }) },
  { id: 'CM-01', title: 'addReaction to c2', kind: 'add', call: (b) => b.store.addReaction({ threadId: b.t1, commentId: b.c2, emoji: '🎉' }) },
  { id: 'CM-01', title: 'updateComment c1', kind: 'add', call: (b) => b.store.updateComment({ threadId: b.t1, commentId: b.c1, comment: { body: asCommentBody('edited') as never } }) },
  { id: 'CM-02', title: 'resolveThread t1', kind: 'edit', call: (b) => b.store.resolveThread({ threadId: b.t1 }) },
  { id: 'CM-02', title: 'unresolveThread t2', kind: 'edit', call: (b) => b.store.unresolveThread({ threadId: b.t2 }) },
  { id: 'CM-03', title: 'deleteReaction 👍 of c1', kind: 'remove', call: (b) => b.store.deleteReaction({ threadId: b.t1, commentId: b.c1, emoji: '👍' }) },
  { id: 'CM-03', title: 'deleteThread t1', kind: 'remove', call: (b) => b.store.deleteThread({ threadId: b.t1 }) },
];

const CODES: readonly SizeCode[] = ['U', 'F', 'O', 'Z'];

afterEach(() => {
  cleanup();
  _resetDocumentEditorCacheForTests();
  clearAllDocSizes();
  _resetForTests();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('CM-01 to CM-03 thread store writes by kind', () => {
  for (const row of ROWS) for (const code of CODES) it(`${row.id} ${row.title} is ${row.kind} at ${code}`, async () => {
    const board = await open();
    enterSize(NAME, code);
    toast.warning.mockClear();
    toast.error.mockClear();
    const before = Y.encodeStateAsUpdate(board.doc);
    const captured = await captureWriteAsync(board.doc, settle(() => row.call(board)));
    const outcome = outcomeOf(row.kind, code);
    if (outcome.written) {
      expect(captured.result).not.toHaveProperty('error');
      expectKindShape(row.kind, captured);
      expectSizeToast(null);
      return;
    }
    expect(captured.result).toEqual({ error: expect.any(SpaceFullError) });
    expect(captured.shape).toBe('∅');
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expectSizeToast(outcome.toast);
  });
});

describe('CM-04 deleting a comment below the limit is the library write', () => {
  it.each(['U', 'N', 'W'] as const)('CM-04 at %s deleteComment c2 writes the update with updatedAt', async (code) => {
    const board = await open();
    enterSize(NAME, code);
    const captured = await captureWriteAsync(board.doc, settle(() => board.store.deleteComment({ threadId: board.t1, commentId: board.c2 })));
    expect(captured.result).not.toHaveProperty('error');
    expect(commentIds(board, board.t1)).toEqual([board.c1]);
    expect(threadMap(board, board.t1)!.get('updatedAt')).not.toBe(1);
    expect(captured.shape).toBe('S');
  });
});

describe('CM-05 deleting a comment on a full Space removes its map only', () => {
  it.each(['F', 'O'] as const)('CM-05 at %s deleteComment c2 removes c2 and keeps updatedAt', async (code) => {
    const board = await open();
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = await captureWriteAsync(board.doc, settle(() => board.store.deleteComment({ threadId: board.t1, commentId: board.c2 })));
    expect(captured.result).not.toHaveProperty('error');
    expect(commentIds(board, board.t1)).toEqual([board.c1]);
    expect(threadMap(board, board.t1)!.get('updatedAt')).toBe(1);
    expect(captured.shape).toBe('R');
    expectSizeToast(null);
  });
});

describe('CM-06 deleting the last comment on a full Space removes the thread', () => {
  it.each(['F', 'O'] as const)('CM-06 at %s deleteComment c3 removes t2', async (code) => {
    const board = await open();
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = await captureWriteAsync(board.doc, settle(() => board.store.deleteComment({ threadId: board.t2, commentId: board.c3 })));
    expect(captured.result).not.toHaveProperty('error');
    expect(threadMap(board, board.t2)).toBeUndefined();
    expect(captured.shape).toBe('R');
    expectSizeToast(null);
  });
});

describe('CM-07 deleting a comment while resyncing is refused', () => {
  it('CM-07 at Z deleteComment c2 rejects with SpaceFullError, writes nothing and shows no toast', async () => {
    const board = await open();
    enterSize(NAME, 'Z');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(board.doc);
    const captured = await captureWriteAsync(board.doc, settle(() => board.store.deleteComment({ threadId: board.t1, commentId: board.c2 })));
    expect(captured.result).toEqual({ error: expect.any(SpaceFullError) });
    expect(captured.shape).toBe('∅');
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expectSizeToast(null);
  });
});

/** The editor board of the highlight cases. */
interface MarkedBoard {
  doc: Y.Doc;
  store: YjsThreadStore;
  view: EditorView;
  root: HTMLElement;
  t1: string;
  t2: string;
}

/**
 * Builds `hello world` with t1 marking `hello` and t2 marking `world` in a
 * peer's document, then delivers it to the mounted editor of the Space under
 * test as a remote update (spec 0.1).
 * @returns The board.
 */
async function openMarked(): Promise<MarkedBoard> {
  const target = mount(NAME);
  const source = mount(SOURCE_NAME);
  source.handle.editor.replaceBlocks(source.handle.editor.document, [{ type: 'paragraph', content: 'hello world' }] as never);
  const t1 = await source.store.createThread({ initialComment: { body: asCommentBody('on hello') as never } });
  const t2 = await source.store.createThread({ initialComment: { body: asCommentBody('on world') as never } });
  let at = -1;
  source.view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText) at = pos;
    return at < 0;
  });
  const marks = source.view.state.schema.marks[COMMENT_MARK];
  source.view.dispatch(source.view.state.tr
    .addMark(at, at + 5, marks.create({ threadId: t1.id, orphan: false }))
    .addMark(at + 6, at + 11, marks.create({ threadId: t2.id, orphan: false })));
  Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc), 'remote');
  await settleEditor();
  return { ...target, t1: t1.id, t2: t2.id };
}

/**
 * Lets the editor's deferred work (thread store subscriptions, mark sync) run.
 * @returns When it has run.
 */
async function settleEditor(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * The `orphan` flags of the marks naming a thread.
 * @param view - The editor view.
 * @param threadId - The thread.
 * @returns One flag per marked text node.
 */
function orphanFlags(view: EditorView, threadId: string): boolean[] {
  const flags: boolean[] = [];
  view.state.doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === COMMENT_MARK && mark.attrs['threadId'] === threadId) flags.push(mark.attrs['orphan'] === true);
    return true;
  });
  return flags;
}

/**
 * The painted highlight elements of one thread.
 * @param root - The editor's element.
 * @param threadId - The thread.
 * @returns The elements.
 */
function painted(root: HTMLElement, threadId: string): Element[] {
  return [...root.querySelectorAll(`.doc-comment-mark-live[data-thread-id="${threadId}"]`)];
}

describe('CM-08 and CM-09 a deleted thread loses its highlight in every state', () => {
  it('CM-08 at F deleting t1 removes the thread, the mark sync is held back silently and t1 is no longer painted', async () => {
    const board = await openMarked();
    expect(painted(board.root, board.t1).length).toBeGreaterThan(0);
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    await board.store.deleteThread({ threadId: board.t1 });
    await settleEditor();
    expect(documentCommentThreads(board.doc).has(board.t1)).toBe(false);
    // The library's mark sync is an edit the full Space holds back.
    expect(orphanFlags(board.view, board.t1)).toEqual([false]);
    expect(painted(board.root, board.t1)).toEqual([]);
    expect(painted(board.root, board.t2).length).toBeGreaterThan(0);
    expectSizeToast(null);
  });

  it('CM-09 at N deleting t1 leaves the same picture', async () => {
    const board = await openMarked();
    enterSize(NAME, 'N');
    await board.store.deleteThread({ threadId: board.t1 });
    await settleEditor();
    expect(documentCommentThreads(board.doc).has(board.t1)).toBe(false);
    expect(painted(board.root, board.t1)).toEqual([]);
    expect(painted(board.root, board.t2).length).toBeGreaterThan(0);
    expectSizeToast(null);
  });
});

describe('CM-10 a peer resolving a thread on a full Space', () => {
  it('CM-10 at F the local mark sync is held back without a toast and the body is unchanged', async () => {
    const board = await openMarked();
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const body = board.view.state.doc.toJSON();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(board.doc));
    const vector = Y.encodeStateVector(board.doc);
    const entry = documentCommentThreads(peer).get(board.t1) as Y.Map<unknown>;
    peer.transact(() => {
      entry.set('resolved', true);
      entry.set('resolvedUpdatedAt', Date.now());
    });
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(peer, vector), 'remote');
    peer.destroy();
    await settleEditor();
    expect(board.view.state.doc.toJSON()).toEqual(body);
    expect(orphanFlags(board.view, board.t1)).toEqual([false]);
    expectSizeToast(null);
  });
});
