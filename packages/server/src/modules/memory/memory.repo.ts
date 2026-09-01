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
 * Write one member's project memory, inserting the row when it is their first.
 *
 * The last write wins, which is what this layer already means: a consolidation
 * replaces this member's project memory whole. `version` counts how many times
 * it has been rewritten.
 * @param userId - Whose memory is written.
 * @param projectId - Which project it belongs to.
 * @param content - New memory content to store.
 * @param tx - The transaction to run inside, when the caller has one.
 */
export async function upsertProjectMemory(
  userId: string,
  projectId: string,
  content: string,
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db)
    .insert(projectMemories)
    .values({ userId, projectId, content, version: 1 })
    .onConflictDoUpdate({
      target: [projectMemories.userId, projectMemories.projectId],
      set: { content, version: sql`${projectMemories.version} + 1`, updatedAt: new Date() },
    });
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
