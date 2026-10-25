// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Task repository — data access for the tasks table.
 *
 * Handles task lifecycle tracking with conditional timestamp updates.
 */

import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { tasks } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { GenerationSource, TaskEntity } from "@breatic/shared";
import type { DueMiniToolSettlement, DueMiniToolSettlementPage, MiniToolSettlement, MiniToolSettlementClaim, MiniToolSettlementCursor } from "@domain/mini-tool/consumption.types.js";

/** Parent facts read while serializing one task's consumption writes. */
export interface LockedMiniToolConsumptionTask {
  id: string;
  userId: string;
  projectId: string | null;
  status: string;
  source: string;
  model: string | null;
  billedAt: Date | null;
  billedCredits: number | null;
  result: Record<string, unknown>;
}

/**
 * Lock by immutable task identity before reading any consumption state.
 * @param taskId - The parent task, including a task hidden from user history.
 * @param tx - The transaction that will record usage and settlement together.
 * @returns Current parent facts, or null when no task exists.
 * @throws {Error} When the database read fails.
 */
export async function lockMiniToolConsumptionTask(taskId: string, tx: DbTx): Promise<LockedMiniToolConsumptionTask | null> {
  const [row] = await tx.select({
    id: tasks.id, userId: tasks.userId, projectId: tasks.projectId,
    status: tasks.status, source: tasks.source, result: tasks.result,
    model: tasks.model, billedAt: tasks.billedAt, billedCredits: tasks.billedCredits,
  }).from(tasks).where(eq(tasks.id, taskId)).for("update");
  return row ? { ...row, result: row.result ?? {} } : null;
}

/**
 * Claim a fixed amount without changing the parent's computation or media result.
 * @param taskId - The parent whose immutable row lock is held.
 * @param credits - The once-rounded complete expense.
 * @param tx - The same transaction that writes funds and releases its hold.
 * @returns Whether this transaction claimed the unbilled parent.
 * @throws {Error} When the database write fails.
 */
export async function claimMiniToolCharge(taskId: string, credits: number, tx: DbTx): Promise<boolean> {
  const rows = await tx.update(tasks).set({
    billedAt: sql`clock_timestamp()`, billedCredits: credits, creditsUsed: credits,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(tasks.id, taskId), isNull(tasks.billedAt))).returning({ id: tasks.id });
  return rows.length === 1;
}

/**
 * Check a lookup lease against the database clock after acquiring the task lock.
 * @param taskId - The task whose lock is held.
 * @param claim - The lookup's original version and token.
 * @param tx - The transaction holding the task lock.
 * @returns Whether this claim may still write its answer.
 * @throws {Error} When the database read fails.
 */
export async function hasMiniToolSettlementLease(taskId: string, claim: MiniToolSettlementClaim, tx: DbTx): Promise<boolean> {
  const [row] = await tx.select({
    valid: sql<boolean>`coalesce(
      ${tasks.result}->'settlement'->>'state' = 'checking'
      AND ${tasks.result}->'settlement'->>'version' = ${String(claim.version)}
      AND ${tasks.result}->'settlement'->>'leaseToken' = ${claim.leaseToken}
      AND (${tasks.result}->'settlement'->>'leaseUntil')::timestamptz > clock_timestamp(), false)`,
  }).from(tasks).where(eq(tasks.id, taskId));
  return row?.valid === true;
}

/**
 * Read a fresh UTC instant without passing through JavaScript's millisecond Date.
 * @param taskId - The task whose lock is held.
 * @param tx - The transaction holding the task lock.
 * @returns Database wall time with six fractional digits.
 * @throws {Error} When the task is missing or the database read fails.
 */
export async function miniToolSettlementDatabaseNow(taskId: string, tx: DbTx): Promise<string> {
  const [row] = await tx.select({
    now: sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(tasks).where(eq(tasks.id, taskId));
  if (!row) throw new Error("Consumption task no longer exists");
  return row.now;
}

/** SQL-clock instants and due decisions, retaining timestamp microseconds. */
export type MiniToolSettlementClock = {
  now: string;
  leaseUntil: string;
  retryAt: string;
  waitingDue: boolean;
  leaseExpired: boolean;
};

/**
 * Read billing due times using only the database clock while the task lock is held.
 * @param taskId - The immutable task identity.
 * @param timing - Billing lease and retry configuration, independent of computation.
 * @param timing.lease_ms - Duration of the lookup ownership.
 * @param timing.retry_ms - Delay before another lookup attempt.
 * @param tx - The short transaction holding the task lock.
 * @returns One consistent clock sample, precise instants and due decisions.
 * @throws {Error} When the task is absent or persistence is malformed.
 */
export async function miniToolSettlementClock(
  taskId: string, timing: { lease_ms: number; retry_ms: number }, tx: DbTx,
): Promise<MiniToolSettlementClock> {
  const rows = await tx.execute<MiniToolSettlementClock>(sql`
    WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT to_char(i.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "now",
      to_char((i.at + ${timing.lease_ms} * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
      to_char((i.at + ${timing.retry_ms} * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "retryAt",
      coalesce((t.result->'settlement'->>'nextAttemptAt')::timestamptz <= i.at, false) AS "waitingDue",
      coalesce((t.result->'settlement'->>'leaseUntil')::timestamptz <= i.at, false) AS "leaseExpired"
    FROM ${tasks} t CROSS JOIN instant i WHERE t.id = ${taskId}`);
  const row = rows[0];
  if (!row) throw new Error("Settlement task no longer exists");
  return row;
}

/**
 * Merge only settlement metadata into the current result under the task lock.
 * @param taskId - The parent whose calculation state and manifest stay intact.
 * @param settlement - The validated next consumption-recording period.
 * @param tx - The transaction that also wrote usage and the step's consumption.
 * @returns Nothing.
 * @throws {Error} When the task vanished or the database update fails.
 */
export async function storeMiniToolSettlement(taskId: string, settlement: MiniToolSettlement, tx: DbTx): Promise<void> {
  const patch = sql.param({ settlement }, tasks.result);
  const rows = await tx.update(tasks).set({
    result: sql`coalesce(${tasks.result}, '{}'::jsonb) || ${patch}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(eq(tasks.id, taskId)).returning({ id: tasks.id });
  if (rows.length !== 1) throw new Error("Consumption task no longer exists");
}

/**
 * Discover due periods, including expenses hidden from user-facing task history.
 * @param limit - The validated positive page size, leaving room for one lookahead row.
 * @param cursor - The preceding full-precision SQL position, never passed through Date.
 * @returns Current period identities in effective due-time and task UUID order.
 * @throws {Error} When the database read fails.
 */
export async function listDueMiniToolSettlements(limit: number, cursor?: MiniToolSettlementCursor): Promise<DueMiniToolSettlementPage> {
  const dueAt = sql`CASE ${tasks.result}->'settlement'->>'state'
    WHEN 'waiting' THEN (${tasks.result}->'settlement'->>'nextAttemptAt')::timestamptz
    WHEN 'checking' THEN (${tasks.result}->'settlement'->>'leaseUntil')::timestamptz END`;
  const after = cursor === undefined ? sql`` : sql`AND
    (${dueAt} > ${cursor.dueAt}::timestamptz OR
      (${dueAt} = ${cursor.dueAt}::timestamptz AND ${tasks.id} > ${cursor.taskId}::uuid))`;
  const rows = await db.execute<DueMiniToolSettlement & Record<string, unknown>>(sql`
    SELECT ${tasks.id} AS "taskId", (${tasks.result}->'settlement'->>'version')::float8 AS "settlementVersion",
      to_char(${dueAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt"
    FROM ${tasks}
    WHERE ${tasks.source} = 'mini_tool' AND ${tasks.billedAt} IS NULL
      AND jsonb_typeof(${tasks.result}->'settlement'->'version') = 'number'
      AND ${dueAt} <= clock_timestamp() ${after}
    ORDER BY ${dueAt}, ${tasks.id}
    LIMIT ${limit + 1}
  `);
  const items: DueMiniToolSettlement[] = rows.slice(0, limit).map((row) => ({
    taskId: row.taskId, settlementVersion: row.settlementVersion, dueAt: row.dueAt,
  }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? { taskId: last.taskId, dueAt: last.dueAt } : null };
}

/** Durable admission fields, with the database instant kept outside Date. */
export interface AnalysisTaskRow {
  id: string;
  userId: string;
  projectId: string | null;
  spaceId: string;
  taskType: string;
  status: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  acceptedAt: string;
}

const analysisTaskSelection = {
  id: tasks.id, userId: tasks.userId, projectId: tasks.projectId,
  spaceId: tasks.spaceId, taskType: tasks.taskType, status: tasks.status,
  params: tasks.params, result: tasks.result, errorMessage: tasks.errorMessage,
  acceptedAt: sql<string>`to_char(${tasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

/**
 * Read an analysis identity without losing SQL microseconds.
 * @param id - The run/task UUID.
 * @returns Its live row, including non-analysis rows for collision detection.
 * @throws {Error} When the database read fails.
 */
export async function getAnalysisTask(id: string): Promise<AnalysisTaskRow | null> {
  const [row] = await db.select(analysisTaskSelection).from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).limit(1);
  return row ? { ...row, params: row.params ?? {} } : null;
}

/**
 * Lock the original analysis task before deciding its metadata transition.
 * @param id - The immutable accepted task, including hidden history.
 * @param tx - The transaction that will write its status and analysis together.
 * @returns The current physical row and its original precise acceptance time.
 * @throws {Error} When the database read fails.
 */
export async function lockMiniToolAnalysisTask(id: string, tx: DbTx): Promise<AnalysisTaskRow | null> {
  const [row] = await tx.select(analysisTaskSelection).from(tasks).where(eq(tasks.id, id)).for("update");
  return row ? { ...row, params: row.params ?? {} } : null;
}

/**
 * Commit analysis metadata and computation status under their existing row lock.
 * @param id - The locked task identity.
 * @param update - The validated next record and calculation fields.
 * @param update.analysis - The complete public analysis record.
 * @param update.status - The task's next or preserved terminal status.
 * @param update.errorMessage - The task summary's failure code.
 * @param update.finish - Whether this write first terminates active computation.
 * @param tx - The transaction holding the original task lock.
 * @returns The row written in this transaction, retaining source microseconds.
 * @throws {Error} When the task disappears or the database update fails.
 */
export async function storeMiniToolAnalysisTransition(id: string, update: {
  analysis: Record<string, unknown>;
  status: "completed" | "failed" | "cancelled";
  errorMessage: string | null;
  finish: boolean;
}, tx: DbTx): Promise<AnalysisTaskRow> {
  const patch = sql.param({ analysis: update.analysis }, tasks.result);
  const [row] = await tx.update(tasks).set({
    status: update.status,
    result: sql`coalesce(${tasks.result}, '{}'::jsonb) || ${patch}`,
    errorMessage: update.errorMessage,
    completedAt: update.finish ? sql`coalesce(${tasks.completedAt}, clock_timestamp())` : tasks.completedAt,
    updatedAt: sql`clock_timestamp()`,
  }).where(eq(tasks.id, id)).returning(analysisTaskSelection);
  if (!row) throw new Error("Analysis task no longer exists");
  return { ...row, params: row.params ?? {} };
}

/**
 * Claim the durable run UUID before opening any node task or spending credits.
 * @param data - Frozen task inputs and the authenticated actor.
 * @param data.id - The client-generated analysis run UUID.
 * @param data.userId - The authenticated actor who owns this admission.
 * @param data.projectId - The project that owns the analysis.
 * @param data.spaceId - The canvas Space holding its source node.
 * @param data.params - The frozen analysis and backend execution inputs.
 * @param data.model - The served model, when this analysis calls one.
 * @returns Whether this caller inserted the task.
 * @throws {Error} When a database write fails.
 */
export async function claimAnalysisTask(data: {
  id: string; userId: string; projectId: string; spaceId: string;
  params: Record<string, unknown>; model?: string;
}): Promise<boolean> {
  const rows = await db.insert(tasks).values({
    ...data, taskType: "mini_tool_analysis", mode: "append", source: "mini_tool",
  }).onConflictDoNothing({ target: tasks.id }).returning({ id: tasks.id });
  return rows.length === 1;
}

/**
 * Store a public analysis record without changing its acceptance timestamp.
 * @param id - The task UUID.
 * @param analysis - The validated public analysis record.
 * @returns Nothing.
 * @throws {Error} When the database write fails.
 */
export async function storeAnalysisRecord(id: string, analysis: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ result: tasks.result }).from(tasks).where(eq(tasks.id, id)).for("update");
    if (!row) throw new Error(`Analysis task ${id} does not exist`);
    await tx.update(tasks).set({ result: { ...row.result, analysis }, updatedAt: new Date() }).where(eq(tasks.id, id));
  });
}

/**
 * Convert a Drizzle row to a TaskEntity.
 * @param row - The raw Drizzle row selected from the `tasks` table.
 * @returns The mapped `TaskEntity`.
 */
function toEntity(row: typeof tasks.$inferSelect): TaskEntity {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    spaceId: row.spaceId,
    taskType: row.taskType,
    mode: row.mode as "append" | "overwrite",
    model: row.model,
    status: row.status,
    params: (row.params ?? {}),
    result: row.result,
    errorMessage: row.errorMessage,
    arqJobId: row.arqJobId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    creditsUsed: row.creditsUsed,
    durationMs: row.durationMs,
    source: row.source,
    providerResultUrl: row.providerResultUrl,
    providerTaskId: row.providerTaskId,
    billedAt: row.billedAt,
    billedCredits: row.billedCredits,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Get a task by ID (excludes soft-deleted).
 * @param id - UUID of the task to fetch.
 * @returns The `TaskEntity`, or null if not found or soft-deleted.
 */
export async function getTaskById(id: string): Promise<TaskEntity | null> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * List active (non-deleted) tasks for a user, ordered by most recent.
 * @param userId - ID of the user whose tasks to list.
 * @param limit - Maximum rows to return; capped at 100. Defaults to 20.
 * @param offset - Number of rows to skip for pagination. Defaults to 0.
 * @returns The matching `TaskEntity` records.
 */
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

/**
 * Soft-delete a task (reserved for future "clear history" UI).
 * @param id - UUID of the task to soft-delete.
 */
export async function softDeleteTask(id: string): Promise<void> {
  await db
    .update(tasks)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

/**
 * Create a new task in the `queued` default state.
 * @param data - The task fields to insert.
 * @param data.userId - ID of the user who owns the task.
 * @param data.projectId - ID of the project the task targets, if any.
 * @param data.spaceId - Space within the project the task writes results to. Required: the
 *   Worker writes to `project-{projectId}/canvas-{spaceId}` (v10 multi-doc layout). Plain
 *   UUID, no FK in PG — Spaces live in the Yjs `meta` doc.
 * @param data.taskType - Task type discriminator (e.g. AIGC mini-tool / generation kind).
 * @param data.mode - Required (spec §10.13 + §10.15). `"append"` for new-sibling flows,
 *   `"overwrite"` for in-place replacement (caller must hold the canvas-node Redis lock
 *   before reaching here).
 * @param data.params - Provider/tool parameters for the task.
 * @param data.model - Model identifier to run the task with, if applicable.
 * @param data.source - Which lane opened this task; defaults to `"task"`.
 * @param data.id - The row's id, when the caller held credits under it first.
 * @returns The created `TaskEntity`.
 */
export async function createTask(data: {
  userId: string;
  projectId?: string;
  spaceId: string;
  taskType: string;
  mode: "append" | "overwrite";
  params: Record<string, unknown>;
  model?: string;
  /**
   * One word from the vocabulary, so a lane outside it cannot be written.
   * The column carries an older default (`"canvas"`), and this is the sole
   * insert into that table — every row therefore comes through here and the
   * column default is never what lands.
   */
  source?: GenerationSource;
  /**
   * The row's id when the caller had to know it before the row existed: the
   * canvas route holds the run's credits under it first (inner#1611).
   */
  id?: string;
}): Promise<TaskEntity> {
  const rows = await db
    .insert(tasks)
    .values({
      ...(data.id === undefined ? {} : { id: data.id }),
      userId: data.userId,
      projectId: data.projectId,
      spaceId: data.spaceId,
      taskType: data.taskType,
      mode: data.mode,
      params: data.params,
      model: data.model,
      source: data.source ?? "task",
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Move a task to an end state and set its completed_at.
 * @param id - UUID of the task to update.
 * @param status - The end state.
 * @param options - Optional result/error and usage metrics to persist alongside the status.
 * @param options.result - Provider/tool result payload to store.
 * @param options.error - Error message to store on failure.
 * @param options.creditsUsed - Credits consumed by the task.
 * @param options.durationMs - Wall-clock duration of the task in milliseconds.
 */
export async function updateTaskStatus(
  id: string,
  status: "completed" | "failed" | "cancelled",
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
    completedAt: now,
  };
  if (options?.result !== undefined) updates.result = options.result;
  if (options?.error !== undefined) updates.errorMessage = options.error;
  if (options?.creditsUsed !== undefined) updates.creditsUsed = options.creditsUsed;
  if (options?.durationMs !== undefined) updates.durationMs = options.durationMs;

  await db.update(tasks).set(updates).where(eq(tasks.id, id));
}

/**
 * Set the ARQ/BullMQ job ID on a task.
 * @param id - UUID of the task to update.
 * @param jobId - Queue job ID linking the task to its enqueued worker job.
 */
export async function setJobId(id: string, jobId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ arqJobId: jobId, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

/**
 * Mark a task running on a job and keep its first start.
 * @param id - UUID of the task.
 * @param jobId - The BullMQ job running it.
 * @param now - The start to keep when the row has none yet.
 * @returns The start the row holds after the write.
 * @throws {Error} When the task row does not exist.
 */
export async function markRunning(id: string, jobId: string, now: Date): Promise<Date> {
  const [row] = await db
    .update(tasks)
    .set({
      arqJobId: jobId,
      status: "running",
      startedAt: sql`coalesce(${tasks.startedAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(eq(tasks.id, id))
    .returning({ startedAt: tasks.startedAt });
  if (!row?.startedAt) throw new Error(`task ${id} has no row to mark running`);
  return row.startedAt;
}

/**
 * Record the provider result URL — marks the task as "past the point of
 * no provider retry". Subsequent Worker pickups of this task (e.g. after
 * a Worker crash) must check this field and fail-fast if it's set,
 * because the provider has already been invoked once.
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
 * Persist the vendor task id for an async generation, right after submit.
 * On a BullMQ retry the Worker resumes by polling this id (#1628).
 * @param id - Task UUID
 * @param providerTaskId - The vendor's task/request id returned by submit
 */
export async function recordProviderTaskId(
  id: string,
  providerTaskId: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({ providerTaskId, updatedAt: new Date() })
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
 * @param id - UUID of the task to mark completed.
 * @param result - Provider/tool result payload to persist on the task.
 * @param creditsUsed - Credits consumed; also written to the `billed_credits` guard column.
 * @param durationMs - Wall-clock duration of the task in milliseconds.
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
