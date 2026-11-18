// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment records (#1488 §11.6, §11.7): collab hands over what a Space
 * document reads after a store, and this keeps `comment_mentions` and
 * `comment_assignments` in step with it and sends the notifications they
 * call for, in one transaction.
 */

import { db } from "@core/db/client.js";
import { loadProjectRole } from "@core/auth/projectAuth.service.js";
import * as notificationRepo from "@core/notification/notification.repo.js";
import * as mentionsRepo from "@core/comment-record/comment-mentions.repo.js";
import * as assignmentsRepo from "@core/comment-record/comment-assignments.repo.js";
import type { MentionRow } from "@core/comment-record/comment-mentions.repo.js";
import type { AssignmentRow } from "@core/comment-record/comment-assignments.repo.js";

/** A uuid, the form every id column of these tables takes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sync one Space's records with what its document reads now, and notify: a
 * member mentioned for the first time in an entry, and a hand-giver whose
 * agent answered their hand-over, each when they can still open the project.
 * Ids that are not uuids are collaborative data no client of ours writes and
 * are skipped.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param read - The mentions and hand-overs the document reads.
 * @param read.mentions - Its mentions.
 * @param read.assignments - Its hand-overs.
 * @returns Whether the Space's hand-overs changed.
 * @throws {Error} When the database fails.
 */
export async function syncSpace(
  projectId: string,
  spaceId: string,
  read: { mentions: readonly MentionRow[]; assignments: readonly AssignmentRow[] },
): Promise<{ assignmentsChanged: boolean }> {
  const mentions = read.mentions.filter((m) => UUID.test(m.userId) && UUID.test(m.authorId));
  const assignments = read.assignments.filter((a) => UUID.test(a.connectionId) && UUID.test(a.assignedBy));
  return db.transaction(async (tx) => {
    const inserted = await mentionsRepo.syncSpace(projectId, spaceId, mentions, tx);
    const sync = await assignmentsRepo.syncSpace(projectId, spaceId, assignments, tx);
    for (const m of inserted) {
      // Mentioning oneself tells nobody anything.
      if (m.userId === m.authorId || (await loadProjectRole(m.userId, projectId)) === null) continue;
      if (!(await mentionsRepo.markNotified(m.id, tx))) continue;
      await notificationRepo.create(
        {
          userId: m.userId,
          type: "comment.mentioned",
          payload: { projectId, spaceId, entryId: m.entryId, threadId: m.threadId, authorId: m.authorId },
          projectId,
        },
        tx,
      );
    }
    for (const a of sync.answered) {
      if ((await loadProjectRole(a.assignedBy, projectId)) === null) continue;
      if (!(await assignmentsRepo.markNotified(a.id, tx))) continue;
      await notificationRepo.create(
        {
          userId: a.assignedBy,
          type: "comment.assignment_answered",
          payload: { projectId, spaceId, threadId: a.threadId, connectionId: a.connectionId },
          projectId,
        },
        tx,
      );
    }
    return { assignmentsChanged: sync.changed };
  });
}

/**
 * Void a deleted Space's records.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns Whether the Space had hand-overs.
 * @throws {Error} When the database fails.
 */
export async function voidSpace(projectId: string, spaceId: string): Promise<{ assignmentsChanged: boolean }> {
  return db.transaction(async (tx) => {
    await mentionsRepo.voidSpace(projectId, spaceId, tx);
    return { assignmentsChanged: await assignmentsRepo.voidSpace(projectId, spaceId, tx) };
  });
}
