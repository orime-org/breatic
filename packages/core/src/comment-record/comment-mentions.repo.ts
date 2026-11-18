// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `comment_mentions` (#1488 §11.6): one row per comment entry and member it
 * mentions, synced by collab from a Space document after each store.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { commentMentions } from "@core/db/schema.js";

/** One mention as a Space document holds it. */
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
 * Make one Space's rows what its document reads now: rows read for the first
 * time are inserted, rows read again come back from void, and rows no longer
 * read are voided.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param rows - What the document reads.
 * @param tx - The open transaction.
 * @returns The rows inserted for the first time.
 * @throws {Error} When the database write fails.
 */
export async function syncSpace(projectId: string, spaceId: string, rows: readonly MentionRow[], tx: DbTx): Promise<InsertedMention[]> {
  const existing = await tx
    .select({ id: commentMentions.id, entryId: commentMentions.entryId, userId: commentMentions.userId, deletedAt: commentMentions.deletedAt })
    .from(commentMentions)
    .where(and(eq(commentMentions.projectId, projectId), eq(commentMentions.spaceId, spaceId)))
    .for("update");
  /**
   * One row's identity within the Space.
   * @param entryId - The comment entry.
   * @param userId - The member.
   * @returns The key.
   */
  const key = (entryId: string, userId: string): string => `${entryId}\u0000${userId}`;
  const byKey = new Map(existing.map((r) => [key(r.entryId, r.userId), r]));
  const read = new Set(rows.map((r) => key(r.entryId, r.userId)));
  const inserted: InsertedMention[] = [];
  for (const row of rows) {
    const found = byKey.get(key(row.entryId, row.userId));
    if (found === undefined) {
      // Another instance may insert the same row first; it notifies.
      const [made] = await tx
        .insert(commentMentions)
        .values({ projectId, spaceId, ...row, mentionedAt: new Date(row.mentionedAt) })
        .onConflictDoNothing()
        .returning({ id: commentMentions.id });
      if (made) inserted.push({ id: made.id, ...row });
    } else if (found.deletedAt !== null) {
      await tx
        .update(commentMentions)
        .set({ deletedAt: null, threadId: row.threadId, authorId: row.authorId, mentionedAt: new Date(row.mentionedAt), updatedAt: sql`now()` })
        .where(eq(commentMentions.id, found.id));
    }
  }
  const gone = existing.filter((r) => r.deletedAt === null && !read.has(key(r.entryId, r.userId)));
  for (const { id } of gone) {
    await tx.update(commentMentions).set({ deletedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(commentMentions.id, id));
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
 * Void every row of a deleted Space.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param tx - The open transaction, when there is one.
 * @throws {Error} When the database write fails.
 */
export async function voidSpace(projectId: string, spaceId: string, tx?: DbTx): Promise<void> {
  await (tx ?? db)
    .update(commentMentions)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(commentMentions.projectId, projectId), eq(commentMentions.spaceId, spaceId), isNull(commentMentions.deletedAt)));
}
