// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Motion Space's annotation threads (#1490 design §10.2): the same BlockNote `YjsThreadStore` and size gate the
 * Document comments use, under the root key `webAnimationAnnotationThreads` of the Motion Space's own document. A
 * full Space refuses a new thread, and still lets the last comment of a thread go by removing the whole thread from
 * that root.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { documentCommentThreads, webAnimationAnnotationThreads } from '@breatic/shared';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { SpaceFullError, checkCommentAdd } from '@web/spaces/document/document-comment-thread-store';
import { webAnimationAnnotationStore } from '@web/spaces/web-animation/annotation-thread-store';

const NAME = docName.webAnimationSpace('p1', 'm1');
const ANCHOR = { executionId: 'e0000000-0000-4000-8000-000000000001', timeSeconds: 2.5, point: { x: 0.25, y: 0.5 } };

afterEach(() => {
  clearAllDocSizes();
  _resetForTests();
  vi.clearAllMocks();
});

/**
 * The registered Motion document and its store, for an editor.
 * @returns Both.
 */
function open(): { doc: Y.Doc; store: ReturnType<typeof webAnimationAnnotationStore> } {
  const doc = getDoc(NAME);
  return { doc, store: webAnimationAnnotationStore({ doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) }) };
}

describe('webAnimationAnnotationStore', () => {
  it('writes a thread with its anchor under webAnimationAnnotationThreads and nothing under the Document root', async () => {
    const { doc, store } = open();
    const thread = await store.createThread({ initialComment: { body: asCommentBody('Too fast here') as never }, metadata: { webAnimationAnchor: ANCHOR } });
    const stored = webAnimationAnnotationThreads(doc).get(thread.id) as Y.Map<unknown> | undefined;
    expect(stored?.get('metadata')).toEqual({ webAnimationAnchor: ANCHOR });
    expect(documentCommentThreads(doc).size).toBe(0);
    expect(doc.getMap('webAnimationAnnotationThreads')).toBe(webAnimationAnnotationThreads(doc));
  });

  it('refuses a new thread on a full Space, changing nothing', async () => {
    const { doc, store } = open();
    enterSize(NAME, 'F');
    const before = Y.encodeStateAsUpdate(doc);
    await expect(store.createThread({ initialComment: { body: asCommentBody('x') as never }, metadata: { webAnimationAnchor: ANCHOR } })).rejects.toBeInstanceOf(SpaceFullError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(checkCommentAdd(store, false).ok).toBe(false);
  });

  it('removes the whole thread from its own root when its last comment is deleted on a full Space', async () => {
    const { doc, store } = open();
    const thread = await store.createThread({ initialComment: { body: asCommentBody('x') as never }, metadata: { webAnimationAnchor: ANCHOR } });
    enterSize(NAME, 'F');
    await store.deleteComment({ threadId: thread.id, commentId: thread.comments[0]!.id });
    expect(webAnimationAnnotationThreads(doc).has(thread.id)).toBe(false);
  });

  it('keeps the anchor it was created with through a reply, a resolve and a reopen', async () => {
    const { doc, store } = open();
    const thread = await store.createThread({ initialComment: { body: asCommentBody('x') as never }, metadata: { webAnimationAnchor: ANCHOR } });
    await store.addComment({ threadId: thread.id, comment: { body: asCommentBody('reply') as never } });
    await store.resolveThread({ threadId: thread.id });
    await store.unresolveThread({ threadId: thread.id });
    expect((webAnimationAnnotationThreads(doc).get(thread.id) as Y.Map<unknown>).get('metadata')).toEqual({ webAnimationAnchor: ANCHOR });
  });
});
