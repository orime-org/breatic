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
   * Record a SUCCEEDED generation, authoritatively. Success is the
   * terminal truth for a task (it billed + produced output), so it
   * always wins the one-row-per-task slot: if a premature / crash-net
   * `generation:failed` row already exists for this taskId, this
   * OVERWRITES it to `generation:succeeded` (keeping the row id +
   * created_at so feed ordering is stable); an existing succeeded row
   * is idempotently refreshed. This closes the "wrong-outcome sticks"
   * window that a bare first-write-wins insert leaves open when a
   * retryable attempt writes failed before the winning attempt succeeds.
   * @param activity - The generation row; `taskId` must be set, `type`
   *   must be `generation:succeeded`.
   * @returns The row id (inserted or overwritten).
   */
  async upsertGenerationSucceeded(
    activity: NewProjectActivity & { taskId: string; type: "generation:succeeded" },
  ): Promise<string> {
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
      .onConflictDoUpdate({
        target: projectActivities.taskId,
        targetWhere: sql`task_id IS NOT NULL`,
        set: {
          type: "generation:succeeded",
          actorUserId: activity.actorUserId,
          spaceId: activity.spaceId ?? null,
          nodeId: activity.nodeId ?? null,
          payload: activity.payload,
        },
      })
      .returning({ id: projectActivities.id });
    const row = rows[0];
    if (!row) throw new Error("generation success upsert returned no row");
    return row.id;
  },

  /**
   * Record a FAILED generation, non-destructively. Failure is NOT
   * authoritative — a later attempt may still succeed — so it only
   * lands when the task has no row yet: `ON CONFLICT DO NOTHING` never
   * overwrites an existing `generation:succeeded` (or an earlier
   * failed) row. Used by the in-handler terminal-failure paths AND the
   * cross-instance crash-net (which every live worker runs per failed
   * job — the conflict makes the redundant writes no-ops).
   * @param activity - The generation row; `taskId` must be set, `type`
   *   must be `generation:failed`.
   * @returns The inserted row's id, or `null` when a row already exists.
   */
  async insertGenerationFailedIfAbsent(
    activity: NewProjectActivity & { taskId: string; type: "generation:failed" },
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
        and(
          eq(projectActivities.projectId, projectId),
          isNull(projectActivities.deletedAt),
          ...(keysetFilter ? [keysetFilter] : []),
        ),
      )
      .orderBy(desc(projectActivities.createdAt), desc(projectActivities.id))
      .limit(limit);
    return rows.map((r) => toEntity(r.row, r.actorName));
  },

  /**
   * Soft-delete every live activity row of a project — the
   * deleteProject cascade (same as node_history). Individual rows are
   * never user-deleted, but the whole feed dies with its project.
   * @param projectId - Project being deleted.
   * @param tx - The deleteProject business transaction to join.
   * @returns Nothing.
   */
  async softDeleteByProject(projectId: string, tx: DbTx): Promise<void> {
    await tx
      .update(projectActivities)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectActivities.projectId, projectId),
          isNull(projectActivities.deletedAt),
        ),
      );
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
          isNull(projectActivities.deletedAt),
        ),
      )
      .orderBy(desc(projectActivities.createdAt), desc(projectActivities.id))
      .limit(1);
    return rows[0] ? toEntity(rows[0], null) : null;
  },

  /**
   * Compare-and-swap consume of a space:deleted row's snapshot, and —
   * only when THIS call wins the CAS — append the matching
   * space:restored row, both in ONE business-DB transaction.
   *
   * The consume is `SET restored=true WHERE id=? AND restored=false`:
   * if the row was already consumed (a concurrent cross-instance
   * restore won the race — restore holds no in-memory Yjs serialization
   * across instances), the update matches zero rows and we append
   * NOTHING, returning false. This is what keeps one restore = one
   * space:restored row and one snapshot consumption, honoring the
   * schema's "never consumed twice" guarantee. The content-doc undelete
   * lives in the separate yjs PG database and cannot join this
   * transaction — the caller sequences it before this call (restore
   * step order documented at the collab call site).
   * @param deletedRowId - The space:deleted row to consume.
   * @param restoredActivity - The space:restored row to append on a win.
   * @returns True when this call won the CAS and appended; false when
   *   the row was already consumed (no append).
   */
  async consumeRestoreAndAppend(
    deletedRowId: string,
    restoredActivity: NewProjectActivity,
  ): Promise<boolean> {
    return db.transaction(async (tx: DbTx) => {
      const won = await tx
        .update(projectActivities)
        .set({ restored: true })
        .where(
          and(
            eq(projectActivities.id, deletedRowId),
            eq(projectActivities.restored, false),
          ),
        )
        .returning({ id: projectActivities.id });
      if (won.length === 0) return false;
      await tx.insert(projectActivities).values({
        projectId: restoredActivity.projectId,
        actorUserId: restoredActivity.actorUserId,
        type: restoredActivity.type,
        spaceId: restoredActivity.spaceId ?? null,
        nodeId: restoredActivity.nodeId ?? null,
        taskId: restoredActivity.taskId ?? null,
        payload: restoredActivity.payload,
      });
      return true;
    });
  },
};
