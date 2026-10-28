// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Posting a comment: `commentOn` for any caller that says where, and
 * `postComment` for the reader's own draft (#18, A1 · A2 · A21; inner#1509).
 *
 * Two steps in this order, because the thread's id is what the mark carries:
 * create the thread, then mark the words. The library does not offer the
 * second step — `YjsThreadStore.addThreadToDocument` is `undefined`, its own
 * comment saying the store does not support it — and the fallback it would
 * otherwise use is `setMark` on the current selection, which the block entry
 * has no way to hand a range to (design §6.1).
 *
 * Writing it here is what makes every entry one operation: the bubble bar
 * opens the draft on the reader's selection and the block handle opens it on
 * `selectionOverBlockContent`, both posting through `postComment`, and an
 * Agent proposal landing calls `commentOn` with the range it aims at. From
 * `commentOn` on they are identical — which is what A2 asks for, a whole-block
 * comment reading the same as selecting that block's text by hand.
 *
 * WHERE `postComment` TAKES THE RANGE FROM: the draft plugin, as it stands at
 * the moment of posting. The plugin is the one thing that has
 * carried that range across every edit since the draft opened, and reading it
 * here closes a gap a caller cannot — a peer's deletion can arrive between
 * React rendering the draft card and the reader pressing post, and a range read
 * at render time would be stale by then. A gone range posts nothing and the
 * caller says why (A21).
 */

import { CommentsExtension, type ThreadData } from '@blocknote/core/comments';
import type { EditorState } from '@tiptap/pm/state';

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
    readonly state: EditorState;
    dispatch(tr: import('@tiptap/pm/state').Transaction): void;
  } | null;
  /**
   * The registered extension matching this factory.
   * @param extension - The factory to match on.
   */
  getExtension(extension: typeof CommentsExtension): unknown;
}

/** Where a comment goes, read off the body as it stands. */
export type CommentAim = (state: EditorState) => ReadonlyArray<{ from: number; to: number }> | null;

/** What a comment carries beside its words: on the thread, and on its first comment. */
export interface CommentMetadata {
  thread?: Record<string, unknown>;
  comment?: Record<string, unknown>;
}

/**
 * Whether an aim found words to mark: a block with no text gives no ranges.
 * @param ranges - What the aim read off the body.
 * @returns True when there is at least one range.
 */
function somewhere(ranges: ReturnType<CommentAim>): ranges is NonNullable<ReturnType<CommentAim>> {
  return ranges !== null && ranges.length > 0;
}

/**
 * Creates a thread and marks the words it is about.
 *
 * The aim is read twice: once to see there is somewhere to comment before
 * anything is created, and again after the thread exists, because creating it
 * was a round trip and the words may have moved or gone meanwhile. Gone, the
 * thread stays in the map with no mark, so the panel leaves it out like any
 * thread whose words are gone -- §9.2's S3.
 * @param editor - The document editor, with the comments extension registered.
 * @param body - The first comment, as a comment body.
 * @param aim - Where the comment goes, read off the body as it stands.
 * @param metadata - What the thread and its first comment carry, if anything.
 * @returns The thread created, or null when there was nowhere to comment --
 *   in which case nothing was created.
 * @throws {Error} Whatever the thread store throws while creating the thread.
 */
export async function commentOn(
  editor: CommentableEditor,
  body: unknown,
  aim: CommentAim,
  metadata: CommentMetadata = {},
): Promise<ThreadData | null> {
  const view = editor.prosemirrorView;
  if (view === null || !somewhere(aim(view.state))) return null;

  const comments = commentsOn(editor);
  if (comments === undefined) return null;

  const thread = (await comments.threadStore.createThread({
    initialComment: { body, ...(metadata.comment === undefined ? {} : { metadata: metadata.comment }) },
    ...(metadata.thread === undefined ? {} : { metadata: metadata.thread }),
  })) as ThreadData;

  const landing = aim(view.state);
  if (!somewhere(landing)) return thread;

  const mark = view.state.schema.marks[COMMENT_MARK]!.create({
    threadId: thread.id,
    orphan: false,
  });
  const tr = view.state.tr;
  for (const { from, to } of landing) tr.addMark(from, to, mark);
  view.dispatch(tr);

  return thread;
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
export function postComment(editor: CommentableEditor, body: string): Promise<ThreadData | null> {
  return commentOn(editor, asCommentBody(body), (state) => draftRangeIn(state)?.segments ?? null);
}
