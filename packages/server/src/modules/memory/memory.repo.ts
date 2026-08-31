// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory repository — two layers, both the reader's own.
 *
 * Layers:
 * 1. Conversation memory (per-conversation, no versioning)
 * 2. Project memory (per member per project, versioned)
 *
 * The project layer is keyed by both columns everywhere it is touched. Two of
 * the three places are invisible to the compiler — a `where` clause is one
 * `eq` short without complaint, and the update is raw SQL — so a member id
 * that reaches only some of them silently reads and writes a neighbour's row.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import {
  conversationMemories,
  memoryHistoryEntries,
  projectMemories,
  projectMemoryEntries,
} from "@breatic/core";
import { ConflictError } from "@breatic/core";
import { t } from "@breatic/shared";

// ── Conversation Memory ──────────────────────────────────────────────

/**
 * Get conversation memory content.
 * @param conversationId - ID of the conversation whose memory is fetched.
 * @returns The stored memory content, or an empty string if none exists.
 */
export async function getConversationMemory(conversationId: string): Promise<string> {
  const rows = await db
    .select({ content: conversationMemories.content })
    .from(conversationMemories)
    .where(eq(conversationMemories.conversationId, conversationId))
    .limit(1);
  return rows[0]?.content ?? "";
}

/**
 * Upsert conversation memory (no versioning).
 * @param conversationId - ID of the conversation to write memory for.
 * @param content - New memory content to store, replacing any existing value.
 * @param tx - The transaction to run inside, when the caller has one.
 */
export async function upsertConversationMemory(
  conversationId: string,
  content: string,
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db)
    .insert(conversationMemories)
    .values({ conversationId, content })
    .onConflictDoUpdate({
      target: conversationMemories.conversationId,
      set: { content, updatedAt: new Date() },
    });
}

/**
 * Append a consolidation history entry.
 * @param conversationId - ID of the conversation the history entry belongs to.
 * @param entry - Serialized history record describing a consolidation event.
 * @param tx - The transaction to run inside, when the caller has one.
 */
export async function appendHistory(
  conversationId: string,
  entry: string,
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db).insert(memoryHistoryEntries).values({ conversationId, entry });
}

// ── Project Memory (Optimistic Locking) ──────────────────────────────

/**
 * Get one member's project memory.
 * @param userId - Whose memory to read.
 * @param projectId - Which project it belongs to.
 * @returns The stored memory content, or an empty string if none exists.
 */
export async function getProjectMemory(
  userId: string,
  projectId: string,
): Promise<string> {
  const rows = await db
    .select({ content: projectMemories.content })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.userId, userId),
        eq(projectMemories.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0]?.content ?? "";
}

/**
 * Get one member's project memory version for optimistic locking.
 * @param userId - Whose memory to read.
 * @param projectId - Which project it belongs to.
 * @param tx - The transaction to read inside, when the caller has one.
 * @returns The current version number, or 0 if no memory row exists yet.
 */
export async function getProjectMemoryVersion(
  userId: string,
  projectId: string,
  tx?: DbTx,
): Promise<number> {
  const rows = await (tx ?? db)
    .select({ version: projectMemories.version })
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.userId, userId),
        eq(projectMemories.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0]?.version ?? 0;
}

/**
 * Upsert one member's project memory with optimistic locking.
 * @param userId - Whose memory is written.
 * @param projectId - Which project it belongs to.
 * @param content - New memory content to store.
 * @param expectedVersion - Version the caller read; 0 inserts a fresh row, otherwise the update only succeeds if it still matches.
 * @param tx - The transaction to run inside, when the caller has one.
 * @throws {ConflictError} If the version doesn't match (concurrent update)
 */
export async function upsertProjectMemory(
  userId: string,
  projectId: string,
  content: string,
  expectedVersion: number,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  if (expectedVersion === 0) {
    // A first write and an update take the same path: two requests that both
    // read version 0 would otherwise have the second break the unique index,
    // and it runs inside the consolidation transaction.
    await handle
      .insert(projectMemories)
      .values({ userId, projectId, content, version: 1 })
      .onConflictDoUpdate({
        target: [projectMemories.userId, projectMemories.projectId],
        set: { content, version: sql`${projectMemories.version} + 1`, updatedAt: new Date() },
      });
    return;
  }

  const result = await handle.execute(
    sql`UPDATE project_memories
        SET content = ${content}, version = version + 1, updated_at = NOW()
        WHERE user_id = ${userId} AND project_id = ${projectId} AND version = ${expectedVersion}
        RETURNING id`,
  );

  if ((result as unknown[]).length === 0) {
    throw new ConflictError(t("server.memory.version_conflict"));
  }
}

/**
 * Append a project memory entry (audit log).
 * @param projectId - ID of the project the entry belongs to.
 * @param authorId - ID of the collaborator who authored the entry.
 * @param content - Memory text captured for this entry.
 * @param sourceConversationId - Optional ID of the conversation that produced the entry.
 * @param tx - The transaction to run inside, when the caller has one.
 */
export async function appendProjectEntry(
  projectId: string,
  authorId: string,
  content: string,
  sourceConversationId?: string,
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db).insert(projectMemoryEntries).values({
    projectId,
    authorId,
    content,
    sourceConversationId,
  });
}
