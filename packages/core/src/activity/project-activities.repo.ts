// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project activities repository - `project_activities` table access
 * (ADR 2026-07-04 project-activity-feed).
 *
 * Core-owned because THREE services write it (shared-kernel rule):
 * server (asset handshake + member events), worker (generation
 * outcomes) and collab (space lifecycle - its first business-DB
 * write). The table is append-only (no soft delete - immutable audit
 * log, same exemption as project_lifecycle_outbox); the single mutable
 * column is `restored`, the restore-consumption marker on
 * space:deleted rows.
 *
 * Reads use keyset pagination on the (created_at DESC, id DESC)
 * compound cursor - offset pagination drifts when rows land between
 * page fetches and walks the index O(n).
 */

import { and, eq, isNull, lt, or, desc, sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import type { DbTx } from "@core/db/client.js";
import { projectActivities, studios } from "@core/db/schema.js";
import type {
  ProjectActivityEntry,
  ProjectActivityType,
} from "@breatic/shared";

/** Insert shape - id / restored / createdAt are DB-defaulted. */
export interface NewProjectActivity {
  projectId: string;
  actorUserId: string | null;
  type: ProjectActivityType;
  spaceId?: string | null;
  nodeId?: string | null;
  taskId?: string | null;
  payload: Record<string, unknown>;
}

/** Decoded keyset cursor - the (created_at, id) of the previous page's last row. */
export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

/**
 * Encode a keyset cursor as an opaque base64url token.
 * @param createdAt - `created_at` of the previous page's last row.
 * @param id - `id` of the previous page's last row (tie-breaker).
 * @returns Opaque cursor string for the next page request.
 */
export function encodeActivityCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ c: createdAt.getTime(), i: id }),
  ).toString("base64url");
}

/**
 * Decode an opaque activity cursor. Malformed input returns `null`
 * (callers fall back to the first page) instead of throwing - cursors
 * arrive from the network and must never 500 the feed route.
 * @param cursor - Opaque cursor string from the client.
 * @returns The decoded (createdAt, id) pair, or `null` when malformed.
 */
export function decodeActivityCursor(cursor: string): ActivityCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = (parsed as Record<string, unknown>)["c"];
    const i = (parsed as Record<string, unknown>)["i"];
    if (typeof c !== "number" || !Number.isFinite(c)) return null;
    if (typeof i !== "string" || i.length === 0) return null;
    return { createdAt: new Date(c), id: i };
  } catch {
    // Malformed base64 / JSON - treated as "no cursor" by callers.
    return null;
  }
}

/**
 * Map a raw row (+ optionally joined actor name) to the shared entry.
 * @param row - Selected `project_activities` row from drizzle.
 * @param actorName - Actor display name from the users join, if any.
 * @returns The shared `ProjectActivityEntry`.
 */
function toEntity(
  row: typeof projectActivities.$inferSelect,
  actorName: string | null,
): ProjectActivityEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    actorUserId: row.actorUserId,
    actorName,
    type: row.type as ProjectActivityType,
    spaceId: row.spaceId,
    nodeId: row.nodeId,
    taskId: row.taskId,
    payload: row.payload as Record<string, unknown>,
    restored: row.restored,
    createdAt: row.createdAt.getTime(),
  };
}

export const projectActivitiesRepo = {
  /**
   * Append one activity row. Threads an optional transaction so
   * writers can bundle the row with related writes (e.g. collab's
   * restore transaction).
   * @param activity - The new activity row (id/createdAt DB-defaulted).
   * @param tx - Optional drizzle transaction to join.
   * @returns The inserted row's id.
   */
  async insert(activity: NewProjectActivity, tx?: DbTx): Promise<string> {
    const executor = tx ?? db;
    const rows = await executor
      .insert(projectActivities)
      .values({
        projectId: activity.projectId,
        actorUserId: activity.actorUserId,
        type: activity.type,
        spaceId: activity.spaceId ?? null,
        nodeId: activity.nodeId ?? null,
        taskId: activity.taskId ?? null,
        payload: activity.payload,
      })
      .returning({ id: projectActivities.id });
    const row = rows[0];
    if (!row) throw new Error("project_activities insert returned no row");
    return row.id;
  },

  /**
   * Append a generation activity row idempotently: a redelivered
   * billed job re-runs worker Stage 4, and the partial UNIQUE on
   * task_id turns the duplicate insert into a no-op.
   * @param activity - The new generation row; `taskId` must be set.
   * @returns The inserted row's id, or `null` when the task already has a row.
   */
  async insertIgnoreDuplicateTask(
    activity: NewProjectActivity & { taskId: string },
  ): Promise<string | null> {
    const rows = await db
      .insert(projectActivities)
      .values({
        projectId: activity.projectId,
        actorUserId: activity.actorUserId,
        type: activity.type,
        spaceId: activity.spaceId ?? null,
        nodeId: activity.nodeId ?? null,
        taskId: activity.taskId,
        payload: activity.payload,
      })
      .onConflictDoNothing({
        target: projectActivities.taskId,
        where: sql`task_id IS NOT NULL`,
      })
      .returning({ id: projectActivities.id });
    return rows[0]?.id ?? null;
  },

  /**
   * One keyset page of a project's feed, newest first, with the actor
   * display name joined in (pointer model - renames propagate).
   * @param projectId - Project whose feed to read.
   * @param cursor - Decoded cursor from the previous page, or null for the first page.
   * @param limit - Page size (caller-clamped).
   * @returns Entries newest-first; `length === limit` implies more pages may exist.
   */
  async listByProject(
    projectId: string,
    cursor: ActivityCursor | null,
    limit: number,
  ): Promise<ProjectActivityEntry[]> {
    const keysetFilter = cursor
      ? or(
          lt(projectActivities.createdAt, cursor.createdAt),
          and(
            eq(projectActivities.createdAt, cursor.createdAt),
            lt(projectActivities.id, cursor.id),
          ),
        )
      : undefined;
    // Display names live on the personal studio (`users` is the pure
    // auth table - email-registration rewrite 2026-06-06), so the
    // actor join targets studios(type='personal').
    const rows = await db
      .select({ row: projectActivities, actorName: studios.name })
      .from(projectActivities)
      .leftJoin(
        studios,
        and(
          eq(studios.createdByUserId, projectActivities.actorUserId),
          eq(studios.type, "personal"),
          isNull(studios.deletedAt),
        ),
      )
      .where(
        keysetFilter
          ? and(eq(projectActivities.projectId, projectId), keysetFilter)
          : eq(projectActivities.projectId, projectId),
      )
      .orderBy(desc(projectActivities.createdAt), desc(projectActivities.id))
      .limit(limit);
    return rows.map((r) => toEntity(r.row, r.actorName));
  },

  /**
   * Latest unconsumed `space:deleted` row for a space - the restore
   * source (its payload.spaceSnapshot rebuilds the meta directory
   * entry; the canvas CONTENT doc is un-soft-deleted separately).
   * @param projectId - Project scope.
   * @param spaceId - The deleted space.
   * @returns The row as an entry, or `null` when nothing is restorable.
   */
  async latestUnrestoredDeleted(
    projectId: string,
    spaceId: string,
  ): Promise<ProjectActivityEntry | null> {
    const rows = await db
      .select()
      .from(projectActivities)
      .where(
        and(
          eq(projectActivities.projectId, projectId),
          eq(projectActivities.spaceId, spaceId),
          eq(projectActivities.type, "space:deleted"),
          eq(projectActivities.restored, false),
        ),
      )
      .orderBy(desc(projectActivities.createdAt), desc(projectActivities.id))
      .limit(1);
    return rows[0] ? toEntity(rows[0], null) : null;
  },

  /**
   * Mark a space:deleted row's snapshot as consumed by a restore.
   * Runs inside the caller's transaction together with the
   * space:restored insert and the content-doc undelete.
   * @param id - The space:deleted activity row id.
   * @param tx - Transaction to join (restore atomicity).
   * @returns Nothing.
   */
  async markRestored(id: string, tx: DbTx): Promise<void> {
    await tx
      .update(projectActivities)
      .set({ restored: true })
      .where(eq(projectActivities.id, id));
  },
};
