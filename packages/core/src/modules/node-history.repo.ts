/**
 * Node history repository — data access for the node_history table.
 *
 * Each entry represents a content change on a canvas node: successful
 * or failed AIGC generation, or manual user upload. Queried by nodeId
 * ordered by created_at desc.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { nodeHistory } from "../db/schema.js";
import type { NodeHistoryEntity } from "@breatic/shared";

/** Convert a Drizzle row to a NodeHistoryEntity. */
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
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

/**
 * Create a new history entry.
 *
 * @param data - Entry fields (projectId, nodeId, userId, entryType, status required)
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
 *
 * @param projectId - Project UUID
 * @param nodeId - Node ID (string, e.g. "1002-1775309939251-LP9fU")
 * @param opts - Pagination and filter
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
      )
    : and(
        eq(nodeHistory.projectId, projectId),
        eq(nodeHistory.nodeId, nodeId),
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

/** Get a single history entry by ID. */
export async function getById(id: string): Promise<NodeHistoryEntity | null> {
  const rows = await db
    .select()
    .from(nodeHistory)
    .where(eq(nodeHistory.id, id))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}
