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
import * as projectService from "@server/modules/project/project.service.js";
import { t } from "@breatic/shared";
import { db, NotFoundError, ForbiddenError } from "@breatic/core";
import type { ConversationEntity, MessageData } from "@breatic/shared";

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
 * Shared entry point for REST route handlers that need to reject cross-tenant
 * reads (e.g. conversation attachment listings) before doing any work.
 * Discards the returned entity so call sites read as an assertion rather than
 * a fetch.
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

/** Title a conversation carries until something better is known. */
const NEW_TITLE = "New conversation";

/**
 * Open chat in a project: the list, plus whatever the user was last saying.
 *
 * This is the client's single entry point into a project's chat, and the only
 * place a conversation is created on the user's behalf. It creates one when the
 * project has none, so a client always leaves here holding an id — which is why
 * sending a message can require one rather than having a creation path of its
 * own.
 *
 * Access is judged as a WRITE. It creates, so a member who may only read the
 * project must not get through, or a look-only visit leaves a conversation
 * behind in someone else's project.
 *
 * "What the user was last saying" is computed, never stored. Storing it would
 * mean one value per (user, project), and a user with two tabs on two
 * conversations has two states that one value cannot hold — which is why the
 * previous design was withdrawn.
 * @param userId - The signed-in user
 * @param projectId - Project being opened
 * @returns This user's conversations in this project, and the most recently
 *   used one together with its messages
 * @throws {NotFoundError} if the caller is not a member of the project
 * @throws {ForbiddenError} if they are a member but may only read
 */
export async function openChat(
  userId: string,
  projectId: string,
): Promise<{
  conversations: ConversationEntity[];
  current: { conversation: ConversationEntity; messages: MessageData[] };
}> {
  await projectService.assertAccess(projectId, userId, "editor");

  // Asking "is there one?" and then creating leaves a gap two tabs can both
  // walk through, each leaving an empty conversation behind. The lock makes the
  // pair one indivisible step per (user, project); whoever arrives second finds
  // the first one's conversation and uses it.
  const conversation = await db.transaction(async (tx) => {
    await conversationRepo.lockChatCreation(tx, userId, projectId);

    const existing = await conversationRepo.findMostRecentlyUsed(userId, projectId, tx);
    if (existing) return existing;

    const created = await conversationRepo.createConversation(userId, NEW_TITLE, tx);
    await conversationRepo.setProjectId(created.id, projectId, tx);
    return { ...created, projectId };
  });

  return {
    conversations: await conversationRepo.listConversations(userId, { projectId }),
    current: {
      conversation,
      messages: await messageRepo.getMessages(conversation.id),
    },
  };
}

/**
 * Check that a client-supplied conversation id may be written to here.
 *
 * The id arrives from outside now, so three things have to hold before a
 * message is appended: the conversation belongs to this user, it lives in this
 * project, and it still exists. The third is not an edge case — one tab holds
 * an id while the user deletes that conversation from another, and the first
 * two checks pass for it.
 *
 * All three answer NotFound rather than Forbidden: which conversations exist is
 * not something a caller may learn by probing.
 * @param conversationId - Conversation id as supplied by the client
 * @param userId - The signed-in user
 * @param projectId - Project the request claims to be in
 * @returns The conversation, once it has passed all three checks
 * @throws {NotFoundError} if it is missing, deleted, owned by someone else, or
 *   belongs to a different project
 */
export async function assertWritable(
  conversationId: string,
  userId: string,
  projectId: string,
): Promise<ConversationEntity> {
  const conversation = await conversationRepo.getConversation(conversationId);
  if (
    !conversation ||
    conversation.userId !== userId ||
    conversation.projectId !== projectId
  ) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return conversation;
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
