/**
 * Conversation attachment repository.
 *
 * Per-conversation candidate pool of uploaded files (images, videos,
 * audio, etc.) that the user can reference in messages. Soft-deleted
 * via deletedAt — records stay in DB, files stay in storage forever.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { conversationAttachments } from "@breatic/core";
import type { ConversationAttachmentEntity, AssetKind } from "@breatic/shared";

/**
 * Convert a Drizzle row to a ConversationAttachmentEntity.
 * @param row - Raw `conversation_attachments` table row from a Drizzle select
 * @returns The mapped domain entity (keeps `$inferSelect` out of callers)
 */
function toEntity(
  row: typeof conversationAttachments.$inferSelect,
): ConversationAttachmentEntity {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    url: row.url,
    thumbnailUrl: row.thumbnailUrl,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    kind: row.kind as AssetKind,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Create a new attachment.
 * @param data - Attachment fields to insert
 * @param data.conversationId - Conversation this attachment belongs to
 * @param data.userId - User who uploaded the attachment
 * @param data.url - Storage URL of the uploaded file
 * @param data.thumbnailUrl - Optional thumbnail URL (null for non-previewable kinds)
 * @param data.name - Original filename to display
 * @param data.mimeType - MIME type reported at upload time
 * @param data.size - File size in bytes
 * @param data.kind - Asset category (image / video / audio / etc.)
 * @returns The newly created attachment entity
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
  const rows = await db
    .insert(conversationAttachments)
    .values({
      conversationId: data.conversationId,
      userId: data.userId,
      url: data.url,
      thumbnailUrl: data.thumbnailUrl ?? null,
      name: data.name,
      mimeType: data.mimeType,
      size: data.size,
      kind: data.kind,
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * List active (non-deleted) attachments for a conversation,
 * ordered by creation time ascending (upload order).
 * @param conversationId - Conversation whose attachment pool to list
 * @returns Active attachments in upload order (empty array when none)
 */
export async function listByConversation(
  conversationId: string,
): Promise<ConversationAttachmentEntity[]> {
  const rows = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.conversationId, conversationId),
        isNull(conversationAttachments.deletedAt),
      ),
    )
    .orderBy(conversationAttachments.createdAt);
  return rows.map(toEntity);
}

/**
 * Get a single attachment by ID (including soft-deleted).
 * @param id - Attachment UUID to look up
 * @returns The attachment entity, or null if no row with that id exists
 */
export async function getById(
  id: string,
): Promise<ConversationAttachmentEntity | null> {
  const rows = await db
    .select()
    .from(conversationAttachments)
    .where(eq(conversationAttachments.id, id))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Soft delete an attachment — sets deleted_at, keeps record.
 * @param id - Attachment UUID to soft-delete
 */
export async function softDelete(id: string): Promise<void> {
  await db
    .update(conversationAttachments)
    .set({ deletedAt: new Date() })
    .where(eq(conversationAttachments.id, id));
}

/**
 * Count active attachments in a conversation (for quota enforcement).
 * @param conversationId - Conversation whose active attachments to count
 * @returns Number of non-deleted attachments in the conversation
 */
export async function countActive(conversationId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.conversationId, conversationId),
        isNull(conversationAttachments.deletedAt),
      ),
    );
  return result[0]?.count ?? 0;
}

/**
 * Sum active attachment sizes in bytes (for future quota/reporting).
 * @param conversationId - Conversation whose active attachment sizes to sum
 * @returns Total bytes of non-deleted attachments (0 when none)
 */
export async function sumActiveSize(conversationId: string): Promise<number> {
  const result = await db
    .select({ total: sql<number>`coalesce(sum(${conversationAttachments.size}), 0)::bigint` })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.conversationId, conversationId),
        isNull(conversationAttachments.deletedAt),
      ),
    );
  return Number(result[0]?.total ?? 0);
}
