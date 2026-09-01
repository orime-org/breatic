// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Conversation message repository — one row per message.
 *
 * Storage keeps a message as a list of {@link MessagePart}s (prose, reasoning,
 * tool calls); the rest of the app works with the flat {@link MessageData}
 * shape. The mapping between the two lives here and nowhere else, so a caller
 * never has to know which form it is holding.
 *
 * Every query that RETURNS messages filters `deleted_at IS NULL` on both the
 * message and its conversation — a soft-deleted conversation takes its
 * messages with it, and the FK is RESTRICT, so that cascade is this layer's
 * job rather than the database's. One read is deliberately not filtered that
 * way -- the one inside `addMessage` that assigns the next turn index, so the
 * counter never steps back onto a number a deleted message already used; see
 * the comment on that query. The other reads of the highest turn index report
 * progress rather than hand out a number, and they do filter.
 */

import { and, asc, desc, eq, inArray, isNull, lt, gt, max } from "drizzle-orm";
import {
  db,
  conversations,
  conversationMessages,
  getAgentConfig,
  NotFoundError,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import type { MessageData, MessageInput, MessagePart } from "@breatic/shared";

/** A stored row, as far as the mapping functions care. */
type StoredRow = {
  id: string;
  role: string;
  turnIndex: number;
  parts: MessagePart[];
  createdAt: Date;
};

/**
 * Read a stored row back out.
 *
 * The parts come through as they were written — they are the message. The
 * flat fields beside them are derived here so that readers who only want the
 * prose do not each write their own join, and so that a reader who wants the
 * pieces is never handed a reassembly of them.
 * @param row - The stored row
 * @returns The message, with `ts` rendered from the row's creation time
 */
function toMessageData(row: StoredRow): MessageData {
  const parts = row.parts ?? [];

  const text = parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  const reasoning = parts
    .filter((p): p is Extract<MessagePart, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");

  return {
    id: row.id,
    role: row.role as MessageData["role"],
    ts: row.createdAt.toISOString(),
    turnIndex: row.turnIndex,
    parts,
    content: text,
    ...(reasoning ? { thinking: reasoning } : {}),
    ...(parts.some((p) => p.type === "interrupted") ? { interrupted: true as const } : {}),
    ...(parts.some((p) => p.type === "failed") ? { failed: true as const } : {}),
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
 * @param message - The message. A question opens a turn and is numbered here;
 *   a reply says which turn it answers, because nothing readable off the table
 *   can tell one turn's answer from a later turn's
 * @returns The turn index this message went into — callers billing by turn
 *   need this exact number and recomputing it later would race
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 *   `main-agent.ts` writes the user's own message through here before a turn
 *   starts, so a conversation that is already gone fails the turn before any
 *   billing state exists. Later in the turn this throw does not stop the
 *   billing: a failure there is recorded and the turn still settles, having
 *   already spent whatever its finished steps spent.
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
      throw new NotFoundError(t("server.conversation.not_found"));
    }

    let turnIndex: number;
    if (message.role === "assistant") {
      // A reply goes in the turn it answers, and only its caller knows which
      // that is. Taking the newest turn instead gives the same number exactly
      // while nothing else has happened since the question — and when
      // something has, which is what two open tabs or a reply slower than the
      // next question produce, the answer is filed under a question nobody
      // asked there and the one it answered reads as never answered.
      turnIndex = message.turnIndex;
    } else {
      // Deliberately NOT filtered on `deleted_at`: the turn index is a
      // monotonic counter that doubles as a billing key, so it must never step
      // back onto a number a cascade-deleted message already used.
      const turnRows = await tx
        .select({ maxTurn: max(conversationMessages.turnIndex) })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id));

      turnIndex = (turnRows[0]?.maxTurn ?? 0) + 1;
    }

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
      parts: message.parts,
    });

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, id));

    return turnIndex;
  });
}

/**
 * One page of a conversation, read from its newest end backwards.
 *
 * A page ends on a turn boundary, except when one turn is longer than a whole
 * page -- see where the boundary is trimmed for why that one has to be handed
 * over as it is. Cutting at a message count instead would put a turn's
 * question in one page and its answer in neither: the cursor for the next
 * page is a turn, so a turn half-read is a turn half-lost, and on screen that
 * is an answer with no question above it that no amount of loading earlier
 * brings back.
 */
export interface MessagePage {
  /** The messages, oldest first. */
  messages: MessageData[];
  /** There are older messages than these. */
  hasMore: boolean;
}

/**
 * Read one page of a conversation.
 * @param id - Conversation UUID to read
 * @param opts - Where to read from
 * @param opts.beforeTurn - Read the page ending just before this turn. Absent
 *   reads the newest page, which is what opening the conversation shows
 * @returns That page in display order, empty when the conversation is missing
 *   or soft-deleted
 */
export async function getMessages(
  id: string,
  opts: { beforeTurn?: number } = {},
): Promise<MessagePage> {
  // Read here rather than at module load: the config is not there yet when
  // this module is first imported.
  const pageSize = getAgentConfig().message_page_size;

  // One more than a page holds, which is how a page learns there is anything
  // behind it without a second query.
  const rows = await db
    .select({
      id: conversationMessages.id,
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
        ...(opts.beforeTurn === undefined
          ? []
          : [lt(conversationMessages.turnIndex, opts.beforeTurn)]),
      ),
    )
    .orderBy(desc(conversationMessages.turnIndex), desc(conversationMessages.seq))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;

  // Rows come newest first, so the last one is the oldest — and when there is
  // more behind it, it is the turn the limit cut through. Drop it whole and
  // it becomes the next page's job, complete. Unless it is the only turn
  // here, in which case dropping it would return nothing and the reader could
  // never get past it.
  const oldestTurn = rows.at(-1)?.turnIndex;
  const kept =
    hasMore && rows.some((r) => r.turnIndex !== oldestTurn)
      ? rows.filter((r) => r.turnIndex !== oldestTurn)
      : rows;

  return { messages: kept.reverse().map(toMessageData), hasMore };
}

/**
 * Get messages formatted for LLM context.
 *
 * Skips already-consolidated turns and drops the flat `thinking` field. That
 * field is a view read off the reasoning parts, and the parts themselves stay
 * -- what does or does not reach the model is decided one field at a time in
 * `toModelMessages`, not here.
 *
 * It used to drop the creation time and the turn index as well, on the
 * grounds that the model is not shown them. But the model is not shown these
 * objects at all — `toModelMessages` names the fields it sends, one at a
 * time — so withholding them here reached nobody, and it cost a cast that
 * told the compiler a message with no timestamp was a whole one.
 *
 * What it did reach is the budget, which prices the history one turn at a
 * time (`turn-budget.ts`, `costPerTurn`) and hands a fold the turns it took.
 * Both key on this field, and a consolidation that cannot tell one turn from
 * another takes nothing at all.
 * @param id - Conversation UUID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 * @param beforeTurn - Stop short of this turn, leaving the running turn out
 * @returns Unconsolidated messages, without the model's reasoning
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
  beforeTurn?: number,
): Promise<MessageData[]> {
  const rows = await db
    .select({
      id: conversationMessages.id,
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
        // The turn being run is not history: its own message is put in front
        // of the model separately, and a copy here would be the model reading
        // the same question twice -- and a candidate for compression, which
        // could shorten the very thing being asked.
        ...(beforeTurn === undefined
          ? []
          : [lt(conversationMessages.turnIndex, beforeTurn)]),
        isNull(conversationMessages.deletedAt),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(asc(conversationMessages.turnIndex), asc(conversationMessages.seq));

  return rows.map((row) => {
    const { thinking: _th, ...rest } = toMessageData(row);
    return rest;
  });
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
