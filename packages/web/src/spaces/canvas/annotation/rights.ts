// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectRole } from '@breatic/shared';

/**
 * What this person may do to one annotation or one reply.
 *
 * Editing follows authorship alone — an owner cannot rewrite what someone else
 * said, because a reply further down was written against those words. Deleting
 * follows either: your own, or an owner clearing the board.
 *
 * This is the front-end half of the soft check the spec settles on (§10.17.3):
 * the Yjs layer gates whole connections, not fields, so these answers decide
 * which controls render. Members of a project know each other, and the rule
 * about not coding against insiders applies here.
 */
export interface AnnotationRights {
  /** May rewrite this particular body. */
  canEdit: boolean;
  /** May remove this particular annotation or reply. */
  canDelete: boolean;
}

/**
 * Whether this person may add words at all — a new note, or a reply to one.
 *
 * A viewer-level answer, so it takes the role and nothing else. It used to
 * ride on {@link AnnotationRights}, which is per-entry, and the call site read
 * as though whether you may reply depended on who wrote the note.
 * @param role - This person's role on the project.
 * @returns Whether they may post.
 */
export function canPostAnnotations(role: ProjectRole): boolean {
  return role !== 'viewer';
}

export interface RightsInput {
  /** This person's role on the project. */
  role: ProjectRole;
  /** This person's user id, absent until the project query answers. */
  viewerId: string | undefined;
  /** The `createdBy` on the annotation or reply being judged. */
  authorId: string;
}

/**
 * Decide what this person may do to one annotation or reply.
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
  const mayWrite = canPostAnnotations(role);
  // An empty id on either side means "unknown", and unknown never matches:
  // two anonymous sides are not the same person.
  const isAuthor =
    viewerId !== undefined && viewerId.length > 0 && viewerId === authorId;
  return {
    canEdit: mayWrite && isAuthor,
    canDelete: mayWrite && (isAuthor || role === 'owner'),
  };
}
