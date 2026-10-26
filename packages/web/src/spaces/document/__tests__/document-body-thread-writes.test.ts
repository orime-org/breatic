// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { CommentsExtension, type ThreadStore } from '@blocknote/core/comments';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { documentCommentThreads, encodeInitialSpaceContent, type ProjectRole } from '@breatic/shared';

import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { _resetDocumentEditorCacheForTests, adoptDocumentEditor, getDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { openCommentDraft } from '@web/spaces/document/document-comment-entries';
import { draftIn } from '@web/spaces/document/document-comment-draft-range';
import { draftWordsOf, repliesOf, writeDraftWords, writeReply } from '@web/spaces/document/document-comment-unsent';
import { postComment } from '@web/spaces/document/document-comment-post';
import { replyToThread } from '@web/spaces/document/document-comment-thread-actions';

const METHODS = ['createThread', 'addComment', 'updateComment', 'deleteComment', 'deleteThread',
  'resolveThread', 'unresolveThread', 'addReaction', 'deleteReaction'] as const;
type Method = typeof METHODS[number];
const STATES = ['active', 'waiting', 'failed', 'disposed', 'viewer'] as const;
const documents: Y.Doc[] = [];
const cursors: Awareness[] = [];
const ORIGINAL = [{ type: 'paragraph', content: [{ type: 'text', text: 'Original', styles: {} }] }];
const CHANGED = [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed', styles: {} }] }];

/**
 * Invokes each actual library method with existing, author-owned input.
 * @returns The native store's actual result.
 * @throws {Error} If the native writer rejects permission or input.
 */
function invoke(store: ThreadStore, method: Method, threadId: string, commentId: string): Promise<unknown> {
  switch (method) {
    case 'createThread': return store.createThread({ initialComment: { body: CHANGED } });
    case 'addComment': return store.addComment({ threadId, comment: { body: CHANGED } });
    case 'updateComment': return store.updateComment({ threadId, commentId, comment: { body: CHANGED } });
    case 'deleteComment': return store.deleteComment({ threadId, commentId });
    case 'deleteThread': return store.deleteThread({ threadId });
    case 'resolveThread': return store.resolveThread({ threadId });
    case 'unresolveThread': return store.unresolveThread({ threadId });
    case 'addReaction': return store.addReaction({ threadId, commentId, emoji: 'test' });
    case 'deleteReaction': return store.deleteReaction({ threadId, commentId, emoji: 'test' });
  }
}

afterEach(() => {
  act(() => _resetDocumentEditorCacheForTests());
  cursors.splice(0).forEach((awareness) => awareness.destroy());
  documents.splice(0).forEach((doc) => doc.destroy());
});

describe('actual native thread store final writer admission', () => {
  it('retains a reply when its native write completes but the handle fails before the awaited result', async () => {
    const doc = new Y.Doc();
    documents.push(doc);
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const awareness = new Awareness(doc);
    cursors.push(awareness);
    const handle = getDocumentEditor(doc, 'document:reply-result-after-failure', {
      caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
    });
    const store = handle.editor.getExtension(CommentsExtension)!.threadStore;
    const thread = await store.createThread({ initialComment: { body: ORIGINAL } });
    writeReply(handle.editor, thread.id, 'Reply draft');
    const held = repliesOf(handle.editor);
    const binding = bodyBindingOf(handle.editor.prosemirrorState);
    if (binding === null) throw new Error('Missing actual records binding');
    const threads = documentCommentThreads(doc);
    /** Fails only after the native store has actually added the reply. */
    const failAfterWrite = (): void => {
      handle.runtime.fail({ phase: 'idle', error: new Error('reply result failure'), batch: null,
        epoch: binding.read().epoch, accepted: binding.read().doc, selection: null, journal: null,
        lastGood: binding.read(), writeStarted: false, writeReturned: false });
    };
    threads.observeDeep(failAfterWrite);
    try {
      const operation = replyToThread(handle.editor, thread.id, 'Reply draft').then((sent) => {
        if (sent) writeReply(handle.editor, thread.id, '');
      });
      await expect(operation).rejects.toThrow('Document editing is unavailable');
      expect(store.getThreads().get(thread.id)!.comments).toHaveLength(2);
      expect(repliesOf(handle.editor)).toBe(held);
      expect(held.get(thread.id)).toBe('Reply draft');
      expect(handle.runtime.read().status).toBe('failed');
    } finally {
      threads.unobserveDeep(failAfterWrite);
    }
  });

  it('reports an already-created thread without marking or completing a draft after failure', async () => {
    const doc = new Y.Doc();
    documents.push(doc);
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const awareness = new Awareness(doc);
    cursors.push(awareness);
    const handle = getDocumentEditor(doc, 'document:thread-result-after-failure', {
      caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    act(() => {
      adoptDocumentEditor(handle, host);
      handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'Discuss' }] as never);
      let range = { from: 0, to: 0 };
      handle.editor.prosemirrorState.doc.descendants((node, pos) => {
        if (node.isText) range = { from: pos, to: pos + node.nodeSize };
      });
      openCommentDraft(handle.editor, [range]);
    });
    const draft = draftIn(handle.editor.prosemirrorState);
    if (draft === null) throw new Error('Expected the actual open draft');
    writeDraftWords(draft.opening, 'New draft');
    const binding = bodyBindingOf(handle.editor.prosemirrorState);
    if (binding === null) throw new Error('Missing actual records binding');
    const threads = documentCommentThreads(doc);
    /** Pauses after the real native thread mutation and before its Promise is observed. */
    const failAfterWrite = (): void => {
      handle.runtime.fail({ phase: 'idle', error: new Error('thread result failure'), batch: null,
        epoch: binding.read().epoch, accepted: binding.read().doc, selection: null, journal: null,
        lastGood: binding.read(), writeStarted: false, writeReturned: false });
    };
    threads.observe(failAfterWrite);
    try {
      await expect(postComment(handle.editor, 'New draft')).rejects.toThrow();
      expect(threads.size).toBe(1);
      expect(draftWordsOf(draft.opening)).toBe('New draft');
      expect(draftIn(handle.editor.prosemirrorState)?.opening).toBe(draft.opening);
      const marked: string[] = [];
      handle.editor.prosemirrorState.doc.descendants((node) => {
        for (const mark of node.marks) if (mark.type.name === 'comment') marked.push(String(mark.attrs['threadId']));
      });
      expect(marked).toEqual([]);
      expect(handle.runtime.read().status).toBe('failed');
    } finally {
      threads.unobserve(failAfterWrite);
      host.remove();
    }
  });

  it.each(STATES.flatMap((state) => METHODS.map((method) => [state, method] as const)))(
    '%s admits %s only under the existing permission and live runtime', async (state, method) => {
      const doc = new Y.Doc();
      documents.push(doc);
      Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
      const awareness = new Awareness(doc);
      cursors.push(awareness);
      let role: ProjectRole = 'editor';
      const handle = getDocumentEditor(doc, `document:thread-${state}-${method}`, {
        caretProvider: { awareness }, readWho: () => ({ role, viewerId: 'u1' }), editable: true,
      });
      const store = handle.editor.getExtension(CommentsExtension)!.threadStore;
      const thread = await store.createThread({ initialComment: { body: ORIGINAL } });
      const commentId = thread.comments[0].id;
      if (method === 'unresolveThread') await store.resolveThread({ threadId: thread.id });
      const binding = bodyBindingOf(handle.editor.prosemirrorState);
      if (binding === null) throw new Error('Missing actual records binding');
      act(() => {
        if (state === 'waiting') handle.runtime.wait(['context:later']);
        else if (state === 'failed') handle.runtime.fail({ phase: 'preflighting', error: new Error('thread writer failure'),
          batch: null, epoch: binding.read().epoch, accepted: binding.read().doc, selection: null,
          journal: null, lastGood: binding.read(), writeStarted: false, writeReturned: false });
        else if (state === 'disposed') binding.dispose();
        else if (state === 'viewer') role = 'viewer';
      });
      const before = Y.encodeStateAsUpdate(doc);
      const threadBefore = store.getThreads().get(thread.id);
      let updates = 0;
      doc.on('update', () => { updates += 1; });
      const operation = invoke(store, method, thread.id, commentId);
      if (state !== 'active' || method === 'addReaction' || method === 'deleteReaction') {
        await expect(operation).rejects.toThrow('Not authorized');
        expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
        expect(updates).toBe(0);
        expect(store.getThreads().get(thread.id)).toEqual(threadBefore);
        return;
      }
      await operation;
      expect(updates).toBe(1);
      const current = store.getThreads();
      if (method === 'createThread') expect(current.size).toBe(2);
      else if (method === 'addComment') expect(current.get(thread.id)!.comments.map((item) => item.body)).toEqual([ORIGINAL, CHANGED]);
      else if (method === 'updateComment') expect(current.get(thread.id)!.comments[0].body).toEqual(CHANGED);
      else if (method === 'deleteComment' || method === 'deleteThread') expect(documentCommentThreads(doc).has(thread.id)).toBe(false);
      else expect(current.get(thread.id)!.resolved).toBe(method === 'resolveThread');
    },
  );
});
