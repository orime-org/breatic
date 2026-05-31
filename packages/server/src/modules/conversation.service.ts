/**
 * Conversation service — business logic for conversations and messages.
 *
 * Enforces ownership checks at the service layer before delegating
 * to the conversation repository.
 */

import * as conversationRepo from "@server/modules/conversation.repo.js";
import * as projectService from "@server/modules/project.service.js";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError } from "@breatic/core";
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
 * Assert that the given user may access the given conversation.
 *
 * Shared entry point for REST route handlers that need to reject
 * cross-tenant reads (e.g. conversation attachment listings) before
 * doing any work. Discards the returned entity so call sites read
 * as an assertion rather than a fetch.
 *
 * @param conversationId - Conversation UUID from untrusted client input
 * @param userId - Authenticated user UUID from the session
 * @throws NotFoundError if conversation does not exist
 * @throws ForbiddenError if the user does not own the conversation
 */
export async function assertAccess(
  conversationId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(conversationId, userId);
}

/**
 * Get an existing conversation by ID or create a new one.
 *
 * If `conversationId` is provided, validates ownership and returns it.
 * Otherwise creates a new conversation with a title derived from the
 * first message content (truncated to 100 chars). If `projectId` is
 * provided, the caller's access to that project is verified before
 * linking — otherwise a user could silently attach a conversation to
 * someone else's project.
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

  // Enforce project access BEFORE creating the conversation so a
  // failed check does not leave an orphan conversation row behind.
  // Chat is a creative-write action — view-only members cannot
  // open chat sessions (v10 §7.2.1).
  if (projectId) {
    await projectService.assertAccess(projectId, userId, "edit");
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
