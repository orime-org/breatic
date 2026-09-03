// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `node_tasks` (#186).
 *
 * Every state change carries its expected predecessor in the WHERE clause, so
 * two writers racing on one row cannot both win. The caller decides what an
 * affected-row count of zero means: a machine reporting a fact treats it as
 * "already settled, nothing to do", a user asking for an action treats it as
 * a refusal.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { nodeTasks } from "@breatic/core";

/** The four states a task can be in, and the four numbers the node shows. */
export type NodeTaskStatus = "running" | "done" | "failed" | "expired";

/** What the node's corner shows: one number per state. */
export interface NodeTaskCounts {
  running: number;
  done: number;
  failed: number;
  expired: number;
}

/** A task row as the list endpoint hands it out. */
export interface NodeTaskRow {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  kind: string;
  status: NodeTaskStatus;
  startedByUserId: string;
  startedAt: Date;
  budgetMs: number;
  label: string;
  errorMessage: string | null;
  nodeHistoryId: string | null;
}

/**
 * Open a task in `running`.
 * @param data - Everything the row needs at birth.
 * @param data.projectId - Owning project.
 * @param data.spaceId - The space, so an event can name the document.
 * @param data.nodeId - The node this task runs on.
 * @param data.kind - `upload` or `generation`.
 * @param data.startedByUserId - Who started it.
 * @param data.budgetMs - The conservative allowance the timer is set from.
 * @param data.label - Filename or model name, what the user reads.
 * @param data.taskId - The AIGC job; absent on uploads.
 * @param data.storageKey - The upload grant; absent on generations.
 * @returns The new row's id.
 */
export async function insertRunning(data: {
  projectId: string;
  spaceId: string;
  nodeId: string;
  kind: string;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  taskId?: string;
  storageKey?: string;
}): Promise<string> {
  const rows = await db
    .insert(nodeTasks)
    .values({ ...data, status: "running" })
    .returning({ id: nodeTasks.id });
  return rows[0]!.id;
}

/**
 * Move a running row to a terminal state.
 * @param taskId - Which task.
 * @param status - Where it lands.
 * @param fields - The result pointer or the reason, whichever applies.
 * @param fields.nodeHistoryId - The history row holding the result.
 * @param fields.errorMessage - Why it failed or timed out.
 * @returns True when this call is the one that moved it.
 */
export async function settleRunning(
  taskId: string,
  status: Exclude<NodeTaskStatus, "running">,
  fields: { nodeHistoryId?: string; errorMessage?: string },
): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ status, ...fields })
    .where(and(eq(nodeTasks.id, taskId), eq(nodeTasks.status, "running")))
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * Attach a result to a row that already settled.
 *
 * The case this exists for: the deadline passed, the timer moved the row to
 * `expired`, and the report arrived after that. The bytes are in R2 and the
 * history row is written, so the result has to become reachable — while the
 * status stays where it is, because the user may already have retried and
 * choosing for them is not ours to do.
 * @param taskId - Which task.
 * @param nodeHistoryId - The history row now holding the result.
 * @returns True when the pointer was empty and this call filled it.
 */
export async function attachResult(
  taskId: string,
  nodeHistoryId: string,
): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ nodeHistoryId })
    .where(and(eq(nodeTasks.id, taskId), isNull(nodeTasks.nodeHistoryId)))
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * Hide a settled row from the list, keeping it in the table.
 * @param taskId - Which task.
 * @returns True when a settled, undeleted row was hidden.
 */
export async function softDeleteSettled(taskId: string): Promise<boolean> {
  const rows = await db
    .update(nodeTasks)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(nodeTasks.id, taskId),
        isNull(nodeTasks.deletedAt),
        sql`${nodeTasks.status} <> 'running'`,
      ),
    )
    .returning({ id: nodeTasks.id });
  return rows.length === 1;
}

/**
 * Read one row whatever state it is in, including hidden ones.
 * @param taskId - Which task.
 * @returns The row, or null when the table does not hold it.
 */
export async function findById(taskId: string): Promise<
  | (NodeTaskRow & { deletedAt: Date | null })
  | null
> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(eq(nodeTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    spaceId: row.spaceId,
    nodeId: row.nodeId,
    kind: row.kind,
    status: row.status as NodeTaskStatus,
    startedByUserId: row.startedByUserId,
    startedAt: row.startedAt,
    budgetMs: row.budgetMs,
    label: row.label,
    errorMessage: row.errorMessage,
    nodeHistoryId: row.nodeHistoryId,
    deletedAt: row.deletedAt,
  };
}

/**
 * Find the task an upload grant belongs to.
 *
 * The report names a storage key and nothing else, so this is how the upload
 * leg gets from what the Worker said back to the row the ticket opened.
 * @param storageKey - The grant the bytes landed under.
 * @returns The row, or null when no task was opened for that key.
 */
export async function findByStorageKey(
  storageKey: string,
): Promise<NodeTaskRow | null> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(eq(nodeTasks.storageKey, storageKey))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    spaceId: row.spaceId,
    nodeId: row.nodeId,
    kind: row.kind,
    status: row.status as NodeTaskStatus,
    startedByUserId: row.startedByUserId,
    startedAt: row.startedAt,
    budgetMs: row.budgetMs,
    label: row.label,
    errorMessage: row.errorMessage,
    nodeHistoryId: row.nodeHistoryId,
  };
}

/**
 * Count the live rows on a node, one number per state.
 *
 * This is the whole of what the canvas document holds about tasks, so it is
 * recomputed after every state change rather than adjusted incrementally —
 * a number that is either current or stale cannot drift per entry.
 * @param projectId - Owning project.
 * @param nodeId - The node.
 * @returns The four counts, zeros included.
 */
export async function countsFor(
  projectId: string,
  nodeId: string,
): Promise<NodeTaskCounts> {
  const rows = await db
    .select({ status: nodeTasks.status, n: sql<string>`count(*)` })
    .from(nodeTasks)
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.nodeId, nodeId),
        isNull(nodeTasks.deletedAt),
      ),
    )
    .groupBy(nodeTasks.status);

  const counts: NodeTaskCounts = {
    running: 0,
    done: 0,
    failed: 0,
    expired: 0,
  };
  for (const row of rows) {
    const key = row.status as NodeTaskStatus;
    if (key in counts) counts[key] = Number(row.n);
  }
  return counts;
}

/**
 * List the live rows on a node, newest first.
 * @param projectId - Owning project.
 * @param nodeId - The node.
 * @returns Every row the user may still act on.
 */
export async function listLive(
  projectId: string,
  nodeId: string,
): Promise<NodeTaskRow[]> {
  const rows = await db
    .select()
    .from(nodeTasks)
    .where(
      and(
        eq(nodeTasks.projectId, projectId),
        eq(nodeTasks.nodeId, nodeId),
        isNull(nodeTasks.deletedAt),
      ),
    )
    .orderBy(sql`${nodeTasks.startedAt} DESC`);

  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    spaceId: row.spaceId,
    nodeId: row.nodeId,
    kind: row.kind,
    status: row.status as NodeTaskStatus,
    startedByUserId: row.startedByUserId,
    startedAt: row.startedAt,
    budgetMs: row.budgetMs,
    label: row.label,
    errorMessage: row.errorMessage,
    nodeHistoryId: row.nodeHistoryId,
  }));
}
