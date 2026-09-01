// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Conversation repository — data access for the conversations table.
 *
 * Messages live in their own table; see conversation-message.repo.ts.
 *
 * Every read/write filters on `deleted_at IS NULL` — soft-deleted
 * conversations are invisible to the rest of the app. Cascade deletion
 * of owned children lives in {@link cascadeDeleteConversations}.
 */

import { and, or, eq, lt, desc, isNull, inArray, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import {
  conversations,
  conversationAttachments,
  conversationMemories,
  memoryHistoryEntries,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { cascadeDeleteMessages } from "@server/modules/conversation/conversation-message.repo.js";
import { CONVERSATION_TITLE_MAX_CHARS } from "@breatic/shared";
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
 * Create a new conversation, with no name yet.
 *
 * A name arrives later, from the first thing said in it or from its owner. It
 * is not given one here, because a placeholder stored in the column would be
 * indistinguishable from a title someone chose.
 * @param userId - Owner of the new conversation (conversations are user-scoped)
 * @param tx - Optional transaction handle, so opening chat can create the
 *   conversation and stamp its project as one unit under the locks it holds
 * @returns The newly created conversation entity
 */
export async function createConversation(
  userId: string,
  tx?: DbTx,
): Promise<ConversationEntity> {
  const rows = await (tx ?? db).insert(conversations).values({ userId }).returning();
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
 * One page of a user's conversations, and whether the list goes on past it.
 *
 * The flag travels with the rows rather than being worked out from their
 * count, because the count cannot tell a page that filled the window from one
 * that happened to be the last.
 */
export interface ConversationPage {
  conversations: ConversationEntity[];
  hasMore: boolean;
}

/**
 * The position a page of conversations continues from.
 *
 * A position rather than a count of rows to skip: this list is ordered by when
 * each conversation was last used, so it moves while a reader pages through
 * it. Counting rows then lands somewhere else than where the last page ended
 * -- a conversation comes back twice, or one is stepped over and cannot be
 * reached at all. Both columns are needed because both are in the order.
 */
export interface ConversationCursor {
  updatedAt: Date;
  id: string;
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
 * @param opts.limit - How many conversations this page holds
 * @param opts.after - Where the previous page stopped; omitted for the first
 * @returns The page, and whether the list goes on past it
 */
export async function listConversations(
  userId: string,
  opts: { projectId?: string; limit: number; after?: ConversationCursor },
): Promise<ConversationPage> {
  const { projectId, limit, after } = opts;
  const conditions = [eq(conversations.userId, userId), isNull(conversations.deletedAt)];
  if (projectId !== undefined) {
    conditions.push(eq(conversations.projectId, projectId));
  }
  if (after !== undefined) {
    // Everything ordered after the row the last page ended on. Written as two
    // comparisons because the order is over two columns: past that instant,
    // or at that instant but past that row. The second half is what stops a
    // batch of conversations sharing a timestamp -- which is what happens when
    // a project is seeded, or when two answers land in the same millisecond --
    // from either repeating for ever or being skipped as a block.
    conditions.push(
      or(
        lt(conversations.updatedAt, after.updatedAt),
        and(eq(conversations.updatedAt, after.updatedAt), lt(conversations.id, after.id)),
      )!,
    );
  }
  // One past the page, which is the only way to answer "is there more" without
  // a second query. A full page is not evidence of more and a short one is not
  // evidence of the end -- both are what a page exactly the size of the
  // remainder looks like.
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    // Two keys, and the second is not decoration: it is what makes the order
    // total. Ordering by the timestamp alone leaves rows that share one in
    // whatever order the database feels like, and a cursor into an order that
    // is not stable points at nothing in particular.
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit + 1);
  return {
    conversations: rows.slice(0, limit).map(toEntity),
    hasMore: rows.length > limit,
  };
}

/**
 * Take the right to create this user's first conversation in this project.
 *
 * Held until the surrounding transaction ends. Two tabs opening the same empty
 * project both ask "is there a conversation here?", both hear no, and both
 * create one — leaving the user looking at a list with two empty conversations
 * in it. This makes the ask-then-create pair one indivisible step per (user,
 * project); the second caller waits, then finds the first one's conversation.
 *
 * An advisory lock rather than a row lock, because at this moment there is no
 * row to lock — that is the whole problem. The two ids are hashed into the
 * lock's two integer halves; a collision between unrelated pairs costs a brief
 * wait and nothing else, since the lock guards a check that is repeated inside
 * it anyway.
 * @param tx - Transaction handle; the lock lives as long as it does
 * @param userId - Owner the lock is scoped to
 * @param projectId - Project the lock is scoped to
 */
export async function lockChatCreation(
  tx: DbTx,
  userId: string,
  projectId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${projectId}))`,
  );
}

/**
 * The conversation this user spoke in most recently in this project.
 *
 * The same order the list is in, and the same column: `updated_at` is set when
 * something is said and left alone by a rename, so it already means "last
 * spoken in, or created if never spoken in". Reading it two ways would let the
 * panel open on one conversation while the list puts another at the top -- the
 * same words on screen pointing at two different things.
 *
 * The id is the final ordering key so the answer never wobbles between two
 * conversations sharing a timestamp — without it, the same user refreshing
 * twice could land somewhere different each time.
 * @param userId - Owner whose conversations to consider
 * @param projectId - Project to look in
 * @param tx - Optional transaction handle, so the caller can read inside the
 *   same transaction that holds the creation lock
 * @returns The most recently used conversation, or null when there is none
 */
export async function findMostRecentlyUsed(
  userId: string,
  projectId: string,
  tx?: DbTx,
): Promise<ConversationEntity | null> {
  const rows = await (tx ?? db)
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.projectId, projectId),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(1);

  return rows[0] ? toEntity(rows[0]) : null;
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
 *   - `project_memory_entries.source_conversation_id` belongs to the member
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

  // Lock the parents FIRST. An append holds this same row FOR UPDATE while it
  // computes a turn index and inserts, and it touches a different table — so
  // without this, the delete stamps the messages that exist at that instant,
  // the append then inserts a live one, and the conversation ends up deleted
  // with a live message under it. Measured at 39 of 40 attempts, because the
  // delete's own parent UPDATE parks behind the append's lock and therefore
  // lands after it. Taking the lock up front makes the two serialise: the
  // append either finishes first and gets stamped with the rest, or finds the
  // conversation gone and refuses.
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.id, ids))
    .for("update");

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
 * Give a conversation a name, but only if it has none.
 *
 * One statement, because "does it have one?" and "give it one" asked
 * separately are two moments with room between them: a reader who names a new
 * conversation and then speaks in it sends two requests, and whichever order
 * the database commits them in, the answer must be the same -- the name they
 * chose. The condition is in the `WHERE`, so the write either happens against
 * a conversation that still has no name or does not happen at all.
 * @param id - Conversation UUID to name
 * @param title - The name to give it; cut to what the column stores
 * @returns The name it goes by now, or null when it is not there any more
 */
export async function nameIfUnnamed(id: string, title: string): Promise<string | null> {
  const cut = [...title].slice(0, CONVERSATION_TITLE_MAX_CHARS).join("");
  // `updated_at` set to itself for the same reason as in `updateTitle`:
  // naming a conversation is not using it.
  const [named] = await db
    .update(conversations)
    .set({ title: cut, updatedAt: sql`${conversations.updatedAt}` })
    .where(
      and(
        eq(conversations.id, id),
        isNull(conversations.deletedAt),
        isNull(conversations.title),
      ),
    )
    .returning({ title: conversations.title });
  if (named) return named.title;
  // Nothing was written, so either it has a name already or it is gone. One
  // more read tells the caller which, and what that name is.
  const held = await getConversation(id);
  return held?.title ?? null;
}

/**
 * Update conversation title. No-op when the conversation is soft-deleted
 * — filtering on `isNull(deletedAt)` means concurrent deletion wins.
 * @param id - Conversation UUID to rename
 * @param title - New display title; cut to what the column stores before update
 */
export async function updateTitle(id: string, title: string): Promise<void> {
  // Counted in characters, because that is what the column counts. `slice`
  // counts UTF-16 code units, and anything outside the basic plane takes two
  // of them -- so a name well inside the limit could still be cut, and the cut
  // landed between the halves of one character. What went into the column then
  // was a replacement mark, which the reader can only get rid of by renaming
  // the conversation themselves.
  const cut = [...title].slice(0, CONVERSATION_TITLE_MAX_CHARS).join("");
  // The title only. `updated_at` is what orders the list and what each row
  // shows as when the conversation was last used, and renaming one is not
  // using it: touching the column would send a conversation nobody has spoken
  // in for months to the top of the list, labelled "just now".
  //
  // Set to itself, and that is load-bearing. The column carries `$onUpdate`,
  // which drizzle applies to every update that does not name the column --
  // leaving it out of `set` is what makes it move, not what keeps it still.
  // Naming it is the only way to say "leave this one alone" in one round trip.
  await db
    .update(conversations)
    .set({
      title: cut,
      updatedAt: sql`${conversations.updatedAt}`,
    })
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
 * Move the consolidation watermark forward, and say whether it moved.
 *
 * The comparison is the concurrency control. Two tabs on one conversation
 * compute different windows — the later turn's history is longer, so its
 * boundary can sit further along — and the narrower one must not overwrite
 * memory that already covers more. Refusing to move backwards is what makes
 * "everything under the watermark is in memory" hold without a lock.
 *
 * `updated_at` is left where it is, and that is load-bearing. It orders the
 * list and decides which conversation an open lands on, and what it means
 * there is "last used" — consolidating memory is bookkeeping this reader
 * never asked for and cannot see. Touching it would lift a conversation they
 * have not opened in weeks to the top of their list.
 * @param id - Conversation UUID to update.
 * @param turn - The watermark to move to.
 * @param tx - The transaction to run inside, when the caller has one.
 * @returns True when this call moved it; false when it was already further along.
 */
export async function advanceConsolidatedTurn(
  id: string,
  turn: number,
  tx?: DbTx,
): Promise<boolean> {
  const moved = await (tx ?? db)
    .update(conversations)
    .set({ lastConsolidatedTurn: turn, updatedAt: sql`${conversations.updatedAt}` })
    .where(
      and(
        eq(conversations.id, id),
        isNull(conversations.deletedAt),
        lt(conversations.lastConsolidatedTurn, turn),
      ),
    )
    .returning({ id: conversations.id });
  return moved.length > 0;
}
