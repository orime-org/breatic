// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Node history repository — data access for the node_history table.
 *
 * Each entry represents a content change on a canvas node: successful
 * or failed AIGC generation, or manual user upload. Queried by nodeId
 * ordered by created_at desc.
 */

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { nodeHistory, studios } from "@breatic/core";
import type { NodeHistoryEntity } from "@breatic/shared";

/**
 * Convert a Drizzle row to a NodeHistoryEntity.
 * @param row - The raw Drizzle row selected from the `node_history` table.
 * @param operatorName - Operator display name from the studios join, if any.
 *   Defaults to `null` — the write paths do not join, only `listByNode` does.
 * @returns The mapped `NodeHistoryEntity`.
 */
function toEntity(
  row: typeof nodeHistory.$inferSelect,
  operatorName: string | null = null,
): NodeHistoryEntity {
  return {
    id: row.id,
    projectId: row.projectId,
    nodeId: row.nodeId,
    userId: row.userId,
    operatorName,
    entryType: row.entryType as "generation" | "upload" | "snapshot",
    status: row.status as "success" | "failed",
    content: row.content,
    thumbnailUrl: row.thumbnailUrl,
    errorMessage: row.errorMessage,
    taskId: row.taskId,
    metadata: (row.metadata ?? {}),
    createdAt: row.createdAt,
  };
}

/**
 * Create a new history entry.
 * @param data - Entry fields (projectId, nodeId, userId, entryType, status required)
 * @param data.projectId - ID of the project owning the node.
 * @param data.nodeId - ID of the canvas node this entry records a change for.
 * @param data.userId - ID of the user who triggered the change.
 * @param data.entryType - `"generation"` for AIGC output, `"upload"` for a file the user brought, or `"snapshot"` for a copy they asked to keep.
 * @param data.status - `"success"` or `"failed"`.
 * @param data.content - Resulting content reference (e.g. asset URL); null when absent.
 * @param data.thumbnailUrl - Thumbnail URL for previews; null when absent.
 * @param data.errorMessage - Failure reason when `status` is `"failed"`; null otherwise.
 * @param data.taskId - ID of the task that produced this entry, when applicable.
 * @param data.metadata - Arbitrary entry metadata (model, cost, params, etc.).
 * @returns The inserted entity
 */
export async function create(data: {
  projectId: string;
  nodeId: string;
  userId: string;
  entryType: "generation" | "upload" | "snapshot";
  status: "success" | "failed";
  content?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}): Promise<NodeHistoryEntity> {
  const rows = await db
    .insert(nodeHistory)
    .values({
      projectId: data.projectId,
      nodeId: data.nodeId,
      userId: data.userId,
      entryType: data.entryType,
      status: data.status,
      content: data.content ?? null,
      thumbnailUrl: data.thumbnailUrl ?? null,
      errorMessage: data.errorMessage ?? null,
      taskId: data.taskId ?? null,
      metadata: data.metadata ?? {},
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Find the live successful row a node's history holds for this content — the
 * row the partial UNIQUE from migration 0087 (project_id, node_id,
 * md5(content)) WHERE status='success' AND content IS NOT NULL AND deleted_at
 * IS NULL lets stand. The predicate repeats the index's word for word, so a
 * success insert that conflicted on content always finds what it hit.
 * @param projectId - ID of the project owning the node.
 * @param nodeId - ID of the canvas node.
 * @param content - The content to look up (URL or text).
 * @returns The live success row holding this content, or null when none does.
 */
async function findLiveSuccessByContent(
  projectId: string,
  nodeId: string,
  content: string,
): Promise<typeof nodeHistory.$inferSelect | null> {
  const rows = await db
    .select()
    .from(nodeHistory)
    .where(
      and(
        eq(nodeHistory.projectId, projectId),
        eq(nodeHistory.nodeId, nodeId),
        sql`md5(${nodeHistory.content}) = md5(${content})`,
        eq(nodeHistory.status, "success"),
        isNotNull(nodeHistory.content),
        isNull(nodeHistory.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Turn a success insert that wrote nothing into the row that blocked it.
 * @param row - The row the follow-up lookup found, if any.
 * @returns The row.
 * @throws {Error} When no row was found — the insert conflicted on an index,
 *   so a live row holding it must exist; reaching this means the lookup and
 *   the index disagree.
 */
function conflictedRow(
  row: typeof nodeHistory.$inferSelect | null,
): typeof nodeHistory.$inferSelect {
  if (!row) {
    throw new Error("node_history insert conflicted but no live row matches it");
  }
  return row;
}

/**
 * Idempotently record a successful AIGC generation. Two partial unique indexes
 * can block the insert: (task_id, node_id) from migration 0036 — double-live
 * executions and a billed-redelivery re-record of one task — and content per
 * node from migration 0087 — a result this node's history already holds. The
 * insert names neither (`ON CONFLICT DO NOTHING`), so either one resolves to
 * the row already there, which is returned untouched.
 *
 * A billed task is recorded when its `node_tasks.node_history_id` is set: a
 * result identical to one the node already holds points at that row and writes
 * none of its own.
 * @param data - Generation fields.
 * @param data.projectId - ID of the project owning the node.
 * @param data.nodeId - ID of the canvas node the generation targets.
 * @param data.userId - ID of the user who triggered the generation.
 * @param data.content - Reference to the generated content (e.g. asset URL).
 * @param data.thumbnailUrl - Thumbnail URL for previews, if available.
 * @param data.taskId - ID of the task that produced this result.
 * @param data.metadata - Arbitrary generation metadata (model, cost, params, etc.).
 * @returns The inserted entity, or the pre-existing one on conflict.
 * @throws {Error} When the insert conflicted yet no live row matches it.
 */
export async function createGenerationSuccessIfAbsent(data: {
  projectId: string;
  nodeId: string;
  userId: string;
  content: string;
  thumbnailUrl?: string;
  taskId: string;
  metadata?: Record<string, unknown>;
}): Promise<NodeHistoryEntity> {
  const inserted = await db
    .insert(nodeHistory)
    .values({
      projectId: data.projectId,
      nodeId: data.nodeId,
      userId: data.userId,
      entryType: "generation",
      status: "success",
      content: data.content,
      thumbnailUrl: data.thumbnailUrl ?? null,
      taskId: data.taskId,
      metadata: data.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return toEntity(inserted[0]);
  const byTask = await db
    .select()
    .from(nodeHistory)
    .where(
      and(
        eq(nodeHistory.taskId, data.taskId),
        eq(nodeHistory.nodeId, data.nodeId),
        eq(nodeHistory.entryType, "generation"),
        eq(nodeHistory.status, "success"),
        isNull(nodeHistory.deletedAt),
      ),
    )
    .limit(1);
  return toEntity(
    conflictedRow(
      byTask[0] ??
        (await findLiveSuccessByContent(data.projectId, data.nodeId, data.content)),
    ),
  );
}

/**
 * Idempotently record a successful upload. Two partial unique indexes can
 * block the insert: the granted storage key from migration 0071 — a report
 * that arrives twice (#173) — and content per node from migration 0087 —
 * content this node's history already holds, keyless or under another key
 * (#2186). The insert names neither (`ON CONFLICT DO NOTHING`); the row that
 * blocked it is looked up by the key first, then by content.
 *
 * A later arrival may carry a thumbnail the row lacks: a container that timed
 * out once still lets the upload land, and asking again can answer a frame.
 * So a conflict fills an empty thumbnail in, and never clears one.
 * @param data - Upload fields.
 * @param data.projectId - ID of the project owning the node.
 * @param data.nodeId - ID of the canvas node the upload targets.
 * @param data.userId - ID of the user who uploaded.
 * @param data.content - Canonical URL of the registered asset.
 * @param data.thumbnailUrl - Cover URL for a video; the asset's own URL for an image.
 * @param data.storageKey - The granted storage key, when this upload has one.
 * @param data.metadata - Filename, byte size and mime type.
 * @returns The stored entry plus whether this call is the one that wrote it —
 *   true only when a new row went in.
 * @throws {Error} When the insert conflicted yet no live row matches it.
 */
export async function createUploadSuccessIfAbsent(data: {
  projectId: string;
  nodeId: string;
  userId: string;
  content: string;
  thumbnailUrl?: string;
  storageKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ entry: NodeHistoryEntity; inserted: boolean }> {
  const rows = await db
    .insert(nodeHistory)
    .values({
      projectId: data.projectId,
      nodeId: data.nodeId,
      userId: data.userId,
      entryType: "upload",
      status: "success",
      content: data.content,
      thumbnailUrl: data.thumbnailUrl ?? null,
      uploadStorageKey: data.storageKey ?? null,
      metadata: data.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return { entry: toEntity(rows[0]), inserted: true };

  const byKey =
    data.storageKey === undefined
      ? []
      : await db
          .select()
          .from(nodeHistory)
          .where(
            and(
              eq(nodeHistory.uploadStorageKey, data.storageKey),
              eq(nodeHistory.entryType, "upload"),
              isNull(nodeHistory.deletedAt),
            ),
          )
          .limit(1);
  const existing = conflictedRow(
    byKey[0] ??
      (await findLiveSuccessByContent(data.projectId, data.nodeId, data.content)),
  );
  if (existing.thumbnailUrl !== null || data.thumbnailUrl === undefined) {
    return { entry: toEntity(existing), inserted: false };
  }
  // Only fills an empty cover: the IS NULL guard leaves a cover another
  // arrival wrote in the meantime alone.
  const filled = await db
    .update(nodeHistory)
    .set({ thumbnailUrl: data.thumbnailUrl })
    .where(and(eq(nodeHistory.id, existing.id), isNull(nodeHistory.thumbnailUrl)))
    .returning();
  return { entry: toEntity(filled[0] ?? existing), inserted: false };
}

/**
 * Record a successful snapshot — a copy of what a node holds that somebody
 * asked to keep (#2175). Content already in this node's history is not kept
 * twice (#2186): the partial UNIQUE from migration 0087 blocks the insert and
 * the row already holding it is returned untouched.
 * @param data - Snapshot fields.
 * @param data.projectId - ID of the project owning the node.
 * @param data.nodeId - ID of the canvas node the snapshot is of.
 * @param data.userId - ID of the user who asked for it.
 * @param data.content - What the node held.
 * @returns The inserted entity, or the pre-existing one holding this content.
 * @throws {Error} When the insert conflicted yet no live row matches it.
 */
export async function createSnapshotSuccessIfAbsent(data: {
  projectId: string;
  nodeId: string;
  userId: string;
  content: string;
}): Promise<NodeHistoryEntity> {
  const inserted = await db
    .insert(nodeHistory)
    .values({
      projectId: data.projectId,
      nodeId: data.nodeId,
      userId: data.userId,
      entryType: "snapshot",
      status: "success",
      content: data.content,
      metadata: {},
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return toEntity(inserted[0]);
  return toEntity(
    conflictedRow(await findLiveSuccessByContent(data.projectId, data.nodeId, data.content)),
  );
}

/**
 * List history entries for a node, ordered by most recent first.
 * @param projectId - Project UUID
 * @param nodeId - Canvas node ID — a v4 UUID minted client-side by
 *   `@breatic/shared` `newId()`, stored as text (e.g.
 *   "550e8400-e29b-41d4-a716-446655440000")
 * @param opts - Pagination and filter
 * @param opts.limit - Maximum rows to return; capped at 100. Defaults to 20.
 * @param opts.offset - Number of rows to skip for pagination. Defaults to 0.
 * @param opts.status - Optional filter to only `"success"` or `"failed"` entries.
 * @returns The page of entries plus the total count matching the filter.
 */
export async function listByNode(
  projectId: string,
  nodeId: string,
  opts: {
    limit?: number;
    offset?: number;
    status?: "success" | "failed";
  } = {},
): Promise<{ entries: NodeHistoryEntity[]; total: number }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  const whereClause = opts.status
    ? and(
        eq(nodeHistory.projectId, projectId),
        eq(nodeHistory.nodeId, nodeId),
        eq(nodeHistory.status, opts.status),
        isNull(nodeHistory.deletedAt),
      )
    : and(
        eq(nodeHistory.projectId, projectId),
        eq(nodeHistory.nodeId, nodeId),
        isNull(nodeHistory.deletedAt),
      );

  // Operator display names live on the personal studio (`users` is the pure
  // auth table), so the join targets studios(type='personal') by the row's
  // userId — the same pointer-model join the activity feed uses (renames
  // propagate; #1619). `null` when the studio was deleted.
  const [rows, countResult] = await Promise.all([
    db
      .select({ row: nodeHistory, operatorName: studios.name })
      .from(nodeHistory)
      .leftJoin(
        studios,
        and(
          eq(studios.createdByUserId, nodeHistory.userId),
          eq(studios.type, "personal"),
          isNull(studios.deletedAt),
        ),
      )
      .where(whereClause)
      .orderBy(desc(nodeHistory.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(nodeHistory)
      .where(whereClause),
  ]);

  return {
    entries: rows.map((r) => toEntity(r.row, r.operatorName)),
    total: countResult[0]?.count ?? 0,
  };
}

/**
 * Get a single history entry by ID (excludes soft-deleted).
 * @param id - UUID of the history entry to fetch.
 * @returns The `NodeHistoryEntity`, or null if not found or soft-deleted.
 */
export async function getById(id: string): Promise<NodeHistoryEntity | null> {
  const rows = await db
    .select()
    .from(nodeHistory)
    .where(and(eq(nodeHistory.id, id), isNull(nodeHistory.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}
