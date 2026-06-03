// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Conversation attachment service — business logic for per-conversation
 * attachment pool used as reference material in Agent chat.
 */

import * as repo from "@server/modules/conversation/conversation-attachment.repo.js";
import { ConflictError, NotFoundError, ForbiddenError } from "@breatic/core";
import type { ConversationAttachmentEntity, AssetKind } from "@breatic/shared";

/** Maximum active attachments per conversation. */
export const MAX_ATTACHMENTS_PER_CONVERSATION = 50;

/**
 * Create a new attachment after an upload completes.
 * @param data - Attachment fields captured from the completed upload
 * @param data.conversationId - Conversation this attachment belongs to
 * @param data.userId - User who uploaded the attachment
 * @param data.url - Storage URL of the uploaded file
 * @param data.thumbnailUrl - Optional thumbnail URL (null for non-previewable kinds)
 * @param data.name - Original filename to display
 * @param data.mimeType - MIME type reported at upload time
 * @param data.size - File size in bytes
 * @param data.kind - Asset category (image / video / audio / etc.)
 * @returns The newly created attachment entity
 * @throws {ConflictError} when the conversation has reached the attachment limit
 */
export async function create(data: {
  conversationId: string;
  userId: string;
  url: string;
  thumbnailUrl?: string | null;
  name: string;
  mimeType: string;
  size: number;
  kind: AssetKind;
}): Promise<ConversationAttachmentEntity> {
  const activeCount = await repo.countActive(data.conversationId);
  if (activeCount >= MAX_ATTACHMENTS_PER_CONVERSATION) {
    throw new ConflictError(
      `Conversation has reached the ${MAX_ATTACHMENTS_PER_CONVERSATION} attachment limit. Delete some before uploading more.`,
    );
  }
  return repo.create(data);
}

/**
 * List active attachments for a conversation.
 * @param conversationId - Conversation whose attachment pool to list
 * @returns Active attachments in upload order (empty array when none)
 */
export async function listByConversation(
  conversationId: string,
): Promise<ConversationAttachmentEntity[]> {
  return repo.listByConversation(conversationId);
}

/**
 * Soft-delete an attachment.
 * @param id - Attachment UUID to delete
 * @param userId - Authenticated caller; must own the attachment
 * @throws {NotFoundError} when the attachment doesn't exist
 * @throws {ForbiddenError} when the caller doesn't own the attachment
 */
export async function softDelete(id: string, userId: string): Promise<void> {
  const existing = await repo.getById(id);
  if (!existing) {
    throw new NotFoundError(`Attachment not found: ${id}`);
  }
  if (existing.userId !== userId) {
    throw new ForbiddenError("Cannot delete another user's attachment");
  }
  if (existing.deletedAt) {
    return; // idempotent
  }
  await repo.softDelete(id);
}

/**
 * Get a single attachment by ID, enforcing ownership.
 * @param id - Attachment UUID to fetch
 * @param userId - Authenticated caller; must own the attachment
 * @returns The owned attachment entity
 * @throws {NotFoundError} when the attachment doesn't exist
 * @throws {ForbiddenError} when the caller doesn't own the attachment
 */
export async function getById(
  id: string,
  userId: string,
): Promise<ConversationAttachmentEntity> {
  const entry = await repo.getById(id);
  if (!entry) {
    throw new NotFoundError(`Attachment not found: ${id}`);
  }
  if (entry.userId !== userId) {
    throw new ForbiddenError("Cannot access another user's attachment");
  }
  return entry;
}
