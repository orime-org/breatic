// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Conversation repository — data access for the conversations table.
 *
 * Messages live in their own table; see conversation-message.repo.ts.
 *
 * Every read/write filters on `deleted_at IS NULL` — soft-deleted
 * conversations are invisible to the rest of the app. Cascade deletion
 * of owned children lives in {@link cascadeDeleteConversations}.
 */

import { and, eq, desc, isNull, inArray } from "drizzle-orm";
import { db } from "@breatic/core";
import {
  conversations,
  conversationAttachments,
  conversationMemories,
  memoryHistoryEntries,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { cascadeDeleteMessages } from "@server/modules/conversation/conversation-message.repo.js";
import type { ConversationEntity } from "@breatic/shared";

/**
 * Transaction handle type, inferred from {@link db.transaction}'s callback.
 *
 * Used by {@link cascadeDeleteConversations} so the helper can be reused
 * across different transactions (single-conversation soft delete vs.
 * project-scoped cascade) without the helper owning its own transaction.
 */
// Re-exported so the 5 server repos/services that compose a caller-
// provided `tx` keep importing DbTx from here (it now lives in core).
export type { DbTx };

/**
 * Convert a Drizzle row to a ConversationEntity.
 * @param row - Raw `conversations` table row from a Drizzle select
 * @returns The mapped domain entity (keeps `$inferSelect` out of callers)
 */
function toEntity(row: typeof conversations.$inferSelect): ConversationEntity {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    projectId: row.projectId,
    lastConsolidatedTurn: row.lastConsolidatedTurn,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Create a new conversation.
 * @param userId - Owner of the new conversation (conversations are user-scoped)
 * @param title - Display title; truncated to 200 chars before insert
 * @param tx - Optional transaction handle, so a caller can create the
 *   conversation and claim the current-conversation pointer as one unit
 * @returns The newly created conversation entity
 */
export async function createConversation(
  userId: string,
  title = "New conversation",
  tx?: DbTx,
): Promise<ConversationEntity> {
  const rows = await (tx ?? db)
    .insert(conversations)
    .values({ userId, title: title.slice(0, 200) })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Get a conversation by ID (excludes soft-deleted).
 * @param id - Conversation UUID to look up
 * @returns The conversation entity, or null if not found or soft-deleted
 */
export async function getConversation(id: string): Promise<ConversationEntity | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * List active (non-deleted) conversations for a user, optionally
 * scoped to a single project.
 * @param userId - Conversations are user-owned; this is the auth boundary.
 * @param opts - Optional project scope and pagination window
 * @param opts.projectId - When set, restricts to conversations belonging
 *   to that project. ChatPanel passes the active space's project id so
 *   it doesn't have to client-side-filter a paginated response (which
 *   silently dropped the target when it sat past page boundary).
 * @param opts.limit - Maximum rows to return (defaults to 50)
 * @param opts.offset - Number of rows to skip for pagination (defaults to 0)
 * @returns Active conversations ordered by most-recently-updated first
 */
export async function listConversations(
  userId: string,
  opts: { projectId?: string; limit?: number; offset?: number } = {},
): Promise<ConversationEntity[]> {
  const { projectId, limit = 50, offset = 0 } = opts;
  const conditions = [eq(conversations.userId, userId), isNull(conversations.deletedAt)];
  if (projectId !== undefined) {
    conditions.push(eq(conversations.projectId, projectId));
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map(toEntity);
}

/**
 * Cascade soft-delete: mark N conversations and their owned children as
 * deleted inside the caller-provided transaction.
 *
 * Owned children (FK `onDelete: restrict`) that are cascaded:
 *   - `conversation_messages`
 *   - `conversation_attachments`
 *   - `conversation_memories`
 *   - `memory_history_entries`
 *
 * Reference-only children (FK `onDelete: set null`) are deliberately
 * NOT touched — the row does not belong to the conversation:
 *   - `user_memory_entries.source_conversation_id` belongs to the user
 *   - `project_memory_entries.source_conversation_id` belongs to the project
 * Both keep their link as a historical breadcrumb; list queries that
 * join `conversations WHERE deleted_at IS NULL` filter deleted sources
 * naturally.
 *
 * Every UPDATE is guarded with `isNull(deletedAt)` so re-running the
 * cascade is idempotent and never overwrites an existing timestamp.
 *
 * Must be called inside a transaction — the caller owns the atomicity
 * boundary so `deleteProject` can wrap both conversation and non-
 * conversation children in one transaction.
 * @param tx - Transaction handle from {@link db.transaction}
 * @param convIds - Conversation UUIDs to cascade (safe with 0 entries)
 * @param now - Timestamp to stamp on every affected row (defaults to `new Date()`)
 */
export async function cascadeDeleteConversations(
  tx: DbTx,
  convIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (convIds.length === 0) return;

  const ids = [...convIds];

  await cascadeDeleteMessages(tx, ids, now);

  await tx
    .update(conversationAttachments)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(conversationAttachments.conversationId, ids),
        isNull(conversationAttachments.deletedAt),
      ),
    );

  await tx
    .update(conversationMemories)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(conversationMemories.conversationId, ids),
        isNull(conversationMemories.deletedAt),
      ),
    );

  await tx
    .update(memoryHistoryEntries)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(memoryHistoryEntries.conversationId, ids),
        isNull(memoryHistoryEntries.deletedAt),
      ),
    );

  await tx
    .update(conversations)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        inArray(conversations.id, ids),
        isNull(conversations.deletedAt),
      ),
    );
}

/**
 * Soft-delete a conversation and its owned children atomically.
 *
 * Wraps {@link cascadeDeleteConversations} in a single-statement
 * transaction. Safe to call on an already-deleted conversation (no-op).
 * @param id - Conversation UUID to soft-delete
 */
export async function softDeleteConversation(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await cascadeDeleteConversations(tx, [id]);
  });
}

/**
 * Update conversation title. No-op when the conversation is soft-deleted
 * — filtering on `isNull(deletedAt)` means concurrent deletion wins.
 * @param id - Conversation UUID to rename
 * @param title - New display title; truncated to 200 chars before update
 */
export async function updateTitle(id: string, title: string): Promise<void> {
  await db
    .update(conversations)
    .set({ title: title.slice(0, 200), updatedAt: new Date() })
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)));
}

/**
 * Set the project_id on a conversation. No-op if soft-deleted.
 * @param id - Conversation UUID to link
 * @param projectId - Project UUID to associate the conversation with
 * @param tx - Optional transaction handle; see {@link createConversation}
 */
export async function setProjectId(
  id: string,
  projectId: string,
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db)
    .update(conversations)
    .set({ projectId, updatedAt: new Date() })
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)));
}

/**
 * Update the consolidated turn index. No-op if soft-deleted.
 * @param id - Conversation UUID to update
 * @param turn - New `last_consolidated_turn` watermark to persist
 */
export async function updateConsolidatedTurn(id: string, turn: number): Promise<void> {
  await db
    .update(conversations)
    .set({ lastConsolidatedTurn: turn, updatedAt: new Date() })
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)));
}
