// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Node history repository — data access for the node_history table.
 *
 * Each entry represents a content change on a canvas node: successful
 * or failed AIGC generation, or manual user upload. Queried by nodeId
 * ordered by created_at desc.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { nodeHistory } from "@breatic/core";
import type { NodeHistoryEntity } from "@breatic/shared";

/**
 * Convert a Drizzle row to a NodeHistoryEntity.
 * @param row - The raw Drizzle row selected from the `node_history` table.
 * @returns The mapped {@link NodeHistoryEntity}.
 */
function toEntity(row: typeof nodeHistory.$inferSelect): NodeHistoryEntity {
  return {
    id: row.id,
    projectId: row.projectId,
    nodeId: row.nodeId,
    userId: row.userId,
    entryType: row.entryType as "generation" | "upload",
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
 * @param data.entryType - `"generation"` for AIGC output or `"upload"` for a manual user upload.
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
  entryType: "generation" | "upload";
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
 * Idempotently record a successful AIGC generation. Backed by the partial
 * unique index from migration 0036 — (task_id, node_id) WHERE
 * entry_type='generation' AND status='success' AND deleted_at IS NULL — so
 * concurrent double-live executions and a billed-redelivery re-record all
 * collapse to a single row. On conflict no new row is inserted and the
 * pre-existing one is returned.
 * @param data - Generation fields; `taskId` is the idempotency key.
 * @param data.projectId - ID of the project owning the node.
 * @param data.nodeId - ID of the canvas node the generation targets.
 * @param data.userId - ID of the user who triggered the generation.
 * @param data.content - Reference to the generated content (e.g. asset URL).
 * @param data.thumbnailUrl - Thumbnail URL for previews, if available.
 * @param data.taskId - ID of the task that produced this result (idempotency key).
 * @param data.metadata - Arbitrary generation metadata (model, cost, params, etc.).
 * @returns The inserted entity, or the pre-existing one on conflict.
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
    .onConflictDoNothing({
      target: [nodeHistory.taskId, nodeHistory.nodeId],
      where: sql`task_id IS NOT NULL AND entry_type = 'generation' AND status = 'success' AND deleted_at IS NULL`,
    })
    .returning();
  if (inserted[0]) return toEntity(inserted[0]);
  // Conflict — the success row already exists; fetch and return it so the
  // caller still gets the canonical entity (idempotent from any path).
  const existing = await db
    .select()
    .from(nodeHistory)
    .where(
      and(
        eq(nodeHistory.taskId, data.taskId),
        eq(nodeHistory.nodeId, data.nodeId),
        eq(nodeHistory.status, "success"),
        isNull(nodeHistory.deletedAt),
      ),
    )
    .limit(1);
  return toEntity(existing[0]!);
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

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(nodeHistory)
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
    entries: rows.map(toEntity),
    total: countResult[0]?.count ?? 0,
  };
}

/**
 * Get a single history entry by ID (excludes soft-deleted).
 * @param id - UUID of the history entry to fetch.
 * @returns The {@link NodeHistoryEntity}, or null if not found or soft-deleted.
 */
export async function getById(id: string): Promise<NodeHistoryEntity | null> {
  const rows = await db
    .select()
    .from(nodeHistory)
    .where(and(eq(nodeHistory.id, id), isNull(nodeHistory.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}
