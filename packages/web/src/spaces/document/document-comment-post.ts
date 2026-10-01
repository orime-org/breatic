// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Posting a comment on the range the open draft is aimed at (#18, A1 · A2 · A21).
 *
 * Two steps in this order, because the thread's id is what the mark carries:
 * create the thread, then mark the words. The library does not offer the
 * second step — `YjsThreadStore.addThreadToDocument` is `undefined`, its own
 * comment saying the store does not support it — and the fallback it would
 * otherwise use is `setMark` on the current selection, which the block entry
 * has no way to hand a range to (design §6.1).
 *
 * Writing it here is what makes the two entries one operation: the bubble bar
 * opens the draft on the reader's selection, the block handle opens it on
 * `selectionOverBlockContent`, and from this point they are identical — which
 * is what A2 asks for, a whole-block comment reading the same as selecting
 * that block's text by hand.
 *
 * WHERE THE RANGE COMES FROM. Not from the caller: from the draft plugin, as
 * it stands at the moment of posting. The plugin is the one thing that has
 * carried that range across every edit since the draft opened, and reading it
 * here closes a gap a caller cannot — a peer's deletion can arrive between
 * React rendering the draft card and the reader pressing post, and a range read
 * at render time would be stale by then. A gone range posts nothing and the
 * caller says why (A21).
 */

import { CommentsExtension, type ThreadData } from '@blocknote/core/comments';

import { draftRangeIn } from '@web/spaces/document/document-comment-draft-range';
import {
  COMMENT_MARK,
  asCommentBody,
  commentsOn,
} from '@web/spaces/document/document-comment-extension';


/** The editor surface this needs. */
interface CommentableEditor {
  /** The view, absent until the editor is mounted. */
  readonly prosemirrorView: {
    readonly state: import('@tiptap/pm/state').EditorState;
    dispatch(tr: import('@tiptap/pm/state').Transaction): void;
  } | null;
  /**
   * The registered extension matching this factory.
   * @param extension - The factory to match on.
   */
  getExtension(extension: typeof CommentsExtension): unknown;
}

/**
 * Creates a thread for what the reader wrote and marks the words it is about.
 * @param editor - The document editor, with the draft and comments
 *   extensions registered.
 * @param body - What the reader wrote.
 * @returns The thread created, or null when there is no open draft or the
 *   text it was aimed at is gone — in which case nothing was created.
 * @throws {Error} Whatever the thread store throws while creating the thread.
 */
export async function postComment(
  editor: CommentableEditor,
  body: string,
): Promise<ThreadData | null> {
  const view = editor.prosemirrorView;
  if (view === null) return null;

  const range = draftRangeIn(view.state);
  if (range === null) return null;

  const comments = commentsOn(editor);
  if (comments === undefined) return null;

  const thread = (await comments.threadStore.createThread({
    initialComment: { body: asCommentBody(body) },
  })) as ThreadData;

  // Read again: creating the thread was a round trip, and the body may have
  // moved or lost those words while it was in flight. The thread stays in
  // the map, but with no mark it has no entry in the position table, so the
  // panel leaves it out like any thread whose words are gone — §9.2's S3.
  const landing = draftRangeIn(view.state);
  if (landing === null) return thread;

  const mark = view.state.schema.marks[COMMENT_MARK]!.create({
    threadId: thread.id,
    orphan: false,
  });
  view.dispatch(view.state.tr.addMark(landing.from, landing.to, mark));

  return thread;
}
