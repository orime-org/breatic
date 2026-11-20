// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `comment_assignments` (#1488 §11.7, §15.10): one row per thread handed to
 * an external agent, written by collab while it handles a hand-over request,
 * a cancel request or the agent's reply, and voided or restored with its
 * Space. The MCP service and the hand-giver's thread labels read it.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { commentAssignments } from "@core/db/schema.js";

/** Where a hand-over stands. */
export type AssignmentStatus = "pending" | "answered";

/** One thread's hand-over, as the record holds it. */
export interface AssignmentRecord {
  id: string;
  threadId: string;
  connectionId: string;
  assignedBy: string;
  assignedAt: number;
  status: AssignmentStatus;
  notifiedAt: Date | null;
  voidReason: "cancelled" | "space_deleted" | null;
}

/** Which thread, in which Space. */
export interface ThreadPlace {
  projectId: string;
  spaceId: string;
  threadId: string;
}

/**
 * One thread's row, locked for the rest of the transaction.
 * @param place - The thread.
 * @param tx - The open transaction.
 * @returns The row, voided or not, or undefined when there is none.
 * @throws {Error} When the database read fails.
 */
export async function lockForThread(place: ThreadPlace, tx: DbTx): Promise<AssignmentRecord | undefined> {
  const [row] = await tx
    .select({
      id: commentAssignments.id,
      threadId: commentAssignments.threadId,
      connectionId: commentAssignments.connectionId,
      assignedBy: commentAssignments.assignedBy,
      assignedAt: commentAssignments.assignedAt,
      status: commentAssignments.status,
      notifiedAt: commentAssignments.notifiedAt,
      voidReason: commentAssignments.voidReason,
    })
    .from(commentAssignments)
    .where(and(
      eq(commentAssignments.projectId, place.projectId),
      eq(commentAssignments.spaceId, place.spaceId),
      eq(commentAssignments.threadId, place.threadId),
    ))
    .for("update");
  return row;
}

/**
 * Hand a thread over: insert its row, or make the existing one this
 * hand-over, pending, live and not yet notified.
 * @param place - The thread.
 * @param given - Who handed it to which connection, and when.
 * @param given.connectionId - The connection.
 * @param given.assignedBy - Who handed it over.
 * @param given.assignedAt - When, epoch milliseconds.
 * @param tx - The open transaction.
 * @throws {Error} When the database write fails.
 */
export async function handOver(
  place: ThreadPlace,
  given: { connectionId: string; assignedBy: string; assignedAt: number },
  tx: DbTx,
): Promise<void> {
  await tx
    .insert(commentAssignments)
    .values({ ...place, ...given, status: "pending" })
    .onConflictDoUpdate({
      target: [commentAssignments.projectId, commentAssignments.spaceId, commentAssignments.threadId],
      set: { ...given, status: "pending", notifiedAt: null, voidReason: null, deletedAt: null, updatedAt: sql`now()` },
    });
}

/**
 * Void a hand-over its giver took back.
 * @param id - The row.
 * @param tx - The open transaction.
 * @throws {Error} When the database write fails.
 */
export async function cancel(id: string, tx: DbTx): Promise<void> {
  await tx
    .update(commentAssignments)
    .set({ deletedAt: sql`now()`, voidReason: "cancelled", updatedAt: sql`now()` })
    .where(eq(commentAssignments.id, id));
}

/**
 * Mark a pending hand-over answered.
 * @param id - The row.
 * @param tx - The open transaction.
 * @throws {Error} When the database write fails.
 */
export async function markAnswered(id: string, tx: DbTx): Promise<void> {
  await tx.update(commentAssignments).set({ status: "answered", updatedAt: sql`now()` }).where(eq(commentAssignments.id, id));
}

/**
 * Record that a hand-over's answered notification was sent, once.
 * @param id - The row.
 * @param tx - The open transaction.
 * @returns True when this call recorded it, false when it was recorded already.
 * @throws {Error} When the database write fails.
 */
export async function markNotified(id: string, tx: DbTx): Promise<boolean> {
  const done = await tx
    .update(commentAssignments)
    .set({ notifiedAt: sql`now()` })
    .where(and(eq(commentAssignments.id, id), isNull(commentAssignments.notifiedAt)))
    .returning({ id: commentAssignments.id });
  return done.length > 0;
}

/**
 * Void every live row of a deleted Space.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction.
 * @returns The rows voided.
 * @throws {Error} When the database write fails.
 */
export async function voidSpace(
  projectId: string,
  spaceId: string,
  tx: DbTx,
): Promise<Array<{ threadId: string; connectionId: string; status: AssignmentStatus }>> {
  return tx
    .update(commentAssignments)
    .set({ deletedAt: sql`now()`, voidReason: "space_deleted", updatedAt: sql`now()` })
    .where(and(eq(commentAssignments.projectId, projectId), eq(commentAssignments.spaceId, spaceId), isNull(commentAssignments.deletedAt)))
    .returning({ threadId: commentAssignments.threadId, connectionId: commentAssignments.connectionId, status: commentAssignments.status });
}

/**
 * Bring back the rows its delete voided when a Space is restored.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction.
 * @returns The rows restored.
 * @throws {Error} When the database write fails.
 */
export async function restoreSpace(
  projectId: string,
  spaceId: string,
  tx: DbTx,
): Promise<Array<{ threadId: string; connectionId: string; status: AssignmentStatus }>> {
  return tx
    .update(commentAssignments)
    .set({ deletedAt: null, voidReason: null, updatedAt: sql`now()` })
    .where(and(eq(commentAssignments.projectId, projectId), eq(commentAssignments.spaceId, spaceId), eq(commentAssignments.voidReason, "space_deleted")))
    .returning({ threadId: commentAssignments.threadId, connectionId: commentAssignments.connectionId, status: commentAssignments.status });
}

/**
 * The live pending hand-overs one person gave one agent connection, oldest first.
 * @param connectionId - The agent connection.
 * @param assignedBy - Its owner.
 * @returns Where each thread is and when it was handed over.
 * @throws {Error} When the database read fails.
 */
export async function listPendingForConnection(
  connectionId: string,
  assignedBy: string,
): Promise<Array<{ projectId: string; spaceId: string; threadId: string; assignedAt: number }>> {
  return db
    .select({ projectId: commentAssignments.projectId, spaceId: commentAssignments.spaceId, threadId: commentAssignments.threadId, assignedAt: commentAssignments.assignedAt })
    .from(commentAssignments)
    .where(and(
      eq(commentAssignments.connectionId, connectionId),
      eq(commentAssignments.assignedBy, assignedBy),
      eq(commentAssignments.status, "pending"),
      isNull(commentAssignments.deletedAt),
    ))
    .orderBy(asc(commentAssignments.assignedAt));
}

/**
 * The live pending hand-overs in one Space, whoever gave them.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns Each thread and the connection it waits for.
 * @throws {Error} When the database read fails.
 */
export async function listPendingInSpace(projectId: string, spaceId: string): Promise<Array<{ threadId: string; connectionId: string }>> {
  return db
    .select({ threadId: commentAssignments.threadId, connectionId: commentAssignments.connectionId })
    .from(commentAssignments)
    .where(and(
      eq(commentAssignments.projectId, projectId),
      eq(commentAssignments.spaceId, spaceId),
      eq(commentAssignments.status, "pending"),
      isNull(commentAssignments.deletedAt),
    ));
}

/**
 * The live hand-overs one person gave in one Space.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param assignedBy - Who handed them over.
 * @returns Each thread, the connection it went to, when, and where it stands.
 * @throws {Error} When the database read fails.
 */
export async function listForSpace(
  projectId: string,
  spaceId: string,
  assignedBy: string,
): Promise<Array<{ threadId: string; connectionId: string; assignedAt: number; status: AssignmentStatus }>> {
  return db
    .select({ threadId: commentAssignments.threadId, connectionId: commentAssignments.connectionId, assignedAt: commentAssignments.assignedAt, status: commentAssignments.status })
    .from(commentAssignments)
    .where(and(
      eq(commentAssignments.projectId, projectId),
      eq(commentAssignments.spaceId, spaceId),
      eq(commentAssignments.assignedBy, assignedBy),
      isNull(commentAssignments.deletedAt),
    ));
}
