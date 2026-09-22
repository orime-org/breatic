// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who may do what to a comment (#18, design §4.2).
 *
 * The library asks these nine questions itself — the thread store is handed
 * one of these and calls it before every write — and `DefaultThreadStoreAuth`
 * answers three of them the opposite way from this product:
 *
 * | question | library | ours |
 * |---|---|---|
 * | the author deletes their own thread | no, editors only | yes (A10) |
 * | a non-author editor deletes a reply | yes | no (A12) |
 * | a viewer posts | yes | no (A17) |
 *
 * The third is not a disagreement so much as a missing case: the library's
 * role is `"comment" | "editor"`, and its own notes say view-only people see
 * no comments at all. Here they read the whole panel and may not write in it,
 * so every write question has to consult the role as well as authorship.
 *
 * The answers themselves come from {@link annotationRights}, delivered with
 * canvas annotations (#1881) — one rule, so the two surfaces cannot drift.
 * This module adds only the mapping onto the library's shapes, of which one
 * piece is not obvious: `ThreadData` carries no author, so the person who
 * opened a thread is the author of its first comment.
 */

import {
  ThreadStoreAuth,
  type CommentData,
  type ThreadData,
} from '@blocknote/core/comments';
import type { ProjectRole } from '@breatic/shared';

import {
  annotationRights,
  canPostAnnotations,
  type AnnotationRights,
} from '@web/spaces/canvas/annotation/rights';

/** Who is asking. */
export interface DocumentCommentAuthInput {
  /** This person's role on the project. */
  readonly role: ProjectRole;
  /** This person's user id, absent until the project query answers. */
  readonly viewerId: string | undefined;
}

/**
 * The id that matches nobody.
 *
 * `annotationRights` treats an empty id as unknown, and unknown never equals
 * anything — including another unknown.
 */
const NO_AUTHOR = '';

/**
 * Whoever opened this thread.
 * @param thread - The thread being judged.
 * @returns The first comment's author, or {@link NO_AUTHOR} if it has none.
 */
function threadAuthor(thread: ThreadData): string {
  return thread.comments[0]?.userId ?? NO_AUTHOR;
}

/** Answers the library's auth questions from this project's own rule. */
class DocumentCommentAuth extends ThreadStoreAuth {
  /**
   * Fixes who the answers are about, for the life of this auth.
   * @param who - The role and identity every answer is measured against.
   */
  constructor(private readonly who: DocumentCommentAuthInput) {
    super();
  }

  /**
   * What this person may do to something the named author wrote.
   * @param authorId - Who wrote it, or {@link NO_AUTHOR} when unknown.
   * @returns Their rights over it.
   */
  private rightsOver(authorId: string): AnnotationRights {
    return annotationRights({
      role: this.who.role,
      viewerId: this.who.viewerId,
      authorId,
    });
  }

  /**
   * Whether this person may open a thread at all.
   * @returns True for anyone who may write.
   */
  canCreateThread(): boolean {
    return canPostAnnotations(this.who.role);
  }

  /**
   * Whether this person may reply on a thread.
   * @param _thread - Unread: replying depends on the role, not on whose
   *   thread it is.
   * @returns True for anyone who may write.
   */
  canAddComment(_thread: ThreadData): boolean {
    return canPostAnnotations(this.who.role);
  }

  /**
   * Whether this person may rewrite a comment.
   * @param comment - The comment being judged.
   * @returns True only for its own author, and only while they may write —
   *   an owner cannot rewrite what somebody else said, because the replies
   *   below it were written against those words.
   */
  canUpdateComment(comment: CommentData): boolean {
    return this.rightsOver(comment.userId).canEdit;
  }

  /**
   * Whether this person may remove a comment.
   * @param comment - The comment being judged.
   * @returns True for its author or for an owner (A11 · A12).
   */
  canDeleteComment(comment: CommentData): boolean {
    return this.rightsOver(comment.userId).canDelete;
  }

  /**
   * Whether this person may remove a whole thread.
   * @param thread - The thread being judged.
   * @returns True for whoever opened it or for an owner (A10 · A12).
   */
  canDeleteThread(thread: ThreadData): boolean {
    return this.rightsOver(threadAuthor(thread)).canDelete;
  }

  /**
   * Whether this person may mark a thread resolved.
   * @param _thread - Unread: settling a discussion is not the author's
   *   privilege, and §2 names no narrower rule (A8).
   * @returns True for anyone who may write.
   */
  canResolveThread(_thread: ThreadData): boolean {
    return canPostAnnotations(this.who.role);
  }

  /**
   * Whether this person may reopen a resolved thread.
   * @param _thread - Unread, for the reason above (A9).
   * @returns True for anyone who may write.
   */
  canUnresolveThread(_thread: ThreadData): boolean {
    return canPostAnnotations(this.who.role);
  }

  /**
   * Whether this person may react to a comment.
   * @param _comment - Unread; see the return.
   * @param _emoji - Unread; see the return.
   * @returns False always. Nothing in §2 offers a reaction control, so this
   *   is refused rather than left to a library default that might draw one.
   */
  canAddReaction(_comment: CommentData, _emoji?: string): boolean {
    return false;
  }

  /**
   * Whether this person may take a reaction back.
   * @param _comment - Unread; see the return.
   * @param _emoji - Unread; see the return.
   * @returns False always, for the reason above.
   */
  canDeleteReaction(_comment: CommentData, _emoji?: string): boolean {
    return false;
  }
}

/**
 * Builds the auth the thread store consults.
 * @param who - The role and identity every answer is measured against.
 * @returns An auth answering the library's nine questions.
 */
export function documentCommentAuth(
  who: DocumentCommentAuthInput,
): ThreadStoreAuth {
  return new DocumentCommentAuth(who);
}
