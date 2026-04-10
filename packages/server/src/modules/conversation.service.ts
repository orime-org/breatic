/**
 * Conversation service — business logic for conversations and messages.
 *
 * Enforces ownership checks at the service layer before delegating
 * to the conversation repository.
 */

import * as conversationRepo from "./conversation.repo.js";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError } from "../errors.js";
import type { ConversationEntity, MessageData } from "@breatic/shared";

/**
 * Validate that a conversation exists and belongs to the given user.
 *
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @returns The validated conversation entity
 * @throws NotFoundError if conversation does not exist
 * @throws ForbiddenError if userId does not match the conversation owner
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
 * Get an existing conversation by ID or create a new one.
 *
 * If `conversationId` is provided, validates ownership and returns it.
 * Otherwise creates a new conversation with a title derived from the
 * first message content (truncated to 100 chars).
 *
 * @param userId - Owner user UUID
 * @param conversationId - Optional existing conversation UUID
 * @param firstMessage - Content of the first message (used as title for new conversations)
 * @param projectId - Optional project to associate
 * @returns The existing or newly created conversation
 */
export async function getOrCreate(
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
  projectId?: string,
): Promise<ConversationEntity> {
  if (conversationId) {
    return validateOwnership(conversationId, userId);
  }

  const title = firstMessage.slice(0, 100);
  const conv = await conversationRepo.createConversation(userId, title);

  if (projectId) {
    await conversationRepo.setProjectId(conv.id, projectId);
    return { ...conv, projectId };
  }

  return conv;
}

/**
 * List conversations for a user, ordered by most recently updated.
 *
 * @param userId - Owner user UUID
 * @param limit - Maximum number of results (default 50)
 * @param offset - Pagination offset (default 0)
 * @returns Array of conversation entities
 */
export async function list(
  userId: string,
  limit?: number,
  offset?: number,
): Promise<ConversationEntity[]> {
  return conversationRepo.listConversations(userId, limit, offset);
}

/**
 * Fetch a conversation with its message history.
 *
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @returns The conversation entity and its messages
 * @throws NotFoundError if conversation does not exist
 * @throws ForbiddenError if userId does not match the conversation owner
 */
export async function getWithMessages(
  conversationId: string,
  userId: string,
): Promise<{ conversation: ConversationEntity; messages: MessageData[] }> {
  const conversation = await validateOwnership(conversationId, userId);
  const messages = await conversationRepo.getMessages(conversationId);
  return { conversation, messages };
}

/**
 * Soft-delete a conversation after validating ownership.
 *
 * Sets `deleted_at` on the conversation record. The underlying messages
 * and any related attachments remain in the database and can be
 * restored by clearing `deleted_at` if needed.
 *
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @throws NotFoundError if conversation does not exist
 * @throws ForbiddenError if userId does not match the conversation owner
 */
export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(conversationId, userId);
  await conversationRepo.softDeleteConversation(conversationId);
}
