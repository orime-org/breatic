// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place this Space reaches the library's comments through (#18).
 *
 * Every module that reads a thread, writes one, or walks the marks needs two
 * things from the library: the name the mark is registered under, and the
 * extension hanging off the editor. Written per module, both drifted — the
 * name was a bare `'comment'` in seven files, each saying in its docstring
 * that the value belongs to the library and none of them asking the library
 * for it; the extension was fetched five times through five bespoke
 * interfaces and five unchecked casts, two of them sharing a function name
 * and a body while returning different types.
 *
 * The cast is here and nowhere else. A caller narrows what it uses out of
 * `CommentsApi`; it does not describe the library's shape again.
 */

import { CommentsExtension, CommentMark } from '@blocknote/core/comments';
import type { ThreadData } from '@blocknote/core/comments';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';

/**
 * The mark's name on the schema, taken from the mark itself.
 *
 * Read off `CommentMark` so a rename upstream reaches every walk in this
 * Space the moment the dependency moves.
 */
export const COMMENT_MARK: string = CommentMark.name;

/**
 * Whether a mark is a highlight the reader can still act on.
 *
 * A settled thread keeps its mark with `orphan` set so the words under it
 * read as prose (A8), and the library's own press handler reads the
 * attribute the same way. Everything that decides whether a highlight is
 * there asks through here — the paint, the hit test, and the thread this
 * Space names to the library — so a settled one cannot be acted on from a
 * side that forgot to look.
 * @param mark - The mark to judge.
 * @returns Whether it is a comment highlight still standing.
 */
export function isLiveCommentMark(mark: Mark): boolean {
  return mark.type.name === COMMENT_MARK && mark.attrs.orphan !== true;
}

/**
 * Whether the body still carries a standing highlight for one thread.
 * @param doc - The body to walk.
 * @param threadId - The thread to look for.
 * @returns Whether any live mark names it.
 */
export function threadIsPaintedIn(doc: PMNode, threadId: string): boolean {
  let found = false;
  // The walk runs to the end whatever this answers — `descendants` reads a
  // false as "do not go deeper", never as "stop". Measured 2026-09-23 on a
  // 300-block body: one full walk is 0.031ms, so it runs to the end and the
  // flag simply stops asking.
  doc.descendants((node) => {
    if (found) return false;
    found = node.marks.some(
      (mark) => isLiveCommentMark(mark) && mark.attrs.threadId === threadId,
    );
    return !found;
  });
  return found;
}

/** Where a thread's marks sit, as the library reports them. */
export interface ThreadRange {
  /** Where the run starts. */
  readonly from: number;
  /** Where it ends. */
  readonly to: number;
}

/** Everything this Space uses of the comments extension. */
export interface CommentsApi {
  /** Threads, their contents, and every write that changes them. */
  readonly threadStore: {
    getThreads(): Map<string, ThreadData>;
    subscribe(listener: () => void): () => void;
    addComment(options: {
      threadId: string;
      comment: { body: unknown };
    }): Promise<unknown>;
    createThread(options: {
      initialComment: { body: unknown };
    }): Promise<{ id: string }>;
    resolveThread(options: { threadId: string }): Promise<unknown>;
    unresolveThread(options: { threadId: string }): Promise<unknown>;
    deleteThread(options: { threadId: string }): Promise<unknown>;
    deleteComment(options: {
      threadId: string;
      commentId: string;
    }): Promise<unknown>;
  };
  /** Which thread the library believes is being read, and where each sits. */
  readonly store: {
    readonly state: {
      readonly threadPositions: ReadonlyMap<string, ThreadRange>;
      selectedThreadId?: string;
    };
    setState(next: (prev: Record<string, unknown>) => unknown): void;
    subscribe(listener: () => void): () => void;
  };
  /** Who wrote what, resolved lazily by account id. */
  readonly userStore: {
    getUser(id: string): { username: string; avatarUrl?: string } | undefined;
    loadUsers(ids: string[]): Promise<void>;
    store: { subscribe(listener: () => void): () => void };
  };
}

/** Anything that can be asked for one of its extensions. */
interface Extensible {
  /**
   * The registered extension matching a factory.
   * @param factory - The factory to match on.
   */
  getExtension(factory: unknown): unknown;
}

/**
 * The comments extension on this editor, if it has one.
 *
 * Takes anything that answers `getExtension`, because the callers hold the
 * editor under three different types and none of that changes the answer.
 * @param editor - The editor to ask.
 * @returns Its comments extension, or undefined for an editor built without
 *   comments — which is every editor in a test that does not need them.
 */
export function commentsOn(editor: Extensible): CommentsApi | undefined {
  return editor.getExtension(CommentsExtension) as CommentsApi | undefined;
}

/**
 * The reader's words in the shape a comment body takes.
 *
 * A comment body is a BlockNote document, so one paragraph holding one text
 * run is the whole of a plain-text comment. Written here because an opening
 * comment and a reply are the same kind of thing and go through two different
 * modules to reach the same Y.Map.
 * @param text - What the reader wrote.
 * @returns That text as a comment body.
 */
export function asCommentBody(text: string): unknown {
  return [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];
}
