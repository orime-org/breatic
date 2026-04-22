/**
 * Conversation repository — data access for conversations table.
 *
 * Messages are stored inline as a JSONB array (not a separate table).
 * Supports consolidation-aware message slicing for the memory system.
 */

import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversations } from "../db/schema.js";
import type { ConversationEntity, MessageData } from "@breatic/shared";

/**
 * Compute the current turn index from the last message in the JSONB array.
 * Returns 0 when there are no messages yet.
 */
async function getCurrentTurnIndex(id: string): Promise<number> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);

  const msgs = (rows[0]?.messages ?? []) as MessageData[];
  if (msgs.length === 0) return 0;
  return msgs[msgs.length - 1]!.turnIndex ?? 0;
}

const MAX_HISTORY = 50;

/** Convert a Drizzle row to a ConversationEntity. */
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

/** Create a new conversation. */
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

/** Get a conversation by ID (excludes soft-deleted). */
export async function getConversation(id: string): Promise<ConversationEntity | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** List active (non-deleted) conversations for a user. */
export async function listConversations(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<ConversationEntity[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), isNull(conversations.deletedAt)))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map(toEntity);
}

/** Soft-delete a conversation — sets deleted_at, keeps record. */
export async function softDeleteConversation(id: string): Promise<void> {
  await db
    .update(conversations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

/** Update conversation title. */
export async function updateTitle(id: string, title: string): Promise<void> {
  await db
    .update(conversations)
    .set({ title: title.slice(0, 200), updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

/** Set the project_id on a conversation. */
export async function setProjectId(id: string, projectId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ projectId, updatedAt: new Date() })
    .where(eq(conversations.id, id));
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
 */
export async function addMessage(
  id: string,
  message: Omit<MessageData, "turnIndex"> & { turnIndex?: number },
): Promise<number> {
  let turnIndex: number;

  if (message.turnIndex !== undefined) {
    turnIndex = message.turnIndex;
  } else {
    const currentTurn = await getCurrentTurnIndex(id);
    turnIndex = message.role === "user" ? currentTurn + 1 : currentTurn;
  }

  const fullMessage: MessageData = { ...message, turnIndex };

  await db.execute(
    sql`UPDATE conversations
        SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([fullMessage])}::jsonb,
            updated_at = NOW()
        WHERE id = ${id}`,
  );

  return turnIndex;
}

/** Get the last N messages from a conversation. */
export async function getMessages(id: string, limit = MAX_HISTORY): Promise<MessageData[]> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);

  const msgs = (rows[0]?.messages ?? []) as MessageData[];
  return msgs.slice(-limit);
}

/**
 * Get messages formatted for LLM context.
 *
 * Skips already-consolidated turns and strips internal fields
 * (ts, turnIndex, thinking) that the LLM doesn't need.
 *
 * @param id - Conversation ID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
): Promise<MessageData[]> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);

  const all = (rows[0]?.messages ?? []) as MessageData[];

  // Only include messages from turns after the consolidated boundary
  const unconsolidated = all.filter((m) => m.turnIndex > lastConsolidatedTurn);

  // Strip internal fields not needed by LLM
  return unconsolidated.map(({ ts: _ts, turnIndex: _ti, thinking: _th, ...rest }) => rest as MessageData);
}

/** Get count of unconsolidated turns. */
export async function getUnconsolidatedTurnCount(id: string): Promise<number> {
  const rows = await db
    .select({
      messages: conversations.messages,
      lastConsolidatedTurn: conversations.lastConsolidatedTurn,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
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
 *
 * @param id - Conversation ID
 * @param lastConsolidatedTurn - Turn index already consolidated
 * @param keepTurns - Number of recent turns to keep unconsolidated
 */
export async function getMessagesForConsolidation(
  id: string,
  lastConsolidatedTurn: number,
  keepTurns: number,
): Promise<MessageData[]> {
  const rows = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(eq(conversations.id, id))
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

/** Update the consolidated turn index. */
export async function updateConsolidatedTurn(id: string, turn: number): Promise<void> {
  await db
    .update(conversations)
    .set({ lastConsolidatedTurn: turn, updatedAt: new Date() })
    .where(eq(conversations.id, id));
}
