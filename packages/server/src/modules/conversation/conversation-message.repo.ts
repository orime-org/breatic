// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

import { and, asc, desc, eq, inArray, isNull, lt, lte, gt, gte, max, sql, type SQL } from "drizzle-orm";
import {
  accountActivityRepo,
  db,
  conversations,
  conversationMessages,
  ConflictError,
  getAgentConfig,
  NotFoundError,
  type ActivityCursor,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { ASK_USER, RECORD_TOOL_NAMES } from "@breatic/domain";
import { t } from "@breatic/shared";
import { asStorable } from "@server/utils/storable-text.js";
import type { MessageData, MessageInput, MessagePart } from "@breatic/shared";

/** Trusted HTTP identity accompanying a first accepted card answer. */
export interface AnswerActor {
  userId: string;
  projectId: string;
}

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

  // Beside the reasoning text it measures, and derived the same way: the row
  // keeps the pieces and the flat views are read out of them.
  const thoughtFor = parts.find(
    (p): p is Extract<MessagePart, { type: "thinking-time" }> => p.type === "thinking-time",
  )?.ms;

  return {
    id: row.id,
    role: row.role as MessageData["role"],
    ts: row.createdAt.toISOString(),
    turnIndex: row.turnIndex,
    parts,
    content: text,
    ...(reasoning ? { thinking: reasoning } : {}),
    ...(thoughtFor === undefined ? {} : { thinkingMs: thoughtFor }),
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
 * @param forModel - The reply as it was sent to the model, kept so later
 *   turns replay it as it is. Absent on a user message, whose copy
 *   `setUserForModel` writes once the turn has assembled its request, and on
 *   a reply whose turn never asked the model
 * @param rowId - The id to store it under: a reply keeps the one its stream
 *   was opened with, so the page that drew it reads it back under that id
 * @returns The turn index this message went into — callers billing by turn
 *   need this exact number and recomputing it later would race
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 *   `main-agent.ts` writes the user's own message through `addUserMessage`,
 *   which numbers it with the same locked insert, before a turn starts, so a
 *   conversation that is already gone fails the turn before any billing state
 *   exists. Here, the reply is written later in the turn, and this throw does
 *   not stop the billing: a failure there is recorded and the turn still settles, having
 *   already spent whatever its finished steps spent.
 */
export async function addMessage(id: string, message: MessageInput, forModel?: unknown, rowId?: string): Promise<number> {
  return db.transaction(async (tx) => insertIn(tx, id, message, forModel, rowId));
}

/**
 * Lock the conversation row and append one message, inside a transaction.
 *
 * The lock is what serialises everything that numbers a turn or settles a
 * waiting question in this conversation: two writers holding it in turn see
 * each other's work.
 * @param tx - The transaction.
 * @param id - Conversation UUID.
 * @param message - The message.
 * @param forModel - The reply as it was sent to the model.
 * @param rowId - The id to write the row under, when it has one of its own.
 * @returns The turn index the message went into.
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 */
async function insertIn(tx: DbTx, id: string, message: MessageInput, forModel?: unknown, rowId?: string): Promise<number> {
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
    ...(rowId === undefined ? {} : { id: rowId }),
    conversationId: id,
    userId: owner[0].userId,
    role: message.role,
    turnIndex,
    seq,
    parts: asStorable(message.parts),
    ...(forModel === undefined ? {} : { forModel: asStorable(forModel) }),
  });

  await tx
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, id));

  return turnIndex;
}

/** The result a question waiting for the user is settled with. */
export interface AskSettlement {
  /** The call's output as stored and drawn. */
  output: unknown;
  /** The tool result appended to the asking row's `for_model`, as sent to the model. */
  forModel: unknown;
}

/**
 * Settle one waiting question inside an asking row: the part takes its
 * output, and the result is appended to the row's copy of what was sent, so
 * the call and its result are always replayed from the same row.
 * @param tx - The transaction holding the conversation lock.
 * @param row - The asking row, read under that lock.
 * @param row.id - Its id.
 * @param row.parts - Its parts.
 * @param row.forModel - Its copy of what was sent, if any.
 * @param toolCallId - The waiting call.
 * @param settlement - What it is settled with.
 * @returns The row as it now stands.
 */
async function settleInRow(
  tx: DbTx,
  row: { id: string; parts: MessagePart[]; forModel: unknown },
  toolCallId: string,
  settlement: AskSettlement,
): Promise<{ id: string; parts: MessagePart[]; forModel: unknown }> {
  const parts = row.parts.map((part) =>
    part.type === "tool" && part.toolCallId === toolCallId ? { ...part, status: "success" as const, output: asStorable(settlement.output) } : part,
  );
  const kept = row.forModel as { messages?: unknown[] } | null;
  const forModel =
    kept && Array.isArray(kept.messages) ? { ...kept, messages: [...kept.messages, asStorable(settlement.forModel)] } : kept;
  await tx.update(conversationMessages).set({ parts, forModel }).where(eq(conversationMessages.id, row.id));
  return { id: row.id, parts, forModel };
}

/**
 * Append the user's message and, in the same transaction, settle every
 * question the agent is waiting on in this conversation.
 *
 * A message written instead of answering a card closes the card. Every
 * waiting call is closed, wherever its row sits: with two tabs open, a card
 * can be stored after a turn another tab started, and a call left without a
 * result makes every later request in the conversation fail.
 * @param id - Conversation UUID.
 * @param message - The user's message.
 * @param settle - The settlement for a waiting call, given its id and its
 *   tool's name, which the result the model reads is filed under.
 * @param opts - How the row is written.
 * @param opts.messageId - The id the page sent the message with (inner#1717):
 *   the row is written under it, and a row already written under it in this
 *   conversation is handed back as it is, so a run that opens again after a
 *   crash answers the row its predecessor wrote instead of writing another.
 * @returns The turn index the message opened, and the calls it closed.
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 * @throws {ConflictError} if the id names a row no new message can take
 *   (`refusesNewMessageId`).
 */
export async function addUserMessage(
  id: string,
  message: MessageInput,
  settle: (toolCallId: string, toolName: string) => AskSettlement,
  opts: { messageId?: string } = {},
): Promise<{ turnIndex: number; closedAsks: string[] }> {
  return db.transaction(async (tx) => {
    if (opts.messageId !== undefined) {
      const [held] = await tx
        .select({ conversationId: conversationMessages.conversationId, role: conversationMessages.role, turnIndex: conversationMessages.turnIndex })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, opts.messageId))
        .limit(1);
      if (held !== undefined) {
        if (refusesNewMessageId(held, id)) throw new ConflictError(t("server.error.conflict"));
        return { turnIndex: held.turnIndex, closedAsks: [] };
      }
    }
    const turnIndex = await insertIn(tx, id, message, undefined, opts.messageId);
    const asking = await tx
      .select({ id: conversationMessages.id, parts: conversationMessages.parts, forModel: conversationMessages.forModel })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, id),
          eq(conversationMessages.role, "assistant"),
          isNull(conversationMessages.deletedAt),
          sql`${conversationMessages.parts} @> ${JSON.stringify([{ status: "awaiting" }])}::jsonb`,
        ),
      )
      .orderBy(conversationMessages.turnIndex, conversationMessages.seq)
      .for("update");
    const closedAsks: string[] = [];
    for (const row of asking) {
      let current = row;
      for (const part of row.parts) {
        if (part.type !== "tool" || part.status !== "awaiting") continue;
        current = await settleInRow(tx, current, part.toolCallId, settle(part.toolCallId, part.toolName));
        closedAsks.push(part.toolCallId);
      }
    }
    return { turnIndex, closedAsks };
  });
}

/**
 * Which of the messages a dead run left taken a stored reply already
 * answered, and the turn of each that has a user row and no reply
 * (inner#1717). Answered is one the conversation's newest reply holds as a
 * message taken in mid-turn, or one whose user row's turn has a reply.
 * @param id - Conversation UUID.
 * @param ids - The taken messages' ids.
 * @returns The answered ids, and the unanswered ones' turns by id.
 */
export async function takenStatus(
  id: string,
  ids: readonly string[],
): Promise<{ answered: Set<string>; unansweredRows: Map<string, number> }> {
  const answered = new Set<string>();
  const unansweredRows = new Map<string, number>();
  if (ids.length === 0) return { answered, unansweredRows };
  const [newest] = await db
    .select({ parts: conversationMessages.parts })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, id), eq(conversationMessages.role, "assistant"), isNull(conversationMessages.deletedAt)))
    .orderBy(desc(conversationMessages.turnIndex), desc(conversationMessages.seq))
    .limit(1);
  const inNewest = new Set((newest?.parts ?? []).flatMap((p) => (p.type === "user-message" ? [p.id] : [])));
  const rows = await db.execute<{ id: string; turn_index: number; replied: boolean }>(sql`
    SELECT u.id, u.turn_index,
           EXISTS (
             SELECT 1 FROM conversation_messages r
             WHERE r.conversation_id = u.conversation_id AND r.turn_index = u.turn_index
               AND r.role = 'assistant' AND r.deleted_at IS NULL
           ) AS replied
    FROM conversation_messages u
    WHERE u.conversation_id = ${id} AND u.role = 'user' AND u.deleted_at IS NULL
      AND u.id = ANY(${textArray(ids)}::uuid[])
  `);
  for (const taken of ids) if (inNewest.has(taken)) answered.add(taken);
  for (const row of rows) {
    if (row.replied) answered.add(row.id);
    else if (!answered.has(row.id)) unansweredRows.set(row.id, row.turn_index);
  }
  return { answered, unansweredRows };
}

/** How an answer to a waiting question was taken. */
export type AnswerOutcome =
  | { kind: "answered"; turnIndex: number; output: unknown }
  | { kind: "settled"; status: string; output: unknown }
  | { kind: "mismatch"; reason: string }
  | { kind: "missing" };

/**
 * Settle a waiting question with the user's answer, once.
 *
 * Under the conversation lock: the question is settled only while it is still
 * waiting, so of two answers (or an answer and a message) the first to take
 * the lock is the one that counts, and every later one is told how the call
 * now stands.
 * @param id - Conversation UUID.
 * @param toolCallId - The call the answer is for.
 * @param check - Holds the answer to the call's stored input; a reason when
 *   it does not fit, otherwise the settlement.
 * @param actor - Trusted authenticated admission context for a user answer.
 * @returns How it went.
 * @throws {NotFoundError} if the conversation does not exist or is soft-deleted.
 */
export async function answerWaitingAsk(
  id: string,
  toolCallId: string,
  check: (input: unknown) => { reason: string } | AskSettlement,
  actor?: AnswerActor,
): Promise<AnswerOutcome> {
  return db.transaction(async (tx) => {
    const owner = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .for("update")
      .limit(1);
    if (!owner[0]) throw new NotFoundError(t("server.conversation.not_found"));
    const [row] = await tx
      .select({
        id: conversationMessages.id,
        turnIndex: conversationMessages.turnIndex,
        parts: conversationMessages.parts,
        forModel: conversationMessages.forModel,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, id),
          eq(conversationMessages.role, "assistant"),
          isNull(conversationMessages.deletedAt),
          sql`${conversationMessages.parts} @> ${JSON.stringify([{ toolCallId }])}::jsonb`,
        ),
      )
      .limit(1);
    const part = row?.parts.find((p) => p.type === "tool" && p.toolCallId === toolCallId);
    if (row === undefined || part?.type !== "tool") return { kind: "missing" };
    if (part.status !== "awaiting") return { kind: "settled", status: part.status, output: part.output };
    const checked = check(part.input);
    if ("reason" in checked) return { kind: "mismatch", reason: checked.reason };
    await settleInRow(tx, row, toolCallId, checked);
    if (actor) await accountActivityRepo.recordActivity({ ...actor, kind: "agent_started" }, tx);
    return { kind: "answered", turnIndex: row.turnIndex, output: checked.output };
  });
}

/**
 * Whether a row already written under an id keeps a new message of this
 * conversation from taking it: only the same message, a user row of this
 * conversation, may be written again under its own id.
 * @param held - The row under that id.
 * @param held.conversationId - Its conversation.
 * @param held.role - Its role.
 * @param conversationId - The conversation the new message is sent to.
 * @returns True when the id is not the new message's to take.
 */
function refusesNewMessageId(held: { conversationId: string; role: string }, conversationId: string): boolean {
  return held.conversationId !== conversationId || held.role !== "user";
}

/**
 * Whether a new message of a conversation cannot be written under this id.
 * @param conversationId - The conversation it is sent to.
 * @param messageId - The id it carries.
 * @returns True when a row of another conversation, or a row that is not a
 *   user message, already has that id.
 */
export async function messageIdRefused(conversationId: string, messageId: string): Promise<boolean> {
  const [held] = await db
    .select({ conversationId: conversationMessages.conversationId, role: conversationMessages.role })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, messageId))
    .limit(1);
  return held !== undefined && refusesNewMessageId(held, conversationId);
}

/**
 * The model the turn that made this call started on (#1363) and the upstream
 * that served it (inner#1743), as its reply records them.
 * @param id - Conversation UUID.
 * @param toolCallId - A call the reply made.
 * @returns Each that the reply records; neither when no reply holds the call.
 */
export async function getReplyRun(id: string, toolCallId: string): Promise<{ modelId?: string; servedUpstream?: string }> {
  const [row] = await db
    .select({ forModel: conversationMessages.forModel })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        eq(conversationMessages.role, "assistant"),
        isNull(conversationMessages.deletedAt),
        sql`${conversationMessages.parts} @> ${JSON.stringify([{ toolCallId }])}::jsonb`,
      ),
    )
    .limit(1);
  const kept = row?.forModel as { modelId?: unknown; servedUpstream?: unknown } | null | undefined;
  return {
    ...(typeof kept?.modelId === "string" ? { modelId: kept.modelId } : {}),
    ...(typeof kept?.servedUpstream === "string" ? { servedUpstream: kept.servedUpstream } : {}),
  };
}

/**
 * Keep what a turn's user message was sent to the model as.
 *
 * Written after the message itself: the message is stored first to number
 * the turn, and what it is sent as is known only once the turn has assembled
 * its request.
 * @param id - Conversation UUID
 * @param turnIndex - The turn the message opened
 * @param forModel - The message as it was sent
 */
export async function setUserForModel(id: string, turnIndex: number, forModel: unknown): Promise<void> {
  await db
    .update(conversationMessages)
    .set({ forModel: asStorable(forModel) })
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        eq(conversationMessages.turnIndex, turnIndex),
        eq(conversationMessages.role, "user"),
        isNull(conversationMessages.deletedAt),
      ),
    );
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
  // here, in which case dropping it would return nothing and the user could
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
 * -- what does or does not reach the model is decided by the replay
 * (`replayRows`), not here.
 *
 * It used to drop the creation time and the turn index as well, on the
 * grounds that the model is not shown them. But the model is not shown these
 * objects at all — the replay sends each row's kept copy, or renders the
 * fields it names — so withholding them here reached nobody, and it cost a cast that
 * told the compiler a message with no timestamp was a whole one.
 *
 * What it did reach is the fold, which prices the history one turn at a time
 * (`request-size.ts`, `costPerTurn`) and hands the consolidation the turns it
 * took.
 * Both key on this field, and a consolidation that cannot tell one turn from
 * another takes nothing at all.
 * @param id - Conversation UUID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 * @param beforeTurn - Stop short of this turn, leaving the running turn out
 * @returns Unconsolidated messages, without the flat mirror of the model's
 *   reasoning, each with what was sent of it (`forModel`, null when nothing
 *   was kept)
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
  beforeTurn?: number,
): Promise<Array<MessageData & { forModel: unknown }>> {
  const rows = await db
    .select({
      id: conversationMessages.id,
      role: conversationMessages.role,
      turnIndex: conversationMessages.turnIndex,
      parts: conversationMessages.parts,
      createdAt: conversationMessages.createdAt,
      forModel: conversationMessages.forModel,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(
      and(
        eq(conversationMessages.conversationId, id),
        gt(conversationMessages.turnIndex, lastConsolidatedTurn),
        // The turn being run is not history: its own message is put in front
        // of the model separately, and a copy here would be the model reading
        // the same question twice.
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
    return { ...rest, forModel: row.forModel };
  });
}

/** One message whose readable strings hold every search term (inner#1469). */
export interface MessageSearchRow {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  turnIndex: number;
  role: "user" | "assistant";
  /** ISO instant, UTC. */
  createdAt: string;
  /** `created_at` as text, at the precision the column stores, for a cursor. */
  cursorAt: string;
  /** The message's searchable words joined with spaces. */
  body: string;
}

/**
 * A search term as an `ILIKE` pattern that matches it anywhere, literally.
 * @param term - The term.
 * @returns The pattern, with `\`, `%` and `_` escaped.
 */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Text values as a Postgres `text[]`.
 * @param values - The values, each a bind parameter.
 * @returns The array expression.
 */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
}

/**
 * The strings a jsonpath finds in a value, joined with spaces; null when it finds none.
 * @param value - The jsonb value.
 * @param path - The jsonpath.
 * @returns The expression.
 */
function joinedStrings(value: SQL, path: string): SQL {
  return sql`(SELECT string_agg(v #>> '{}', ' ') FROM jsonb_path_query(${value}, ${path}::jsonpath, '{}', true) AS v)`;
}

/**
 * The words of one message part that a search matches: only words reading
 * the message back shows (`messageText` in domain). A text part's text cut
 * to a page, as reading cuts it, an
 * attachment's name, a questionnaire's questions with the options picked and
 * what was written on its Other line (an old single-question card's question
 * and its options), and the strings of any other tool's
 * input, cut as reading cuts them. An `ask_user` call whose status is
 * `error` drew no card and is matched like any other tool's call; one with
 * no status is still read as `ask_user`. A record tool's call, its result and every
 * other tool's result are not matched: the record tools' words are copies of
 * records found elsewhere, and the other results are catalogues and data the
 * user never said.
 * @param part - The part, as a jsonb expression.
 * @returns The expression; null for a part with nothing to match.
 */
function searchableWords(part: SQL): SQL {
  const { records_page_max_chars: textMax, records_tool_text_max_chars: toolTextMax } = getAgentConfig();
  return sql`CASE
    WHEN ${part}->>'type' = 'text' THEN left(${part}->>'text', ${textMax}::int)
    WHEN ${part}->>'type' = 'attachment' THEN ${part}#>>'{chip,name}'
    WHEN ${part}->>'type' <> 'tool' THEN NULL
    WHEN ${part}->>'toolName' = ${ASK_USER} AND ${part}->>'status' IS DISTINCT FROM 'error' THEN concat_ws(' ',
      ${joinedStrings(part, 'lax $.input.questions[*].question ? (@.type() == "string")')},
      ${joinedStrings(part, 'lax $.input.question ? (@.type() == "string")')},
      ${joinedStrings(part, 'lax $.input.options[*] ? (@.type() == "string")')},
      ${joinedStrings(part, 'lax $.output.answers[*].selected[*] ? (@.type() == "string")')},
      ${joinedStrings(part, 'lax $.output.answers[*].other ? (@.type() == "string")')})
    WHEN ${part}->>'toolName' = ANY(${textArray(RECORD_TOOL_NAMES)}) THEN NULL
    ELSE left(${joinedStrings(sql`${part}->'input'`, 'strict $.** ? (@.type() == "string")')}, ${toolTextMax}::int)
  END`;
}

/**
 * The searchable messages: each live message of the user's live
 * conversations in the project, as one row holding its searchable words in
 * part order. The turn now running is left out.
 * @param scope - Whose messages, and which to leave out.
 * @param scope.userId - The user.
 * @param scope.projectId - The project.
 * @param scope.currentConversationId - The conversation the turn runs in.
 * @param scope.turnIndex - The turn now running.
 * @param scope.conversationId - One conversation to keep to.
 * @returns The query, for a CTE.
 */
function searchable(scope: {
  userId: string;
  projectId: string;
  currentConversationId: string;
  turnIndex: number;
  conversationId?: string;
}): SQL {
  const where = sql`
    c.user_id = ${scope.userId} AND c.project_id = ${scope.projectId}
      AND c.deleted_at IS NULL AND m.deleted_at IS NULL
      AND NOT (m.conversation_id = ${scope.currentConversationId} AND m.turn_index >= ${scope.turnIndex})
      ${scope.conversationId === undefined ? sql`` : sql`AND m.conversation_id = ${scope.conversationId}`}`;
  // A message the user sent while a turn ran is kept inside the reply that
  // read it, and found as a message of its own: the user's, at the time they
  // sent it, under its own id, which is what the page's keyset orders by
  // (inner#1717). The reply's own words leave it out (`searchableWords`).
  return sql`
    SELECT m.id, m.conversation_id, m.turn_index, m.role::text AS role, m.created_at, c.title,
           coalesce((
             SELECT string_agg(w.words, ' ' ORDER BY w.ord)
             FROM (
               SELECT p.ord, ${searchableWords(sql`p.part`)} AS words
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts) = 'array' THEN m.parts END)
                    WITH ORDINALITY AS p(part, ord)
             ) w
           ), '') AS body
    FROM conversation_messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE ${where}
    UNION ALL
    SELECT (u.part->>'id')::uuid AS id, m.conversation_id, m.turn_index, 'user' AS role,
           (u.part->>'sentAt')::timestamptz AS created_at, c.title,
           coalesce((
             SELECT string_agg(w.words, ' ' ORDER BY w.ord)
             FROM (
               SELECT q.ord, ${searchableWords(sql`q.part`)} AS words
               FROM jsonb_array_elements(u.part->'parts') WITH ORDINALITY AS q(part, ord)
             ) w
           ), '') AS body
    FROM conversation_messages m
    JOIN conversations c ON c.id = m.conversation_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts) = 'array' THEN m.parts END) AS u(part)
    WHERE ${where} AND u.part->>'type' = 'user-message'
  `;
}

/**
 * One page of the user's messages that hold every term, newest first, with
 * how many there are in all (inner#1469).
 * @param scope - Whose messages, and which to leave out.
 * @param scope.userId - The user.
 * @param scope.projectId - The project.
 * @param scope.currentConversationId - The conversation the turn runs in.
 * @param scope.turnIndex - The turn now running, left out with every later one.
 * @param scope.conversationId - One conversation to keep to.
 * @param terms - The terms, each matched as a substring, ignoring case; at least one.
 * @param page - The page.
 * @param page.limit - How many hits it holds.
 * @param page.after - Where the previous page stopped.
 * @returns The hits, whether there are more, and the total; the total is 0
 *   when the page is empty, read past the last hit or not.
 */
export async function searchMessages(
  scope: { userId: string; projectId: string; currentConversationId: string; turnIndex: number; conversationId?: string },
  terms: readonly string[],
  page: { limit: number; after?: ActivityCursor },
): Promise<{ rows: MessageSearchRow[]; hasMore: boolean; total: number }> {
  const keyset =
    page.after === undefined
      ? sql``
      : sql`WHERE (created_at, id) < (${page.after.createdAt}::timestamptz, ${page.after.id}::uuid)`;
  const rows = await db.execute<{
    id: string;
    conversation_id: string;
    title: string | null;
    turn_index: number;
    role: "user" | "assistant";
    created_iso: string;
    cursor_at: string;
    body: string;
    total: number;
  }>(sql`
    WITH readable AS (${searchable(scope)}),
    hits AS (
      -- Counted before the keyset, so every page carries the whole total.
      SELECT *, count(*) OVER ()::int AS total
      FROM readable
      WHERE body ILIKE ALL (${textArray(terms.map(containsPattern))})
    )
    SELECT id, conversation_id, title, turn_index, role, body, total,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso,
           created_at::text AS cursor_at
    FROM hits
    ${keyset}
    ORDER BY created_at DESC, id DESC
    LIMIT ${page.limit + 1}
  `);
  const list = [...rows];
  return {
    rows: list.slice(0, page.limit).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      conversationTitle: r.title,
      turnIndex: r.turn_index,
      role: r.role,
      createdAt: r.created_iso,
      cursorAt: r.cursor_at,
      body: r.body,
    })),
    hasMore: list.length > page.limit,
    total: list[0]?.total ?? 0,
  };
}

/** A stored message as the record tools read it back. */
export interface TurnMessage {
  role: "user" | "assistant";
  turnIndex: number;
  /** ISO instant the message was written. */
  createdAt: string;
  parts: MessagePart[];
}

/**
 * The live messages of a live conversation over a range of turns, in turn and
 * position order, and the highest turn there is to read (inner#1469).
 * @param id - The conversation.
 * @param range - Which turns.
 * @param range.fromTurn - The first turn wanted.
 * @param range.toTurn - The last turn wanted.
 * @param range.beforeTurn - Leave out this turn and every later one.
 * @returns The messages, and the highest turn index readable at all; 0 when there is none.
 */
export async function getTurns(
  id: string,
  range: { fromTurn?: number; toTurn?: number; beforeTurn?: number },
): Promise<{ messages: TurnMessage[]; totalTurns: number }> {
  const live = [
    eq(conversationMessages.conversationId, id),
    isNull(conversationMessages.deletedAt),
    isNull(conversations.deletedAt),
    ...(range.beforeTurn === undefined ? [] : [lt(conversationMessages.turnIndex, range.beforeTurn)]),
  ];
  const [rows, highest] = await Promise.all([
    db
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
          ...live,
          ...(range.fromTurn === undefined ? [] : [gte(conversationMessages.turnIndex, range.fromTurn)]),
          ...(range.toTurn === undefined ? [] : [lte(conversationMessages.turnIndex, range.toTurn)]),
        ),
      )
      .orderBy(asc(conversationMessages.turnIndex), asc(conversationMessages.seq)),
    db
      .select({ turns: max(conversationMessages.turnIndex) })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(...live)),
  ]);
  return {
    messages: rows.map((r) => ({
      role: r.role as TurnMessage["role"],
      turnIndex: r.turnIndex,
      createdAt: r.createdAt.toISOString(),
      parts: r.parts ?? [],
    })),
    totalTurns: highest[0]?.turns ?? 0,
  };
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
