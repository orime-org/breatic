// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `comment_assignments` (#1488 §11.7): one row per thread handed to an
 * external agent, synced by collab from a Space document after each store.
 * The MCP service and the hand-giver's thread labels read it.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { commentAssignments } from "@core/db/schema.js";

/** Where a hand-over stands. */
export type AssignmentStatus = "pending" | "answered" | "resolved";

/** One hand-over as a Space document holds it. */
export interface AssignmentRow {
  threadId: string;
  connectionId: string;
  assignedBy: string;
  assignedAt: number;
  status: AssignmentStatus;
}

/** A hand-over its agent answered in this sync, not yet notified. */
export interface AnsweredAssignment extends AssignmentRow {
  id: string;
}

/** What one sync changed. */
export interface AssignmentSync {
  /** Whether any row was inserted, changed, restored or voided. */
  changed: boolean;
  /** The rows that became answered and whose giver was not told yet. */
  answered: AnsweredAssignment[];
}

/**
 * Make one Space's rows what its document reads now. A hand-over given again
 * (a new `assignedAt`) clears `notified_at`, so each hand-over notifies once.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param rows - What the document reads.
 * @param tx - The open transaction.
 * @returns Whether anything changed, and the rows that became answered.
 * @throws {Error} When the database write fails.
 */
export async function syncSpace(projectId: string, spaceId: string, rows: readonly AssignmentRow[], tx: DbTx): Promise<AssignmentSync> {
  const existing = await tx
    .select()
    .from(commentAssignments)
    .where(and(eq(commentAssignments.projectId, projectId), eq(commentAssignments.spaceId, spaceId)))
    .for("update");
  const byThread = new Map(existing.map((r) => [r.threadId, r]));
  const read = new Set(rows.map((r) => r.threadId));
  let changed = false;
  const answered: AnsweredAssignment[] = [];
  for (const row of rows) {
    const found = byThread.get(row.threadId);
    if (found === undefined) {
      const [made] = await tx
        .insert(commentAssignments)
        .values({ projectId, spaceId, ...row })
        .onConflictDoNothing()
        .returning({ id: commentAssignments.id });
      if (!made) continue;
      changed = true;
      if (row.status === "answered") answered.push({ id: made.id, ...row });
      continue;
    }
    const regiven = found.assignedAt !== row.assignedAt || found.connectionId !== row.connectionId;
    const same = !regiven && found.deletedAt === null && found.status === row.status && found.assignedBy === row.assignedBy;
    if (same) continue;
    await tx
      .update(commentAssignments)
      .set({ ...row, deletedAt: null, ...(regiven ? { notifiedAt: null } : {}), updatedAt: sql`now()` })
      .where(eq(commentAssignments.id, found.id));
    changed = true;
    const notified = regiven ? null : found.notifiedAt;
    if (row.status === "answered" && notified === null && (regiven || found.status !== "answered")) answered.push({ id: found.id, ...row });
  }
  for (const r of existing) {
    if (r.deletedAt !== null || read.has(r.threadId)) continue;
    await tx.update(commentAssignments).set({ deletedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(commentAssignments.id, r.id));
    changed = true;
  }
  return { changed, answered };
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
 * Void every row of a deleted Space.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction, when there is one.
 * @returns Whether any row was voided.
 * @throws {Error} When the database write fails.
 */
export async function voidSpace(projectId: string, spaceId: string, tx?: DbTx): Promise<boolean> {
  const voided = await (tx ?? db)
    .update(commentAssignments)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(commentAssignments.projectId, projectId), eq(commentAssignments.spaceId, spaceId), isNull(commentAssignments.deletedAt)))
    .returning({ id: commentAssignments.id });
  return voided.length > 0;
}
