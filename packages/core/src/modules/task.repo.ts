/**
 * Task repository — data access for the tasks table.
 *
 * Handles task lifecycle tracking with conditional timestamp updates.
 */

import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import type { TaskEntity } from "@breatic/shared";

/** Convert a Drizzle row to a TaskEntity. */
function toEntity(row: typeof tasks.$inferSelect): TaskEntity {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    spaceId: row.spaceId,
    taskType: row.taskType,
    mode: row.mode as "append" | "overwrite",
    model: row.model,
    skillName: row.skillName,
    status: row.status,
    params: (row.params ?? {}) as Record<string, unknown>,
    result: row.result as Record<string, unknown> | null,
    errorMessage: row.errorMessage,
    arqJobId: row.arqJobId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    creditsUsed: row.creditsUsed,
    durationMs: row.durationMs,
    resolvedSkills: (row.resolvedSkills ?? []) as string[],
    source: row.source,
    providerResultUrl: row.providerResultUrl,
    billedAt: row.billedAt,
    billedCredits: row.billedCredits,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Get a task by ID (excludes soft-deleted). */
export async function getTaskById(id: string): Promise<TaskEntity | null> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** List active (non-deleted) tasks for a user, ordered by most recent. */
export async function listTasksByUser(
  userId: string,
  limit = 20,
  offset = 0,
): Promise<TaskEntity[]> {
  const cappedLimit = Math.min(limit, 100);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.createdAt))
    .limit(cappedLimit)
    .offset(offset);
  return rows.map(toEntity);
}

/** Soft-delete a task (reserved for future "clear history" UI). */
export async function softDeleteTask(id: string): Promise<void> {
  await db
    .update(tasks)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

/** Create a new task. */
export async function createTask(data: {
  userId: string;
  projectId?: string;
  /**
   * Space within the project the task targets. Required because the
   * Worker writes results to `project-{projectId}/canvas-{spaceId}`
   * (v10 multi-doc layout). Plain UUID — no FK in PG (Spaces live
   * in Yjs `meta` doc).
   */
  spaceId: string;
  taskType: string;
  /**
   * Required (spec §10.13 + §10.15). `'append'` for new-sibling flows,
   * `'overwrite'` for in-place replacement (caller must hold the
   * canvas-node Redis lock before reaching here).
   */
  mode: "append" | "overwrite";
  params: Record<string, unknown>;
  model?: string;
  skillName?: string;
  source?: string;
}): Promise<TaskEntity> {
  const rows = await db
    .insert(tasks)
    .values({
      userId: data.userId,
      projectId: data.projectId,
      spaceId: data.spaceId,
      taskType: data.taskType,
      mode: data.mode,
      params: data.params,
      model: data.model,
      skillName: data.skillName,
      source: data.source ?? "canvas",
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Update task status with conditional timestamp handling.
 *
 * - RUNNING → sets started_at
 * - COMPLETED/FAILED/CANCELLED → sets completed_at
 */
export async function updateTaskStatus(
  id: string,
  status: string,
  options?: {
    result?: Record<string, unknown>;
    error?: string;
    creditsUsed?: number;
    durationMs?: number;
  },
): Promise<void> {
  const now = new Date();
  const updates: Record<string, unknown> = {
    status,
    updatedAt: now,
  };

  if (status === "running") {
    updates.startedAt = now;
  }
  if (["completed", "failed", "cancelled"].includes(status)) {
    updates.completedAt = now;
  }
  if (options?.result !== undefined) updates.result = options.result;
  if (options?.error !== undefined) updates.errorMessage = options.error;
  if (options?.creditsUsed !== undefined) updates.creditsUsed = options.creditsUsed;
  if (options?.durationMs !== undefined) updates.durationMs = options.durationMs;

  await db.update(tasks).set(updates).where(eq(tasks.id, id));
}

/** Set the ARQ/BullMQ job ID on a task. */
export async function setJobId(id: string, jobId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ arqJobId: jobId, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

/** Backfill the resolved skills list after execution. */
export async function setResolvedSkills(id: string, skills: string[]): Promise<void> {
  await db.execute(
    sql`UPDATE tasks SET resolved_skills = ${JSON.stringify(skills)}::jsonb, updated_at = NOW()
        WHERE id = ${id}`,
  );
}

/**
 * Record the provider result URL — marks the task as "past the point of
 * no provider retry". Subsequent Worker pickups of this task (e.g. after
 * a Worker crash) must check this field and fail-fast if it's set,
 * because the provider has already been invoked once.
 *
 * @param id - Task UUID
 * @param providerResultUrl - URL returned by the provider (pre-persistence)
 */
export async function recordProviderResult(
  id: string,
  providerResultUrl: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({ providerResultUrl, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

/**
 * CAS update: mark the task as completed AND set the billing guard in
 * a single atomic step. Returns `true` if this call was the one that
 * transitioned the task to completed (first winner), `false` if the
 * task was already completed by another Worker.
 *
 * The `billed_at` column is set here as the idempotency guard. A
 * subsequent `chargeOnce()` call uses this column to determine whether
 * to actually deduct credits (first call wins, retries are no-ops).
 *
 * @returns `true` if this call performed the transition, `false` if already completed
 */
export async function markCompletedAndBill(
  id: string,
  result: Record<string, unknown>,
  creditsUsed: number,
  durationMs: number,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(tasks)
    .set({
      status: "completed",
      result,
      creditsUsed,
      durationMs,
      completedAt: now,
      billedAt: now,
      billedCredits: creditsUsed,
      updatedAt: now,
    })
    .where(and(eq(tasks.id, id), isNull(tasks.billedAt)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}
