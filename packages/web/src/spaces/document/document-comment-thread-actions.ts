// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The writes a card makes to a thread (#18, A7 · A8 · A9 · A10 · A11 · A12).
 *
 * Each one is the thread store's own call with the editor's store found for
 * it. The store asks its auth before every one of them, so what a card offers
 * and what may actually happen are two answers to one question — a control
 * drawn by mistake fails rather than damaging anything.
 *
 * Opening a thread is NOT here: it writes a mark into the body as well as a
 * thread into the store, and that pairing is what `postComment` owns.
 */

import { CommentsExtension } from '@blocknote/core/comments';

import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** The thread store, as the writes here use it. */
interface ThreadWrites {
  addComment(options: {
    threadId: string;
    comment: { body: unknown };
  }): Promise<unknown>;
  resolveThread(options: { threadId: string }): Promise<unknown>;
  unresolveThread(options: { threadId: string }): Promise<unknown>;
  deleteThread(options: { threadId: string }): Promise<unknown>;
  deleteComment(options: {
    threadId: string;
    commentId: string;
  }): Promise<unknown>;
}

/**
 * The thread store behind one editor.
 * @param editor - The document editor.
 * @returns Its thread store, or null when comments are not wired to it.
 */
function threadsOf(editor: ToolEditor): ThreadWrites | null {
  const extension = (
    editor as unknown as {
      getExtension(factory: unknown): { threadStore: ThreadWrites } | undefined;
    }
  ).getExtension(CommentsExtension);
  return extension?.threadStore ?? null;
}

/**
 * The reader's words in the shape a comment body takes.
 *
 * A body is a BlockNote document, so one paragraph holding one run is the
 * whole of a plain-text reply. The same shape `postComment` writes, because a
 * reply and an opening comment are the same kind of thing.
 * @param text - What the reader wrote.
 * @returns That text as a comment body.
 */
function asCommentBody(text: string): unknown {
  return [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];
}

/**
 * Adds a reply to a thread (A7).
 * @param editor - The document editor.
 * @param threadId - Which thread to reply on.
 * @param body - What the reply says.
 * @returns True when a reply was written; false for blank words, which are
 *   not worth writing, and for an editor with no comments wired.
 * @throws {Error} Whatever the thread store throws, an unauthorised write
 *   among them.
 */
export async function replyToThread(
  editor: ToolEditor,
  threadId: string,
  body: string,
): Promise<boolean> {
  const threads = threadsOf(editor);
  if (threads === null || body.trim().length === 0) return false;
  await threads.addComment({
    threadId,
    comment: { body: asCommentBody(body) },
  });
  return true;
}

/**
 * Marks a thread settled (A8).
 * @param editor - The document editor.
 * @param threadId - Which thread.
 * @throws {Error} Whatever the thread store throws.
 */
export async function resolveThread(
  editor: ToolEditor,
  threadId: string,
): Promise<void> {
  await threadsOf(editor)?.resolveThread({ threadId });
}

/**
 * Brings a settled thread back (A9).
 * @param editor - The document editor.
 * @param threadId - Which thread.
 * @throws {Error} Whatever the thread store throws.
 */
export async function reopenThread(
  editor: ToolEditor,
  threadId: string,
): Promise<void> {
  await threadsOf(editor)?.unresolveThread({ threadId });
}

/**
 * Withdraws a whole thread (A10 · A12).
 *
 * The highlight goes with it: the library's mark sync walks the body whenever
 * the threads change and clears a mark whose thread is gone.
 * @param editor - The document editor.
 * @param threadId - Which thread.
 * @throws {Error} Whatever the thread store throws.
 */
export async function removeThread(
  editor: ToolEditor,
  threadId: string,
): Promise<void> {
  await threadsOf(editor)?.deleteThread({ threadId });
}

/**
 * Withdraws one reply, leaving the thread (A11 · A12).
 * @param editor - The document editor.
 * @param threadId - The thread it is on.
 * @param commentId - Which reply.
 * @throws {Error} Whatever the thread store throws.
 */
export async function removeReply(
  editor: ToolEditor,
  threadId: string,
  commentId: string,
): Promise<void> {
  await threadsOf(editor)?.deleteComment({ threadId, commentId });
}
