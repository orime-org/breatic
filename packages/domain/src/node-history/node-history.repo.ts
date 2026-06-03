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
 * List history entries for a node, ordered by most recent first.
 * @param projectId - Project UUID
 * @param nodeId - Node ID (string, e.g. "1002-1775309939251-LP9fU")
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
