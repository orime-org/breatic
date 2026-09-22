// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who may do what to a comment (#18, A10 · A11 · A12 · A17 · A22).
 *
 * The library asks these questions itself, through the `ThreadStoreAuth` it
 * is handed, and `DefaultThreadStoreAuth` answers three of them the opposite
 * way from this product:
 *
 * | question | library's answer | ours |
 * |---|---|---|
 * | author deletes their own thread | no — editors only | yes (A10) |
 * | non-author editor deletes a reply | yes | no (A12) |
 * | a viewer posts | yes — it has no viewer role | no (A17) |
 *
 * The first is the sharpest: the library's `canDeleteThread` reads the role
 * alone, so the person who opened a thread cannot withdraw it. Its role is
 * `"comment" | "editor"`, which has no room for a reader who may look but not
 * write — and ours may (A17), so every write question has to ask the role too.
 *
 * The answers come from `annotationRights`, delivered with canvas annotations
 * (#1881), so the two surfaces cannot drift apart. What this module adds is
 * the mapping: a thread carries no author of its own, so "who opened it" is
 * the author of its first comment.
 *
 * One question per case, rather than a case per role that asserts several:
 * the first failing assertion ends its case, so a case holding seven of them
 * can only ever prove the first. Each of the nine answers is its own row.
 *
 * TDD: red because `documentCommentAuth` does not exist yet.
 */

import { describe, it, expect } from 'vitest';

import type { CommentData, ThreadData } from '@blocknote/core/comments';

import { documentCommentAuth } from '@web/spaces/document/document-comment-auth';

const AT = new Date('2026-09-22T00:00:00Z');

/** A comment written by the named author. */
const commentBy = (userId: string): CommentData => ({
  type: 'comment',
  id: `c-${userId}`,
  userId,
  createdAt: AT,
  updatedAt: AT,
  reactions: [],
  metadata: undefined,
  body: [],
});

/** A thread opened by the first author named, or by nobody when given none. */
const threadBy = (...authors: readonly string[]): ThreadData => ({
  type: 'thread',
  id: 't1',
  createdAt: AT,
  updatedAt: AT,
  comments: authors.map(commentBy),
  resolved: false,
  metadata: undefined,
});

describe('documentCommentAuth', () => {
  describe('deleting a thread', () => {
    it('lets the person who opened it withdraw it', () => {
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u1' }));
      expect(auth.canDeleteThread(threadBy('u1'))).toBe(true);
    });

    it('lets an owner remove a thread somebody else opened', () => {
      const auth = documentCommentAuth(() => ({ role: 'owner', viewerId: 'u2' }));
      expect(auth.canDeleteThread(threadBy('u1'))).toBe(true);
    });

    it('does not let another editor remove it', () => {
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u2' }));
      expect(auth.canDeleteThread(threadBy('u1'))).toBe(false);
    });

    it('reads a thread with no comments as having no author', () => {
      // The author is the first comment's, so an empty thread has none — and
      // an unknown author matches nobody.
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u1' }));
      expect(auth.canDeleteThread(threadBy())).toBe(false);
    });

    it('still lets an owner remove a thread with no comments', () => {
      // Their right does not run through authorship, so it survives an
      // unknown author. Without this the empty case above would also pass
      // for an implementation that simply refuses every empty thread.
      const auth = documentCommentAuth(() => ({ role: 'owner', viewerId: 'u1' }));
      expect(auth.canDeleteThread(threadBy())).toBe(true);
    });

    it('takes the author from the first comment, not a later one', () => {
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u2' }));
      expect(auth.canDeleteThread(threadBy('u1', 'u2'))).toBe(false);
    });
  });

  describe('deleting one comment', () => {
    it('lets its author withdraw it', () => {
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u1' }));
      expect(auth.canDeleteComment(commentBy('u1'))).toBe(true);
    });

    it('lets an owner remove somebody else\'s', () => {
      const auth = documentCommentAuth(() => ({ role: 'owner', viewerId: 'u2' }));
      expect(auth.canDeleteComment(commentBy('u1'))).toBe(true);
    });

    it('does not let another editor remove it', () => {
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u2' }));
      expect(auth.canDeleteComment(commentBy('u1'))).toBe(false);
    });
  });

  describe('editing one comment', () => {
    it('is allowed for its own author', () => {
      const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: 'u1' }));
      expect(auth.canUpdateComment(commentBy('u1'))).toBe(true);
    });

    it('is refused to an owner, who may delete but not rewrite', () => {
      // A reply further down was written against these words.
      const auth = documentCommentAuth(() => ({ role: 'owner', viewerId: 'u2' }));
      expect(auth.canUpdateComment(commentBy('u1'))).toBe(false);
    });
  });

  describe('a reader the project query has not identified yet', () => {
    const auth = documentCommentAuth(() => ({ role: 'editor', viewerId: undefined }));

    it('is not the author of a thread', () => {
      expect(auth.canDeleteThread(threadBy('u1'))).toBe(false);
    });

    it('is not the author of a comment', () => {
      expect(auth.canDeleteComment(commentBy('u1'))).toBe(false);
    });

    it('cannot rewrite one either', () => {
      expect(auth.canUpdateComment(commentBy('u1'))).toBe(false);
    });
  });

  describe('a viewer', () => {
    const auth = documentCommentAuth(() => ({ role: 'viewer', viewerId: 'u1' }));

    it('cannot open a thread', () => {
      expect(auth.canCreateThread()).toBe(false);
    });

    it('cannot reply', () => {
      expect(auth.canAddComment(threadBy('u1'))).toBe(false);
    });

    it('cannot rewrite even their own comment', () => {
      expect(auth.canUpdateComment(commentBy('u1'))).toBe(false);
    });

    it('cannot delete even their own comment', () => {
      expect(auth.canDeleteComment(commentBy('u1'))).toBe(false);
    });

    it('cannot delete even their own thread', () => {
      expect(auth.canDeleteThread(threadBy('u1'))).toBe(false);
    });

    it('cannot resolve a thread', () => {
      expect(auth.canResolveThread(threadBy('u1'))).toBe(false);
    });

    it('cannot reopen a resolved one', () => {
      expect(auth.canUnresolveThread(threadBy('u1'))).toBe(false);
    });
  });

  describe.each(['editor', 'owner'] as const)('%s', (role) => {
    // Judged against a thread somebody else opened: none of these four turn
    // on authorship.
    const auth = documentCommentAuth(() => ({ role, viewerId: 'u2' }));
    const theirs = threadBy('u1');

    it('may open a thread', () => {
      expect(auth.canCreateThread()).toBe(true);
    });

    it('may reply on somebody else\'s', () => {
      expect(auth.canAddComment(theirs)).toBe(true);
    });

    it('may resolve somebody else\'s', () => {
      expect(auth.canResolveThread(theirs)).toBe(true);
    });

    it('may reopen somebody else\'s', () => {
      expect(auth.canUnresolveThread(theirs)).toBe(true);
    });
  });

  describe('reactions', () => {
    // Nothing in §2 offers a reaction control, so no surface calls these.
    // Answering "no" keeps one from appearing if a library default ever
    // draws one.
    const auth = documentCommentAuth(() => ({ role: 'owner', viewerId: 'u1' }));

    it('cannot be added, by anyone', () => {
      expect(auth.canAddReaction(commentBy('u1'), '+1')).toBe(false);
    });

    it('cannot be taken back, by anyone', () => {
      expect(auth.canDeleteReaction(commentBy('u1'), '+1')).toBe(false);
    });
  });
});
