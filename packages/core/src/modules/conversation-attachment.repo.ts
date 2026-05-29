/**
 * Conversation attachment repository.
 *
 * Per-conversation candidate pool of uploaded files (images, videos,
 * audio, etc.) that the user can reference in messages. Soft-deleted
 * via deletedAt — records stay in DB, files stay in storage forever.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import { conversationAttachments } from "@core/db/schema.js";
import type { ConversationAttachmentEntity, AssetKind } from "@breatic/shared";

/** Convert a Drizzle row to a ConversationAttachmentEntity. */
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

/** Create a new attachment. */
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

/** Get a single attachment by ID (including soft-deleted). */
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

/** Soft delete an attachment — sets deleted_at, keeps record. */
export async function softDelete(id: string): Promise<void> {
  await db
    .update(conversationAttachments)
    .set({ deletedAt: new Date() })
    .where(eq(conversationAttachments.id, id));
}

/** Count active attachments in a conversation (for quota enforcement). */
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

/** Sum active attachment sizes in bytes (for future quota/reporting). */
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
