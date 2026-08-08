// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Conversation service — business logic for conversations and messages.
 *
 * Enforces ownership checks at the service layer before delegating
 * to the conversation repository.
 */

import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import * as pointerRepo from "@server/modules/conversation/current-conversation.repo.js";
import * as projectService from "@server/modules/project/project.service.js";
import { t } from "@breatic/shared";
import { db, NotFoundError, ForbiddenError, ConflictError } from "@breatic/core";
import type { ConversationEntity, MessageData } from "@breatic/shared";

/**
 * How many times to retry resolving when another request wins the pointer.
 *
 * Each loss means someone else just created the conversation, so the next read
 * finds it. A second retry is only needed if that winner is deleted in the same
 * instant — bounded so a pathological caller cannot spin here forever.
 */
const CREATE_ATTEMPTS = 3;

/**
 * Thrown inside the create transaction when another request claimed the
 * pointer first. It exists to roll that transaction back — a transaction that
 * simply returns commits, so the conversation this caller just created would
 * survive as a twin of the winner's. Never escapes this module.
 */
class LostTheClaim extends Error {}

/**
 * Validate that a conversation exists and belongs to the given user.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @returns The validated conversation entity
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
async function validateOwnership(
  conversationId: string,
  userId: string,
): Promise<ConversationEntity> {
  const conv = await conversationRepo.getConversation(conversationId);
  if (!conv) throw new NotFoundError(t("server.error.not_found"));
  if (conv.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  return conv;
}

/**
 * Assert that the given user may access the given conversation.
 *
 * Shared entry point for REST route handlers that need to reject
 * cross-tenant reads (e.g. conversation attachment listings) before
 * doing any work. Discards the returned entity so call sites read
 * as an assertion rather than a fetch.
 * @param conversationId - Conversation UUID from untrusted client input
 * @param userId - Authenticated user UUID from the session
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if the user does not own the conversation
 */
export async function assertAccess(
  conversationId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(conversationId, userId);
}

/**
 * Resolve which conversation this user's next message belongs to.
 *
 * The client sends content, not a conversation id — so the server answers
 * "where does this land" from the current-conversation pointer, and creates a
 * conversation the first time there is nothing to point at. That keeps the
 * product flow honest: a user opens a project and starts typing, without
 * being asked to create a conversation first.
 *
 * A pointer naming a soft-deleted conversation counts as no pointer. Without
 * that, deleting the conversation you are in would make every following
 * message fail with no way to recover.
 * @param userId - Owner user UUID
 * @param projectId - Project the conversation belongs to
 * @param firstMessage - Used as the title when a conversation gets created
 * @returns The conversation this message belongs to
 * @throws {ForbiddenError} if the user may not write to the project
 */
export async function resolveCurrentConversation(
  userId: string,
  projectId: string,
  firstMessage: string,
): Promise<ConversationEntity> {
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    // `getConversation` filters soft-deleted rows, so a pointer naming a
    // deleted conversation reads as no pointer at all and falls through to
    // creating a new one. That is the whole recovery path: without it, deleting
    // the conversation you are in makes every following message fail forever.
    const currentId = await pointerRepo.getCurrentConversationId(userId, projectId);
    if (currentId) {
      const current = await conversationRepo.getConversation(currentId);
      if (current) return current;
    }

    // Enforce project access BEFORE creating anything, so a failed check does
    // not leave an orphan conversation behind. Chat is a creative-write action
    // — view-only members cannot open conversations.
    await projectService.assertAccess(projectId, userId, "editor");

    const created = await db.transaction(async (tx) => {
      const conv = await conversationRepo.createConversation(
        userId,
        firstMessage.slice(0, 100),
        tx,
      );
      await conversationRepo.setProjectId(conv.id, projectId, tx);

      // Losing the claim rolls the conversation back with it, so a race leaves
      // one conversation rather than one plus a stranded twin. The next turn of
      // the loop then reads whoever won.
      const won = await pointerRepo.claimCurrentConversation(
        userId,
        projectId,
        conv.id,
        tx,
      );
      if (!won) throw new LostTheClaim();

      return { ...conv, projectId };
    }).catch((err: unknown) => {
      if (err instanceof LostTheClaim) return null;
      throw err;
    });

    if (created) return created;
  }

  // Only reachable when every attempt both lost the claim AND then found the
  // winning conversation already deleted — someone deleting conversations in a
  // tight loop while another tab sends. Surfacing it beats spinning forever.
  throw new ConflictError(t("server.error.conflict"));
}

/**
 * Read the messages of the conversation this user is currently in.
 *
 * The read half of the same decision as {@link resolveCurrentConversation}:
 * the client asks "what is in front of me in this project" without naming a
 * conversation. Returns an empty history rather than an error when there is
 * nothing yet — a project a user has never chatted in is a normal state, not
 * a missing resource.
 * @param userId - Owner user UUID
 * @param projectId - Project to read the current conversation of
 * @returns The current conversation and its messages, or nulls when there is
 *   no live current conversation
 */
export async function getCurrentWithMessages(
  userId: string,
  projectId: string,
): Promise<{ conversation: ConversationEntity | null; messages: MessageData[] }> {
  const currentId = await pointerRepo.getCurrentConversationId(userId, projectId);
  if (!currentId) return { conversation: null, messages: [] };

  // Deleted-but-still-pointed-at reads as "nothing here yet", same rule as
  // the write path applies.
  const conversation = await conversationRepo.getConversation(currentId);
  if (!conversation) return { conversation: null, messages: [] };

  return { conversation, messages: await messageRepo.getMessages(currentId) };
}

/**
 * List conversations for a user, ordered by most recently updated.
 * @param userId - Owner user UUID
 * @param opts - Optional project scope and pagination window
 * @param opts.projectId - Optional project scope; when set, returns only
 *   conversations belonging to that project.
 * @param opts.limit - Maximum number of results (default 50)
 * @param opts.offset - Pagination offset (default 0)
 * @returns Array of conversation entities
 */
export async function list(
  userId: string,
  opts: { projectId?: string; limit?: number; offset?: number } = {},
): Promise<ConversationEntity[]> {
  return conversationRepo.listConversations(userId, opts);
}

/**
 * Fetch a conversation with its message history.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @returns The conversation entity and its messages
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
export async function getWithMessages(
  conversationId: string,
  userId: string,
): Promise<{ conversation: ConversationEntity; messages: MessageData[] }> {
  const conversation = await validateOwnership(conversationId, userId);
  const messages = await messageRepo.getMessages(conversationId);
  return { conversation, messages };
}

/**
 * Fetch a conversation by id without an ownership check.
 *
 * Thin pass-through to the conversation repository so route handlers
 * reach the data layer through the service (prohibition #1). Callers
 * that need a tenancy guard must use {@link assertAccess} /
 * {@link getWithMessages} instead.
 * @param id - Conversation UUID
 * @returns The conversation entity, or null if not found / soft-deleted
 */
export async function getConversation(
  id: string,
): Promise<ConversationEntity | null> {
  return conversationRepo.getConversation(id);
}

/**
 * Get a conversation's messages formatted for LLM context.
 *
 * Thin pass-through to the conversation repository so route handlers
 * reach the data layer through the service (prohibition #1). Skips
 * already-consolidated turns and strips internal-only fields.
 * @param id - Conversation UUID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 * @returns Messages from turns after the consolidated boundary
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
): Promise<MessageData[]> {
  return messageRepo.getMessagesForLlm(id, lastConsolidatedTurn);
}

/**
 * Soft-delete a conversation after validating ownership.
 *
 * Stamps `deleted_at` on the conversation and, because the FKs are RESTRICT
 * and Postgres will not cascade, on its messages, attachments and memory
 * rows as well.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(conversationId, userId);
  await conversationRepo.softDeleteConversation(conversationId);
}
