// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Conversation message repository — one row per message.
 *
 * Storage keeps a message as a list of {@link MessagePart}s (prose, reasoning,
 * tool calls); the rest of the app works with the flat {@link MessageData}
 * shape. The mapping between the two lives here and nowhere else, so a caller
 * never has to know which form it is holding.
 *
 * Every read filters `deleted_at IS NULL` on both the message and its
 * conversation — a soft-deleted conversation takes its messages with it, and
 * the FK is RESTRICT, so that cascade is this layer's job rather than the
 * database's.
 */

import { and, asc, desc, eq, inArray, isNull, lte, gt, max } from "drizzle-orm";
import { db, conversations, conversationMessages, NotFoundError } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { MessageData, MessageInput, MessagePart, ToolCallInfo } from "@breatic/shared";

const MAX_HISTORY = 50;

/** A stored row, as far as the mapping functions care. */
type StoredRow = {
  role: string;
  turnIndex: number;
  parts: MessagePart[];
  createdAt: Date;
};

/**
 * Split a caller's flat message into the pieces that get stored.
 *
 * Reasoning comes before prose because it precedes the prose it produced;
 * tool calls come last, in the order the model emitted them.
 * @param input - The message as the caller handed it in
 * @returns The parts to store, in display order
 */
function toParts(input: MessageInput): MessagePart[] {
  if (input.role === "tool") {
    return [
      {
        type: "tool-result",
        toolCallId: input.tool_call_id ?? "",
        toolName: input.name ?? "",
        output: input.content,
      },
    ];
  }

  const parts: MessagePart[] = [];
  if (input.thinking) {
    parts.push({ type: "reasoning", text: input.thinking });
  }
  if (input.content) {
    parts.push({ type: "text", text: input.content });
  }
  for (const call of input.tool_calls ?? []) {
    parts.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
      ...(call.result !== undefined ? { output: call.result } : {}),
    });
  }
  return parts;
}

/**
 * Reassemble a stored row into the flat shape callers expect.
 * @param row - The stored row
 * @returns The message, with `ts` rendered from the row's creation time
 */
function toMessageData(row: StoredRow): MessageData {
  const parts = row.parts ?? [];
  const base = {
    role: row.role as MessageData["role"],
    ts: row.createdAt.toISOString(),
    turnIndex: row.turnIndex,
  };

  const toolResult = parts.find((p) => p.type === "tool-result");
  if (toolResult && toolResult.type === "tool-result") {
    return {
      ...base,
      content: toolResult.output,
      tool_call_id: toolResult.toolCallId,
      name: toolResult.toolName,
    };
  }

  const text = parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  const reasoning = parts.find(
    (p): p is Extract<MessagePart, { type: "reasoning" }> => p.type === "reasoning",
  );
  const calls: ToolCallInfo[] = parts
    .filter((p): p is Extract<MessagePart, { type: "tool-call" }> => p.type === "tool-call")
    .map((p) => ({
      id: p.toolCallId,
      name: p.toolName,
      arguments: p.input,
      ...(p.output !== undefined ? { result: p.output } : {}),
    }));

  return {
    ...base,
    content: text,
    ...(reasoning ? { thinking: reasoning.text } : {}),
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

/**
 * Append a message to a conversation.
 *
 * Turn numbering runs inside one transaction that holds a lock on the
 * conversation row for its whole length. Reading the current turn and writing
 * the next one used to be two separately-committed statements, so two
 * concurrent user messages could read the same value, compute the same turn
 * index and collide on the billing idempotency key
 * `turn:${conversationId}:${turnIndex}` — one of the two turns then billed
 * nothing. The lock is taken on the conversation row rather than on an
 * aggregate over the messages, because a locking clause cannot be combined
 * with an aggregate at all.
 * @param id - Conversation UUID to append to
 * @param message - The message; `ts` and `turnIndex` are assigned here
 * @returns The turn index assigned to this message — callers billing by turn
 *   need this exact number and recomputing it later would race
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 *   `main-agent.ts` relies on this to abort billing when the conversation was
 *   deleted mid-turn.
 */
export async function addMessage(id: string, message: MessageInput): Promise<number> {
  return db.transaction(async (tx) => {
    const owner = await tx
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .for("update")
      .limit(1);

    if (!owner[0]) {
      throw new NotFoundError(`Conversation not found or deleted: ${id}`);
    }

    // Deliberately NOT filtered on `deleted_at`: the turn index is a
    // monotonic counter that doubles as a billing key, so it must never step
    // back onto a number a cascade-deleted message already used.
    const turnRows = await tx
      .select({ maxTurn: max(conversationMessages.turnIndex) })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id));

    const currentTurn = turnRows[0]?.maxTurn ?? 0;
    const turnIndex = message.role === "user" ? currentTurn + 1 : currentTurn;

    const seqRows = await tx
      .select({ maxSeq: max(conversationMessages.seq) })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, id),
          eq(conversationMessages.turnIndex, turnIndex),
        ),
      );
    const seq = seqRows[0]?.maxSeq == null ? 0 : seqRows[0].maxSeq + 1;

    await tx.insert(conversationMessages).values({
      conversationId: id,
      userId: owner[0].userId,
      role: message.role,
      turnIndex,
      seq,
      parts: toParts(message),
    });

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, id));

    return turnIndex;
  });
}

/**
 * Get the last N messages of a conversation.
 * @param id - Conversation UUID to read
 * @param limit - Maximum number of trailing messages (defaults to 50)
 * @returns The trailing messages in display order, empty when the
 *   conversation is missing or soft-deleted
 */
export async function getMessages(id: string, limit = MAX_HISTORY): Promise<MessageData[]> {
  const rows = await db
    .select({
      role: conversationMessages.role,
      turnIndex: conversationMessages.turnIndex,
      parts: conversationMessages.parts,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        isNull(conversationMessages.deletedAt),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(conversationMessages.turnIndex), desc(conversationMessages.seq))
    .limit(limit);

  return rows.reverse().map(toMessageData);
}

/**
 * Get messages formatted for LLM context.
 *
 * Skips already-consolidated turns and strips the fields the model has no use
 * for (creation time, turn index, the model's own reasoning).
 * @param id - Conversation UUID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 * @returns Unconsolidated messages with internal-only fields removed
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
): Promise<MessageData[]> {
  const rows = await db
    .select({
      role: conversationMessages.role,
      turnIndex: conversationMessages.turnIndex,
      parts: conversationMessages.parts,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        gt(conversationMessages.turnIndex, lastConsolidatedTurn),
        isNull(conversationMessages.deletedAt),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(asc(conversationMessages.turnIndex), asc(conversationMessages.seq));

  return rows.map((row) => {
    const { ts: _ts, turnIndex: _ti, thinking: _th, ...rest } = toMessageData(row);
    return rest as MessageData;
  });
}

/**
 * Count the turns past the consolidation watermark.
 * @param id - Conversation UUID to inspect
 * @returns Turns not yet folded into memory, 0 when the conversation is gone
 */
export async function getUnconsolidatedTurnCount(id: string): Promise<number> {
  const convRows = await db
    .select({ lastConsolidatedTurn: conversations.lastConsolidatedTurn })
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .limit(1);

  if (!convRows[0]) return 0;

  const turnRows = await db
    .select({ maxTurn: max(conversationMessages.turnIndex) })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        isNull(conversationMessages.deletedAt),
      ),
    );

  return (turnRows[0]?.maxTurn ?? 0) - convRows[0].lastConsolidatedTurn;
}

/**
 * Get the messages eligible for consolidation.
 *
 * The window runs from the turn after the watermark up to `keepTurns` short of
 * the newest turn, so recent context stays out of the summary. Full step
 * detail is preserved — the summariser reads it.
 * @param id - Conversation UUID
 * @param lastConsolidatedTurn - Turn index already consolidated
 * @param keepTurns - How many recent turns to hold back
 * @returns Messages inside the window, empty when nothing is eligible yet
 */
export async function getMessagesForConsolidation(
  id: string,
  lastConsolidatedTurn: number,
  keepTurns: number,
): Promise<MessageData[]> {
  const turnRows = await db
    .select({ maxTurn: max(conversationMessages.turnIndex) })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        isNull(conversationMessages.deletedAt),
      ),
    );

  const maxTurn = turnRows[0]?.maxTurn;
  if (maxTurn == null) return [];

  const consolidateUpToTurn = maxTurn - keepTurns;
  if (consolidateUpToTurn <= lastConsolidatedTurn) return [];

  const rows = await db
    .select({
      role: conversationMessages.role,
      turnIndex: conversationMessages.turnIndex,
      parts: conversationMessages.parts,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        gt(conversationMessages.turnIndex, lastConsolidatedTurn),
        lte(conversationMessages.turnIndex, consolidateUpToTurn),
        isNull(conversationMessages.deletedAt),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(asc(conversationMessages.turnIndex), asc(conversationMessages.seq));

  return rows.map(toMessageData);
}

/**
 * Soft-delete every message of the given conversations.
 *
 * The FK is RESTRICT, so Postgres will not cascade — without this the
 * messages of a deleted conversation stay readable. Guarded on
 * `deleted_at IS NULL` so re-running never overwrites an existing timestamp.
 * @param tx - Transaction handle; the caller owns the atomicity boundary
 * @param convIds - Conversation UUIDs whose messages to stamp (safe when empty)
 * @param now - Timestamp to stamp on every affected row
 */
export async function cascadeDeleteMessages(
  tx: DbTx,
  convIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (convIds.length === 0) return;

  await tx
    .update(conversationMessages)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(conversationMessages.conversationId, [...convIds]),
        isNull(conversationMessages.deletedAt),
      ),
    );
}
