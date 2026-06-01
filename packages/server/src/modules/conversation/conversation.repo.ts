/**
 * Conversation repository — data access for conversations table.
 *
 * Messages are stored inline as a JSONB array (not a separate table).
 * Supports consolidation-aware message slicing for the memory system.
 *
 * Every read/write filters on `deleted_at IS NULL` — soft-deleted
 * conversations are invisible to the rest of the app. Cascade deletion
 * of owned children lives in {@link cascadeDeleteConversations}.
 */

import { and, eq, desc, isNull, inArray, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import {
  conversations,
  conversationAttachments,
  conversationMemories,
  memoryHistoryEntries,
} from "@breatic/core";
import { NotFoundError } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { ConversationEntity, MessageData } from "@breatic/shared";

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

const MAX_HISTORY = 50;

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
 * @returns The newly created conversation entity
 */
export async function createConversation(
  userId: string,
  title = "New conversation",
): Promise<ConversationEntity> {
  const rows = await db
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
 */
export async function setProjectId(id: string, projectId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ projectId, updatedAt: new Date() })
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)));
}

/**
 * Append a message to the JSONB messages array.
 *
 * Automatically computes turnIndex:
 * - role="user" → previous turnIndex + 1 (new turn)
 * - role="assistant" or "tool" → same turnIndex as current turn
 *
 * Returns the `turnIndex` assigned to the message — callers billing by
 * turn (deductOnce with `turn:${conversationId}:${turnIndex}` refKey)
 * need this stable number, and computing it again via a second DB roundtrip
 * would race against concurrent appends.
 *
 * Uses PostgreSQL `||` operator for atomic JSONB append.
 * @param id - Conversation UUID to append to
 * @param message - Message to append; `turnIndex` is computed when omitted
 * @returns The `turnIndex` assigned to the appended message
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 *   This surfaces deletion-mid-stream cleanly to callers — `main-agent.ts`
 *   relies on this to abort billing when the conversation was deleted
 *   during a chat turn.
 */
export async function addMessage(
  id: string,
  message: Omit<MessageData, "turnIndex"> & { turnIndex?: number },
): Promise<number> {
  let turnIndex: number;

  if (message.turnIndex !== undefined) {
    turnIndex = message.turnIndex;
  } else {
    // SELECT with soft-delete guard so we both compute the next turn
    // AND detect "conversation gone" in a single roundtrip. The filter
    // matters when a user-owned conversation is soft-deleted mid-stream
    // — without it we would bill a turn on an invisible conversation.
    const rows = await db
      .select({ messages: conversations.messages })
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundError(`Conversation not found or deleted: ${id}`);
    }
    const msgs = (rows[0].messages ?? []) as MessageData[];
    const currentTurn =
      msgs.length > 0 ? msgs[msgs.length - 1]!.turnIndex ?? 0 : 0;
    turnIndex = message.role === "user" ? currentTurn + 1 : currentTurn;
  }

  const fullMessage: MessageData = { ...message, turnIndex };

  // RETURNING id + length check detects a conversation that vanished
  // between the SELECT above and the UPDATE, or was soft-deleted when
  // the caller supplied `message.turnIndex` directly (skipping the SELECT).
  const result = await db.execute(
    sql`UPDATE conversations
        SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([fullMessage])}::jsonb,
            updated_at = NOW()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING id`,
  );

  if ((result as unknown[]).length === 0) {
    throw new NotFoundError(`Conversation not found or deleted: ${id}`);
  }

  return turnIndex;
}

/**
 * Get the last N messages from a conversation (empty array if deleted).
 * @param id - Conversation UUID to read
 * @param limit - Maximum number of trailing messages to return (defaults to 50)
 * @returns The last `limit` messages, or an empty array if not found / deleted
 */
export async function getMessages(id: string, limit = MAX_HISTORY): Promise<MessageData[]> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);

  const msgs = (rows[0]?.messages ?? []) as MessageData[];
  return msgs.slice(-limit);
}

/**
 * Get messages formatted for LLM context.
 *
 * Skips already-consolidated turns and strips internal fields
 * (ts, turnIndex, thinking) that the LLM doesn't need.
 * @param id - Conversation ID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 * @returns Unconsolidated messages with internal-only fields stripped for the LLM
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
): Promise<MessageData[]> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);

  const all = (rows[0]?.messages ?? []) as MessageData[];

  // Only include messages from turns after the consolidated boundary
  const unconsolidated = all.filter((m) => m.turnIndex > lastConsolidatedTurn);

  // Strip internal fields not needed by LLM
  return unconsolidated.map(({ ts: _ts, turnIndex: _ti, thinking: _th, ...rest }) => rest as MessageData);
}

/**
 * Get count of unconsolidated turns.
 * @param id - Conversation UUID to inspect
 * @returns Number of turns past the last consolidated boundary (0 if not found)
 */
export async function getUnconsolidatedTurnCount(id: string): Promise<number> {
  const rows = await db
    .select({
      messages: conversations.messages,
      lastConsolidatedTurn: conversations.lastConsolidatedTurn,
    })
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);

  if (!rows[0]) return 0;
  const msgs = (rows[0].messages ?? []) as MessageData[];
  const maxTurn = msgs.length > 0 ? msgs[msgs.length - 1]!.turnIndex : 0;
  return maxTurn - rows[0].lastConsolidatedTurn;
}

/**
 * Get messages eligible for consolidation (by turn range).
 *
 * Returns all messages from turns after lastConsolidatedTurn up to
 * (maxTurn - keepTurns). The full step detail is preserved for
 * high-quality LLM summarization.
 * @param id - Conversation ID
 * @param lastConsolidatedTurn - Turn index already consolidated
 * @param keepTurns - Number of recent turns to keep unconsolidated
 * @returns Messages in the consolidatable turn range (empty when nothing is eligible)
 */
export async function getMessagesForConsolidation(
  id: string,
  lastConsolidatedTurn: number,
  keepTurns: number,
): Promise<MessageData[]> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);

  const all = (rows[0]?.messages ?? []) as MessageData[];
  if (all.length === 0) return [];

  const maxTurn = all[all.length - 1]!.turnIndex;
  const consolidateUpToTurn = maxTurn - keepTurns;
  if (consolidateUpToTurn <= lastConsolidatedTurn) return [];

  return all.filter(
    (m) => m.turnIndex > lastConsolidatedTurn && m.turnIndex <= consolidateUpToTurn,
  );
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
