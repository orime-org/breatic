// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Two people with the same document open (#18, A8 · A14).
 *
 * Threads live in the same Y.Doc as the body, under the key
 * `documentCommentThreads` owns, so one collab connection carries both and a
 * comment cannot arrive without the text it points at. What that buys is A14,
 * and it is the reason `YjsThreadStore` was chosen: no second transport, no
 * backend change.
 *
 * The two documents here are wired the way two clients are — each other's
 * updates applied as they happen — so what passes here is what a peer sees.
 *
 * A8's first half is in this file too, because it is the same mechanism seen
 * from one side: resolving a thread is a write to that map, and the library
 * answers it by marking the highlight as one not to paint.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import {
  replyToThread,
  resolveThread,
} from '@web/spaces/document/document-comment-thread-actions';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor over one document, wired for comments.
 * @param doc - The document it binds to.
 * @param viewerId - Who is at this keyboard.
 * @returns The editor, mounted.
 */
function open(doc: Y.Doc, viewerId: string): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return editor;
}

/**
 * Two clients on the same document, each hearing the other.
 * @returns Both editors, the first already holding one line.
 */
function twoClients(): { mine: Editor; theirs: Editor } {
  const ours = new Y.Doc();
  const peer = new Y.Doc();
  ours.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== peer) Y.applyUpdate(peer, update, ours);
  });
  peer.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== ours) Y.applyUpdate(ours, update, peer);
  });
  const mine = open(ours, 'u1');
  mine.replaceBlocks(mine.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
  ] as never);
  const theirs = open(peer, 'u2');
  return { mine, theirs };
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
 * Comments on the first word.
 * @param editor - Whose keyboard the comment is written at.
 * @param body - What it says.
 * @returns The thread's id.
 */
async function comment(editor: Editor, body: string): Promise<string> {
  const run = firstRun(editor);
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
      from: run.from,
      to: run.from + 5,
    }]),
  );
  const thread = await postComment(editor, body);
  return thread!.id;
}

/** Every thread the given client holds. */
function threadsOf(editor: Editor): Map<string, unknown> {
  return editor.getExtension(CommentsExtension)!.threadStore.getThreads();
}

/** Every highlight currently painted in the given client's body. */
function paintedMarks(editor: Editor): HTMLElement[] {
  return [
    ...(editor.domElement?.querySelectorAll<HTMLElement>(
      '.bn-thread-mark:not([data-orphan="true"])',
    ) ?? []),
  ];
}

describe('a comment made by one of two people', () => {
  it('reaches the other, with the words it is about', async () => {
    const { mine, theirs } = twoClients();

    const threadId = await comment(mine, 'have a look at this');

    expect([...threadsOf(theirs).keys()]).toEqual([threadId]);
    expect(paintedMarks(theirs).map((mark) => mark.textContent)).toEqual([
      'alpha',
    ]);
  });

  it('carries a reply the other writes back', async () => {
    const { mine, theirs } = twoClients();
    const threadId = await comment(mine, 'have a look at this');

    await replyToThread(theirs, threadId, 'looking now');

    const thread = threadsOf(mine).get(threadId) as { comments: unknown[] };
    expect(thread.comments).toHaveLength(2);
  });

  it('takes the highlight away on both sides once it is resolved', async () => {
    // A8: the mark stays where it is — it is what the highlight comes back
    // from — and the library marks it as one not to paint.
    const { mine, theirs } = twoClients();
    const threadId = await comment(mine, 'done with this');
    expect(paintedMarks(mine)).toHaveLength(1);

    await resolveThread(theirs, threadId);

    expect(paintedMarks(mine)).toHaveLength(0);
    expect(paintedMarks(theirs)).toHaveLength(0);
    expect(
      mine.domElement?.querySelectorAll('.bn-thread-mark'),
    ).toHaveLength(1);
  });
});
