/**
 * Memory repository — three-layer memory system with optimistic locking.
 *
 * Layers:
 * 1. Conversation memory (per-conversation, no versioning)
 * 2. User memory (cross-project preferences, versioned)
 * 3. Project memory (shared among collaborators, versioned)
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import {
  conversationMemories,
  memoryHistoryEntries,
  userMemories,
  userMemoryEntries,
  projectMemories,
  projectMemoryEntries,
} from "@breatic/core";
import { ConflictError } from "@breatic/core";

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
 */
export async function upsertConversationMemory(
  conversationId: string,
  content: string,
): Promise<void> {
  await db
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
 */
export async function appendHistory(conversationId: string, entry: string): Promise<void> {
  await db.insert(memoryHistoryEntries).values({ conversationId, entry });
}

// ── User Memory (Optimistic Locking) ─────────────────────────────────

/**
 * Get user memory content.
 * @param userId - ID of the user whose cross-project memory is fetched.
 * @returns The stored memory content, or an empty string if none exists.
 */
export async function getUserMemory(userId: string): Promise<string> {
  const rows = await db
    .select({ content: userMemories.content })
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .limit(1);
  return rows[0]?.content ?? "";
}

/**
 * Get user memory version for optimistic locking.
 * @param userId - ID of the user whose memory version is fetched.
 * @returns The current version number, or 0 if no memory row exists yet.
 */
export async function getUserMemoryVersion(userId: string): Promise<number> {
  const rows = await db
    .select({ version: userMemories.version })
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .limit(1);
  return rows[0]?.version ?? 0;
}

/**
 * Upsert user memory with optimistic locking.
 * @param userId - ID of the user whose memory is written.
 * @param content - New memory content to store.
 * @param expectedVersion - Version the caller read; 0 inserts a fresh row, otherwise the update only succeeds if it still matches.
 * @throws {ConflictError} If the version doesn't match (concurrent update)
 */
export async function upsertUserMemory(
  userId: string,
  content: string,
  expectedVersion: number,
): Promise<void> {
  if (expectedVersion === 0) {
    // Insert new
    await db.insert(userMemories).values({ userId, content, version: 1 });
    return;
  }

  // Update with version check
  const result = await db.execute(
    sql`UPDATE user_memories
        SET content = ${content}, version = version + 1, updated_at = NOW()
        WHERE user_id = ${userId} AND version = ${expectedVersion}
        RETURNING id`,
  );

  if ((result as unknown[]).length === 0) {
    throw new ConflictError("User memory version conflict — concurrent update detected");
  }
}

/**
 * Append a user memory entry (audit log).
 * @param userId - ID of the user the entry belongs to.
 * @param content - Memory text captured for this entry.
 * @param sourceConversationId - Optional ID of the conversation that produced the entry.
 */
export async function appendUserEntry(
  userId: string,
  content: string,
  sourceConversationId?: string,
): Promise<void> {
  await db.insert(userMemoryEntries).values({
    userId,
    content,
    sourceConversationId,
  });
}

// ── Project Memory (Optimistic Locking) ──────────────────────────────

/**
 * Get project memory content.
 * @param projectId - ID of the project whose shared memory is fetched.
 * @returns The stored memory content, or an empty string if none exists.
 */
export async function getProjectMemory(projectId: string): Promise<string> {
  const rows = await db
    .select({ content: projectMemories.content })
    .from(projectMemories)
    .where(eq(projectMemories.projectId, projectId))
    .limit(1);
  return rows[0]?.content ?? "";
}

/**
 * Get project memory version for optimistic locking.
 * @param projectId - ID of the project whose memory version is fetched.
 * @returns The current version number, or 0 if no memory row exists yet.
 */
export async function getProjectMemoryVersion(projectId: string): Promise<number> {
  const rows = await db
    .select({ version: projectMemories.version })
    .from(projectMemories)
    .where(eq(projectMemories.projectId, projectId))
    .limit(1);
  return rows[0]?.version ?? 0;
}

/**
 * Upsert project memory with optimistic locking.
 * @param projectId - ID of the project whose memory is written.
 * @param content - New memory content to store.
 * @param expectedVersion - Version the caller read; 0 inserts a fresh row, otherwise the update only succeeds if it still matches.
 * @throws {ConflictError} If the version doesn't match (concurrent update)
 */
export async function upsertProjectMemory(
  projectId: string,
  content: string,
  expectedVersion: number,
): Promise<void> {
  if (expectedVersion === 0) {
    await db.insert(projectMemories).values({ projectId, content, version: 1 });
    return;
  }

  const result = await db.execute(
    sql`UPDATE project_memories
        SET content = ${content}, version = version + 1, updated_at = NOW()
        WHERE project_id = ${projectId} AND version = ${expectedVersion}
        RETURNING id`,
  );

  if ((result as unknown[]).length === 0) {
    throw new ConflictError("Project memory version conflict — concurrent update detected");
  }
}

/**
 * Append a project memory entry (audit log).
 * @param projectId - ID of the project the entry belongs to.
 * @param authorId - ID of the collaborator who authored the entry.
 * @param content - Memory text captured for this entry.
 * @param sourceConversationId - Optional ID of the conversation that produced the entry.
 */
export async function appendProjectEntry(
  projectId: string,
  authorId: string,
  content: string,
  sourceConversationId?: string,
): Promise<void> {
  await db.insert(projectMemoryEntries).values({
    projectId,
    authorId,
    content,
    sourceConversationId,
  });
}
