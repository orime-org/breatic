// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment records (#1488 §11.6, §11.7, §11.9): collab calls these while it
 * handles a comment request or an external agent's reply, under the Space
 * count lock, and each writes its records and the notifications they call
 * for in one transaction. What they return tells collab which sets and
 * signals to update once the transaction committed.
 */

import { db, type DbTx } from "@core/db/client.js";
import { loadProjectRole } from "@core/auth/projectAuth.service.js";
import * as notificationRepo from "@core/notification/notification.repo.js";
import * as mentionsRepo from "@core/comment-record/comment-mentions.repo.js";
import * as assignmentsRepo from "@core/comment-record/comment-assignments.repo.js";
import type { MentionRow } from "@core/comment-record/comment-mentions.repo.js";
import type { ThreadPlace } from "@core/comment-record/comment-assignments.repo.js";

/** A uuid, the form every id column of these tables takes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One hand-over's thread and the connection whose set it sits in. */
export interface HandedThread {
  threadId: string;
  connectionId: string;
}

/**
 * Notify a member, inside the transaction, when they can still open the project.
 * @param userId - Whom.
 * @param projectId - The project.
 * @param notification - The type and payload.
 * @param notification.type - Its type.
 * @param notification.payload - Its ids.
 * @param mark - Records the notification as sent; false when it already was.
 * @param tx - The open transaction.
 * @returns Whether a notification was written.
 * @throws {Error} When the database fails.
 */
async function notifyMember(
  userId: string,
  projectId: string,
  notification: { type: "comment.mentioned" | "comment.assignment_answered"; payload: Record<string, string> },
  mark: () => Promise<boolean>,
  tx: DbTx,
): Promise<boolean> {
  if ((await loadProjectRole(userId, projectId)) === null) return false;
  if (!(await mark())) return false;
  await notificationRepo.create({ userId, type: notification.type, payload: notification.payload, projectId }, tx);
  return true;
}

/**
 * Record the members one entry mentions, and notify each the first time.
 * Mentioning oneself notifies nobody; ids that are not uuids are skipped.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param mentions - What the entry mentions now.
 * @returns The users notified.
 * @throws {Error} When the database fails.
 */
export async function recordMentions(projectId: string, spaceId: string, mentions: readonly MentionRow[]): Promise<{ notified: string[] }> {
  const rows = mentions.filter((m) => UUID.test(m.userId) && UUID.test(m.authorId));
  return db.transaction(async (tx) => {
    const notified: string[] = [];
    for (const m of await mentionsRepo.insertMissing(projectId, spaceId, rows, tx)) {
      if (m.userId === m.authorId) continue;
      const payload = { projectId, spaceId, entryId: m.entryId, threadId: m.threadId, authorId: m.authorId };
      if (await notifyMember(m.userId, projectId, { type: "comment.mentioned", payload }, () => mentionsRepo.markNotified(m.id, tx), tx)) {
        notified.push(m.userId);
      }
    }
    return { notified };
  });
}

/**
 * Hand a thread to a connection: a new pending hand-over, whatever stood
 * before, unless its Space's delete voided it.
 * @param place - The thread.
 * @param given - Who handed it to which connection, and when.
 * @param given.connectionId - The connection.
 * @param given.assignedBy - Who handed it over.
 * @param given.assignedAt - When, epoch milliseconds.
 * @returns The connection it was live for before, when that was another one.
 * @throws {Error} When the database fails.
 */
export async function handOver(
  place: ThreadPlace,
  given: { connectionId: string; assignedBy: string; assignedAt: number },
): Promise<{ previousConnectionId: string | null }> {
  return db.transaction(async (tx) => {
    const before = await assignmentsRepo.lockForThread(place, tx);
    await assignmentsRepo.handOver(place, given, tx);
    const live = before !== undefined && before.voidReason === null;
    return { previousConnectionId: live && before.connectionId !== given.connectionId ? before.connectionId : null };
  });
}

/**
 * Take a hand-over back. Only the one who handed it over may.
 * @param place - The thread.
 * @param by - Who asks.
 * @returns The connection it was handed to, or why it was refused.
 * @throws {Error} When the database fails.
 */
export async function cancelHandOver(
  place: ThreadPlace,
  by: string,
): Promise<{ ok: true; connectionId: string } | { ok: false; reason: "not_found" | "forbidden" }> {
  return db.transaction(async (tx) => {
    const row = await assignmentsRepo.lockForThread(place, tx);
    if (row === undefined || row.voidReason !== null) return { ok: false, reason: "not_found" };
    if (row.assignedBy !== by) return { ok: false, reason: "forbidden" };
    await assignmentsRepo.cancel(row.id, tx);
    return { ok: true, connectionId: row.connectionId };
  });
}

/**
 * Answer a thread for the connection that replied: a pending hand-over to
 * it becomes answered, and the one who handed it over is told once per
 * hand-over while they can still open the project.
 * @param place - The thread.
 * @param connectionId - The connection that replied.
 * @returns Whether it answered a hand-over, and who was notified.
 * @throws {Error} When the database fails.
 */
export async function answerHandOver(place: ThreadPlace, connectionId: string): Promise<{ answered: boolean; notified: string[] }> {
  return db.transaction(async (tx) => {
    const row = await assignmentsRepo.lockForThread(place, tx);
    if (row === undefined || row.voidReason !== null || row.status !== "pending" || row.connectionId !== connectionId) {
      return { answered: false, notified: [] };
    }
    await assignmentsRepo.markAnswered(row.id, tx);
    if (row.notifiedAt !== null) return { answered: true, notified: [] };
    const payload = { projectId: place.projectId, spaceId: place.spaceId, threadId: place.threadId, connectionId };
    const told = await notifyMember(row.assignedBy, place.projectId, { type: "comment.assignment_answered", payload }, () => assignmentsRepo.markNotified(row.id, tx), tx);
    return { answered: true, notified: told ? [row.assignedBy] : [] };
  });
}

/**
 * Void a deleted Space's records.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction the delete runs in, when it has one.
 * @returns The pending hand-overs voided, and whether any hand-over was.
 * @throws {Error} When the database fails.
 */
export async function voidSpace(projectId: string, spaceId: string, tx?: DbTx): Promise<{ pending: HandedThread[]; changed: boolean }> {
  const run = async (t: DbTx): Promise<{ pending: HandedThread[]; changed: boolean }> => {
    await mentionsRepo.voidSpace(projectId, spaceId, t);
    const voided = await assignmentsRepo.voidSpace(projectId, spaceId, t);
    return { pending: voided.filter((r) => r.status === "pending").map(({ threadId, connectionId }) => ({ threadId, connectionId })), changed: voided.length > 0 };
  };
  return tx ? run(tx) : db.transaction(run);
}

/**
 * Bring back what a Space's delete voided, when it is restored.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction the restore runs in, when it has one.
 * @returns The pending hand-overs restored, and whether any hand-over was.
 * @throws {Error} When the database fails.
 */
export async function restoreSpace(projectId: string, spaceId: string, tx?: DbTx): Promise<{ pending: HandedThread[]; changed: boolean }> {
  const run = async (t: DbTx): Promise<{ pending: HandedThread[]; changed: boolean }> => {
    await mentionsRepo.restoreSpace(projectId, spaceId, t);
    const restored = await assignmentsRepo.restoreSpace(projectId, spaceId, t);
    return { pending: restored.filter((r) => r.status === "pending").map(({ threadId, connectionId }) => ({ threadId, connectionId })), changed: restored.length > 0 };
  };
  return tx ? run(tx) : db.transaction(run);
}
