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

import { and, eq } from "drizzle-orm";
import { db, currentConversations } from "@breatic/core";
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
 * Point this user's project at a conversation.
 *
 * One statement, so two concurrent switches leave one row rather than a
 * duplicate or a lost update. Which of two racing switches wins is genuinely
 * undefined — both are the user's own action, and there is no ordering
 * between them to preserve.
 * @param userId - Owner of the pointer
 * @param projectId - Project the pointer is scoped to
 * @param conversationId - Conversation to point at
 * @param tx - Optional transaction handle, so a caller that creates the
 *   conversation and points at it can do both atomically
 */
export async function setCurrentConversation(
  userId: string,
  projectId: string,
  conversationId: string,
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db)
    .insert(currentConversations)
    .values({ userId, projectId, conversationId })
    .onConflictDoUpdate({
      target: [currentConversations.userId, currentConversations.projectId],
      set: { conversationId },
    });
}
