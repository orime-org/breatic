// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Current-conversation pointer — which conversation a user is writing to in
 * a given project.
 *
 * The client never sends a conversation id: it posts content and the server
 * decides where the content lands. That decision needs somewhere to live, and
 * this is it — one row per (user, project), keyed by exactly those two.
 *
 * A pointer can outlive what it names: conversations are soft-deleted, and
 * nothing clears the row that points at one. Deciding whether the pointed-at
 * conversation is still alive belongs to the caller, which has to load the
 * conversation anyway and therefore learns it for free — judging it here as
 * well would put the same rule in two places, where neither is testable and
 * they can drift apart.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, conversations, currentConversations } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/**
 * Read the pointer.
 * @param userId - Owner of the pointer
 * @param projectId - Project the pointer is scoped to
 * @returns The conversation id it names, or null when this user has never
 *   written in this project. The conversation may since have been deleted —
 *   the caller finds that out when it loads it.
 */
export async function getCurrentConversationId(
  userId: string,
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({ conversationId: currentConversations.conversationId })
    .from(currentConversations)
    .where(
      and(
        eq(currentConversations.userId, userId),
        eq(currentConversations.projectId, projectId),
      ),
    )
    .limit(1);

  return rows[0]?.conversationId ?? null;
}

/**
 * Claim the pointer, unless it already names a conversation that is alive.
 *
 * The primary key (user_id, project_id) IS the lock, so whichever transaction
 * gets there first wins and the others are told they lost rather than
 * overwriting. That is what stops two simultaneous first messages from each
 * creating a conversation and leaving one stranded — the loser rolls back and
 * reads the winner instead.
 *
 * A pointer left naming a SOFT-DELETED conversation is not a competitor: it is
 * the state the user is stuck in after deleting the conversation they were in,
 * and claiming over it is exactly how they get unstuck. Hence the condition on
 * the update rather than a plain "do nothing on conflict".
 * @param userId - Owner of the pointer
 * @param projectId - Project the pointer is scoped to
 * @param conversationId - Conversation to point at
 * @param tx - Transaction handle; the caller creates the conversation and
 *   claims the pointer inside one transaction, so losing rolls back the
 *   conversation it just created along with the failed claim
 * @returns True when this caller now owns the pointer, false when a live
 *   conversation already held it
 */
export async function claimCurrentConversation(
  userId: string,
  projectId: string,
  conversationId: string,
  tx: DbTx,
): Promise<boolean> {
  const claimed = await tx
    .insert(currentConversations)
    .values({ userId, projectId, conversationId })
    .onConflictDoUpdate({
      target: [currentConversations.userId, currentConversations.projectId],
      set: { conversationId },
      setWhere: sql`EXISTS (
        SELECT 1 FROM ${conversations}
        WHERE ${conversations.id} = ${currentConversations.conversationId}
          AND ${conversations.deletedAt} IS NOT NULL
      )`,
    })
    .returning({ conversationId: currentConversations.conversationId });

  return claimed.length > 0;
}
