// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectRole } from '@breatic/shared';

/**
 * What this person may do to one annotation or one reply.
 *
 * Posting follows the project role. Editing follows authorship alone — an
 * owner cannot rewrite what someone else said, because a reply further down
 * was written against those words. Deleting follows either: your own, or an
 * owner clearing the board.
 *
 * This is the front-end half of the soft check the spec settles on (§10.17.3):
 * the Yjs layer gates whole connections, not fields, so these answers decide
 * which controls render. Members of a project know each other, and the rule
 * about not coding against insiders applies here.
 */
export interface AnnotationRights {
  /** May write a new annotation or a new reply. */
  canPost: boolean;
  /** May rewrite this particular body. */
  canEdit: boolean;
  /** May remove this particular annotation or reply. */
  canDelete: boolean;
}

/**
 * Nothing may be written.
 *
 * What a locked sticky offers. `data.locked` freezes a node's content, its
 * name and its existence whatever its type (`node-gate.ts`), and a sticky is a
 * node — so the lock has to reach the controls the sticky draws for itself,
 * which are the only way its body and its replies are ever written.
 */
export const NO_ANNOTATION_RIGHTS: AnnotationRights = {
  canPost: false,
  canEdit: false,
  canDelete: false,
};

export interface RightsInput {
  /** This person's role on the project. */
  role: ProjectRole;
  /** This person's user id, absent until the project query answers. */
  viewerId: string | undefined;
  /** The `createdBy` on the annotation or reply being judged. */
  authorId: string;
}

/**
 * Decide the three answers for one annotation or reply.
 * @param input - The role, who is looking, and who wrote it.
 * @param input.role - This person's role on the project.
 * @param input.viewerId - This person's user id, absent until the project query answers.
 * @param input.authorId - The `createdBy` on the annotation or reply being judged.
 * @returns What they may do to it.
 */
export function annotationRights({
  role,
  viewerId,
  authorId,
}: RightsInput): AnnotationRights {
  const canPost = role !== 'viewer';
  // An empty id on either side means "unknown", and unknown never matches:
  // two anonymous sides are not the same person.
  const isAuthor =
    viewerId !== undefined && viewerId.length > 0 && viewerId === authorId;
  return {
    canPost,
    canEdit: canPost && isAuthor,
    canDelete: canPost && (isAuthor || role === 'owner'),
  };
}
