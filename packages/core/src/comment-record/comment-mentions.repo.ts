// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `comment_mentions` (#1488 §11.6, §15.8): one row per comment entry and
 * member it mentions, inserted by collab when the browser asks it to record
 * an entry's mentions. Rows are only inserted; a deleted Space voids them and
 * its restore brings them back.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { type DbTx } from "@core/db/client.js";
import { commentMentions } from "@core/db/schema.js";

/** One mention as the document reads it. */
export interface MentionRow {
  entryId: string;
  threadId: string;
  userId: string;
  authorId: string;
  mentionedAt: number;
}

/** A mention row that was inserted for the first time. */
export interface InsertedMention extends MentionRow {
  id: string;
}

/**
 * Insert the rows not recorded yet.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param rows - What the entry mentions now.
 * @param tx - The open transaction.
 * @returns The rows inserted by this call.
 * @throws {Error} When the database write fails.
 */
export async function insertMissing(projectId: string, spaceId: string, rows: readonly MentionRow[], tx: DbTx): Promise<InsertedMention[]> {
  const inserted: InsertedMention[] = [];
  for (const row of rows) {
    const [made] = await tx
      .insert(commentMentions)
      .values({ projectId, spaceId, ...row, mentionedAt: new Date(row.mentionedAt) })
      .onConflictDoNothing()
      .returning({ id: commentMentions.id });
    if (made) inserted.push({ id: made.id, ...row });
  }
  return inserted;
}

/**
 * Record that a mention's notification was sent, once.
 * @param id - The row.
 * @param tx - The open transaction.
 * @returns True when this call recorded it, false when it was recorded already.
 * @throws {Error} When the database write fails.
 */
export async function markNotified(id: string, tx: DbTx): Promise<boolean> {
  const done = await tx
    .update(commentMentions)
    .set({ notifiedAt: sql`now()` })
    .where(and(eq(commentMentions.id, id), isNull(commentMentions.notifiedAt)))
    .returning({ id: commentMentions.id });
  return done.length > 0;
}

/**
 * Void every live row of a deleted Space.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction.
 * @throws {Error} When the database write fails.
 */
export async function voidSpace(projectId: string, spaceId: string, tx: DbTx): Promise<void> {
  await tx
    .update(commentMentions)
    .set({ deletedAt: sql`now()`, voidReason: "space_deleted", updatedAt: sql`now()` })
    .where(and(eq(commentMentions.projectId, projectId), eq(commentMentions.spaceId, spaceId), isNull(commentMentions.deletedAt)));
}

/**
 * Bring back the rows its delete voided when a Space is restored.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction.
 * @throws {Error} When the database write fails.
 */
export async function restoreSpace(projectId: string, spaceId: string, tx: DbTx): Promise<void> {
  await tx
    .update(commentMentions)
    .set({ deletedAt: null, voidReason: null, updatedAt: sql`now()` })
    .where(and(eq(commentMentions.projectId, projectId), eq(commentMentions.spaceId, spaceId), eq(commentMentions.voidReason, "space_deleted")));
}
