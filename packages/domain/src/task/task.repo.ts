// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Task repository — data access for the tasks table.
 *
 * Handles task lifecycle tracking with conditional timestamp updates.
 */

import { and, eq, desc, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db, type DbTx } from "@breatic/core";
import { tasks } from "@breatic/core";
import type { GenerationSource, TaskEntity } from "@breatic/shared";
import type { MiniToolMedium } from "@breatic/shared/mini-tools";
import type { DueMiniToolSettlement, DueMiniToolSettlementPage, MiniToolSettlement, MiniToolSettlementClaim, MiniToolSettlementCursor } from "@domain/mini-tool/consumption.types.js";
import type { MiniToolDeliveryState, MiniToolDeliveryCursor } from "@domain/mini-tool/delivery.service.js";

/**
 * Patch only durable media delivery, preserving computation and consumption siblings.
 * @param taskId - The original task whose immutable row lock is held.
 * @param delivery - The validated internal delivery state.
 * @param tx - The same transaction as manifest initialization or acknowledgement.
 * @returns Nothing after the original parent is updated.
 * @throws {Error} When the parent disappeared or its update fails.
 */
export async function storeMiniToolDelivery(taskId: string, delivery: MiniToolDeliveryState, tx: DbTx): Promise<void> {
  const patch = sql.param({ miniToolDelivery: delivery }, tasks.result);
  const rows = await tx.update(tasks).set({
    result: sql`coalesce(${tasks.result}, '{}'::jsonb) || ${patch}`, updatedAt: sql`clock_timestamp()`,
  }).where(eq(tasks.id, taskId)).returning({ id: tasks.id });
  if (rows.length !== 1) throw new Error("Delivery task no longer exists");
}

/**
 * Discover registered manifests requiring delivery, including pre-existing missing siblings.
 * @param limit - The bounded positive page size, including room for one caller lookahead.
 * @param cursor - The preceding immutable SQL primary key.
 * @returns Candidate task identities in exact UUID order, independent of billing and deadlines.
 * @throws {Error} When the database read fails.
 */
export async function listMiniToolDeliveryCandidates(limit: number, cursor?: MiniToolDeliveryCursor): Promise<string[]> {
  const after = cursor === undefined ? sql`` : sql`AND ${tasks.id} > ${cursor.taskId}::uuid`;
  const rows = await db.execute<{ id: string }>(sql`
    SELECT ${tasks.id} AS id FROM ${tasks}
    WHERE ${tasks.source} = 'mini_tool' AND ${tasks.status} IN ('completed', 'failed')
      AND ${tasks.params}->'miniToolExecution' IS NOT NULL
      AND jsonb_path_exists(${tasks.result}, '$.miniToolExecution.outputs[*] ? (@.result.status == "registered")')
      AND (${tasks.result}->'miniToolDelivery' IS NULL
        OR jsonb_path_exists(${tasks.result}, '$.miniToolDelivery.outputs[*] ? (@.state == "pending")'))
      ${after} ORDER BY ${tasks.id} LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

/** Parent facts read while serializing one task's consumption writes. */
export interface LockedMiniToolConsumptionTask {
  id: string;
  taskType: string;
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
    id: tasks.id, taskType: tasks.taskType, userId: tasks.userId, projectId: tasks.projectId,
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
  const dueAt = sql`mini_tool_settlement_due_at(${tasks.result})`;
  const after = cursor === undefined ? sql`` : sql`AND
    (${dueAt}, ${tasks.id}) > (${cursor.dueAt}::timestamptz, ${cursor.taskId}::uuid)`;
  const rows = await db.execute<DueMiniToolSettlement & Record<string, unknown>>(sql`
    WITH discovery_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT ${tasks.id} AS "taskId", (${tasks.result}->'settlement'->>'version')::float8 AS "settlementVersion",
      to_char(${dueAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt"
    FROM ${tasks}
    WHERE ${tasks.source} = 'mini_tool' AND ${tasks.billedAt} IS NULL
      AND jsonb_typeof(${tasks.result}->'settlement'->'version') = 'number'
      AND ${tasks.result}->'settlement'->>'state' IN ('waiting', 'checking')
      AND ${dueAt} <= (SELECT at FROM discovery_clock) ${after}
    ORDER BY ${dueAt}, ${tasks.id}
    LIMIT ${limit + 1}
  `);
  const items: DueMiniToolSettlement[] = rows.slice(0, limit).map((row) => ({
    taskId: row.taskId, settlementVersion: row.settlementVersion, dueAt: row.dueAt,
  }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? { taskId: last.taskId, dueAt: last.dueAt } : null };
}

/**
 * Read the current committed waiting cycle after a claim or recording invalidates its predecessor.
 * @param taskId - The validated immutable parent, including hidden task history.
 * @returns Its current waiting identity, even when its retry time is still in the future.
 * @throws {Error} When the database read fails.
 */
export async function waitingMiniToolSettlement(taskId: string): Promise<DueMiniToolSettlement | null> {
  const rows = await db.execute<DueMiniToolSettlement & Record<string, unknown>>(sql`
    SELECT ${tasks.id} AS "taskId", (${tasks.result}->'settlement'->>'version')::float8 AS "settlementVersion",
      to_char(mini_tool_settlement_due_at(${tasks.result}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt"
    FROM ${tasks}
    WHERE ${tasks.id} = ${taskId}::uuid AND ${tasks.source} = 'mini_tool' AND ${tasks.billedAt} IS NULL
      AND jsonb_typeof(${tasks.result}->'settlement'->'version') = 'number'
      AND ${tasks.result}->'settlement'->>'state' = 'waiting'
  `);
  const row = rows[0];
  return row && typeof row.dueAt === "string" ? { taskId: row.taskId, settlementVersion: row.settlementVersion, dueAt: row.dueAt } : null;
}

/** Durable admission fields, with the database instant kept outside Date. */
export interface AnalysisTaskRow {
  id: string;
  userId: string;
  projectId: string | null;
  spaceId: string;
  taskType: string;
  source: string;
  status: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  acceptedAt: string;
  /** What the analysis was charged once billed, null before. */
  billedCredits: number | null;
}

/** The columns an analysis task is read with. */
type AnalysisTaskSelection = {
  id: typeof tasks.id; userId: typeof tasks.userId; projectId: typeof tasks.projectId; spaceId: typeof tasks.spaceId;
  taskType: typeof tasks.taskType; source: typeof tasks.source; status: typeof tasks.status; params: typeof tasks.params;
  result: typeof tasks.result; errorMessage: typeof tasks.errorMessage; billedCredits: typeof tasks.billedCredits; acceptedAt: SQL<string>;
};

/**
 * The columns an analysis task is read with, built when read so that loading this module reads no table.
 * @returns The selection.
 */
function analysisTaskSelection(): AnalysisTaskSelection {
  return {
    id: tasks.id, userId: tasks.userId, projectId: tasks.projectId,
    spaceId: tasks.spaceId, taskType: tasks.taskType, source: tasks.source, status: tasks.status,
    params: tasks.params, result: tasks.result, errorMessage: tasks.errorMessage, billedCredits: tasks.billedCredits,
    acceptedAt: sql<string>`to_char(${tasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  };
}

/**
 * Read an analysis identity without losing SQL microseconds.
 * @param id - The run/task UUID.
 * @returns Its live row, including non-analysis rows for collision detection.
 * @throws {Error} When the database read fails.
 */
export async function getAnalysisTask(id: string): Promise<AnalysisTaskRow | null> {
  const [row] = await db.select(analysisTaskSelection()).from(tasks)
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
  const [row] = await tx.select(analysisTaskSelection()).from(tasks).where(eq(tasks.id, id)).for("update");
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
  }).where(eq(tasks.id, id)).returning(analysisTaskSelection());
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
 * @param tx - The admission transaction that also writes the analysis pin, if any.
 * @returns Whether this caller inserted the task.
 * @throws {Error} When a database write fails.
 */
export async function claimAnalysisTask(data: {
  id: string; userId: string; projectId: string; spaceId: string;
  params: Record<string, unknown>; model?: string;
}, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db).insert(tasks).values({
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
 * A task completed and waiting on its cost: not yet billed, and marked by `markCompleted` (inner#1743).
 * @returns The condition.
 */
function waitingOnCost(): SQL {
  return sql`${tasks.billedAt} IS NULL AND ${tasks.result} ? 'costWait'`;
}

/**
 * Every task but one waiting on its cost.
 * @returns The condition.
 */
function notWaitingOnCost(): SQL {
  return sql`NOT (${tasks.billedAt} IS NULL AND coalesce(${tasks.result} ? 'costWait', false))`;
}

/**
 * Resolve one bounded set of task provenance without guessing from producers.
 * @param ids - The captured generation-task identities.
 * @returns Live task rows in immutable-id order.
 * @throws {Error} When the database read fails.
 */
export async function findLiveTasksByIds(ids: readonly string[]): Promise<TaskEntity[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(tasks).where(and(inArray(tasks.id, [...new Set(ids)]), isNull(tasks.deletedAt))).orderBy(tasks.id);
  return rows.map(toEntity);
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
    keyId: row.keyId,
    llmKeyId: row.llmKeyId,
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
 * Read a durable execution identity even after its user-facing history is hidden.
 * @param id - The immutable task/run UUID.
 * @returns The original parent, including an occupied non-execution identity for collision checks.
 * @param transaction - The caller's existing computation transaction, when present.
 * @throws {Error} When the database read fails.
 */
export async function getMiniToolExecutionTask(id: string, transaction?: DbTx): Promise<TaskEntity | null> {
  const rows = await (transaction ?? db).select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Serialize planned media and its public expense projection by the original task.
 * @param id - The immutable accepted task identity.
 * @param tx - The transaction retaining the task lock.
 * @returns Its complete current parent, including hidden worker history.
 * @throws {Error} When the database read fails.
 */
export async function lockMiniToolExecutionTask(id: string, tx: DbTx): Promise<TaskEntity | null> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  return row ? toEntity(row) : null;
}

/**
 * Merge only the execution namespace and its optional computation transition.
 * @param id - The original task whose lock the caller retains.
 * @param record - Validated public execution state.
 * @param tx - The same transaction as media or consumption persistence.
 * @param ending - The computation transition; absent for expense-only updates.
 * @param ending.status - The terminal computation state.
 * @param ending.errorMessage - The original failure summary, or null for success.
 * @param ending.finish - Whether this transition first ends active computation.
 * @returns Nothing after the namespace has been committed to this transaction.
 * @throws {Error} When the original parent disappears or persistence fails.
 */
export async function storeMiniToolExecutionRecord(id: string, record: Record<string, unknown>, tx: DbTx, ending?: {
  status: "completed" | "failed"; errorMessage: string | null; finish: boolean;
}): Promise<void> {
  const patch = sql.param({ miniToolExecution: record }, tasks.result);
  const rows = await tx.update(tasks).set({
    result: sql`coalesce(${tasks.result}, '{}'::jsonb) || ${patch}`,
    updatedAt: sql`clock_timestamp()`,
    ...(ending === undefined ? {} : {
      status: ending.status, errorMessage: ending.errorMessage,
      completedAt: ending.finish ? sql`coalesce(${tasks.completedAt}, clock_timestamp())` : tasks.completedAt,
    }),
  }).where(eq(tasks.id, id)).returning({ id: tasks.id });
  if (rows.length !== 1) throw new Error("Planned execution parent disappeared");
}

/**
 * Claim one planned run before its adapter opens node rows, holds credits or queues it.
 * @param data - The authenticated owner and complete server-frozen execution.
 * @param data.id - The press-generated durable run UUID.
 * @param data.userId - The authenticated actor.
 * @param data.projectId - The project owning the result and consumption.
 * @param data.spaceId - Its canvas Space.
 * @param data.taskType - The planned output medium.
 * @param data.model - The internally selected model.
 * @param data.params - The complete immutable execution namespace.
 * @param data.result - Initial public output slots, when the lane initializes them at admission.
 * @param transaction - Retry arbitration transaction, when present.
 * @returns Whether this caller inserted the durable winner.
 * @throws {Error} When the database write fails.
 */
export async function claimMiniToolExecutionTask(data: {
  id: string; userId: string; projectId: string; spaceId: string;
  taskType: MiniToolMedium; model: string; params: Record<string, unknown>; result?: Record<string, unknown>;
}, transaction?: DbTx): Promise<boolean> {
  const rows = await (transaction ?? db).insert(tasks).values({
    ...data, mode: "append", source: "mini_tool",
  }).onConflictDoNothing({ target: tasks.id }).returning({ id: tasks.id });
  return rows.length === 1;
}

/**
 * The planned video tool runs the sweep looks at (frames-split §7.19): every running one, and every pending one that
 * never waited for a running slot and was created longer ago than the grace window, oldest first. A run's job id is its
 * task id (planned-run.ts).
 * @param limit - How many of each at most.
 * @param graceMs - How old a pending run must be, so a run still being opened and queued is left alone.
 * @returns The running and the pending run ids.
 * @throws {Error} When a read fails.
 */
export async function listPlannedRunsToSweep(limit: number, graceMs: number): Promise<{ running: string[]; pending: string[] }> {
  const planned = sql`${tasks.source} = 'mini_tool' AND ${tasks.params} ? 'miniToolExecution' AND ${tasks.deletedAt} IS NULL`;
  const running = await db.execute<{ id: string }>(sql`
    SELECT ${tasks.id} AS id FROM ${tasks} WHERE ${planned} AND ${tasks.status} = 'running'
    ORDER BY ${tasks.startedAt} ASC LIMIT ${limit}`);
  const pending = await db.execute<{ id: string }>(sql`
    SELECT ${tasks.id} AS id FROM ${tasks} WHERE ${planned} AND ${tasks.status} = 'pending' AND ${tasks.slotWaitSince} IS NULL
      AND ${tasks.createdAt} < now() - (${graceMs} * interval '1 millisecond')
    ORDER BY ${tasks.createdAt} ASC LIMIT ${limit}`);
  return { running: running.map((row) => row.id), pending: pending.map((row) => row.id) };
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
 * @param data.keyId - The account key row the media runs on; null or absent on our keys.
 * @param data.llmKeyId - The account key row of a language-model step inside the task; null or absent on our keys.
 * @param tx - Optional transaction shared with activity admission.
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
  /** The account key row the media runs on (inner#1953); null or absent on our keys. */
  keyId?: string | null;
  /** The account key row of a language-model step inside the task; null or absent on our keys. */
  llmKeyId?: string | null;
}, tx?: DbTx): Promise<TaskEntity> {
  const rows = await (tx ?? db)
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
      keyId: data.keyId ?? null,
      llmKeyId: data.llmKeyId ?? null,
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
 * @returns True when the row was written; false for a task waiting on its cost, which no status write touches.
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
): Promise<boolean> {
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

  const rows = await db.update(tasks).set(updates).where(and(eq(tasks.id, id), notWaitingOnCost())).returning({ id: tasks.id });
  return rows.length > 0;
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
 * Keep the cause of an attempt that failed while a retry is still to come
 * (inner#1968): the row stays running and keeps its slot.
 * @param id - The task.
 * @param error - The cause.
 * @returns True when written; false for a task waiting on its cost, which no status write touches.
 */
export async function recordAttemptError(id: string, error: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ errorMessage: error, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), notWaitingOnCost()))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * Mark a task running on a job and keep its first start.
 * @param id - UUID of the task.
 * @param jobId - The BullMQ job running it.
 * @param now - The start to keep when the row has none yet.
 * @param transaction - The analysis owner's transaction when the current state is locked.
 * @returns The start the row holds after the write.
 * @throws {Error} When the task row does not exist.
 */
export async function markRunning(id: string, jobId: string, now: Date, transaction?: DbTx): Promise<Date> {
  const [row] = await (transaction ?? db)
    .update(tasks)
    .set({
      arqJobId: jobId,
      status: "running",
      startedAt: sql`coalesce(${tasks.startedAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    // Only a row already running: a task first starts through the running-task
    // gate (inner#1968), and an ended row stays ended.
    .where(and(eq(tasks.id, id), eq(tasks.status, "running")))
    .returning({ startedAt: tasks.startedAt });
  if (!row?.startedAt) throw new Error(`task ${id} has no running row to mark running`);
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
 * CAS update: mark the task as completed AND set the billing guard in
 * a single atomic step. Returns `true` if this call was the one that
 * transitioned the task to completed (first winner), `false` if the
 * task was already completed by another Worker.
 *
 * The `billed_at` column is set here as the idempotency guard: only the
 * call that wins it records the task's charge request, in the same
 * transaction (inner#1617).
 * @param id - UUID of the task to mark completed.
 * @param result - Provider/tool result payload to persist on the task.
 * @param creditsUsed - Credits consumed; also written to the `billed_credits` guard column.
 * @param durationMs - Wall-clock duration of the task in milliseconds.
 * @param tx - The completion's transaction, which also records the charge request.
 * @returns `true` if this call performed the transition, `false` if already completed
 */
export async function markCompletedAndBill(
  id: string,
  result: Record<string, unknown>,
  creditsUsed: number,
  durationMs: number,
  tx: DbTx,
): Promise<boolean> {
  const now = new Date();
  const rows = await tx
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

/** What a task holds of its media run. */
export interface StoredTicket {
  /** provider's ticket, opaque here; null before the first one. */
  ticket: ({ version: number } & Record<string, unknown>) | null;
  /** When a send of it began, while one is in flight. */
  sendingAt: Date | null;
}

/**
 * The ticket a task holds and whether a send of it is in flight.
 * @param id - The task.
 * @returns What it holds; nothing for a missing row.
 */
export async function getProviderTicket(id: string): Promise<StoredTicket> {
  const [row] = await db
    .select({ ticket: tasks.providerTicket, sendingAt: tasks.providerSendingAt })
    .from(tasks)
    .where(eq(tasks.id, id));
  return { ticket: (row?.ticket as StoredTicket["ticket"] | undefined) ?? null, sendingAt: row?.sendingAt ?? null };
}

/**
 * Store a ticket over an older one: a run that kept an older ticket cannot write it back over a newer one.
 * @param id - The task.
 * @param ticket - provider's ticket.
 * @returns True when it was stored.
 */
export async function storeTicket(id: string, ticket: { version: number } & Record<string, unknown>): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ providerTicket: ticket, providerTicketVersion: ticket.version, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), sql`coalesce(${tasks.providerTicketVersion}, -1) < ${ticket.version}`))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * Mark a send of the stored ticket in flight, before the paid request goes out.
 * @param id - The task.
 */
export async function markSending(id: string): Promise<void> {
  await db.update(tasks).set({ providerSendingAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, id));
}

/**
 * Clear the mark of a send in flight, once its answer is stored.
 * @param id - The task.
 */
export async function clearSending(id: string): Promise<void> {
  await db.update(tasks).set({ providerSendingAt: null, updatedAt: new Date() }).where(eq(tasks.id, id));
}

/**
 * Complete a task whose cost is still being looked up: status, result and duration, `billed_at` left empty. The
 * result carries `costWait`, which marks the wait.
 * @param id - The task.
 * @param result - Its result, with `costWait` and the pending lookups.
 * @param durationMs - How long the run took from its first start.
 * @returns True for the call that completed it; false once it is completed and waiting, or billed.
 */
export async function markCompleted(id: string, result: Record<string, unknown>, durationMs: number): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(tasks)
    .set({ status: "completed", result, durationMs, completedAt: now, updatedAt: now })
    .where(and(eq(tasks.id, id), notWaitingOnCost(), isNull(tasks.billedAt)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * Write back what the lookups of a task waiting on its cost found.
 * @param id - The task.
 * @param result - Its result with the lookups' answers.
 * @returns True when written; false once it is billed.
 */
export async function updateCostWait(id: string, result: Record<string, unknown>): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ result, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), waitingOnCost()))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * CAS: bill a task completed earlier, setting the guard only the first call sets.
 * @param id - The task.
 * @param credits - What the run consumed.
 * @param tx - The billing's transaction, which also records the charge request.
 * @returns True for the call that billed it.
 */
export async function markBilled(id: string, credits: number, tx: DbTx): Promise<boolean> {
  const now = new Date();
  const rows = await tx
    .update(tasks)
    .set({ billedAt: now, billedCredits: credits, creditsUsed: credits, updatedAt: now })
    .where(and(eq(tasks.id, id), isNull(tasks.billedAt)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

// ─── The running-task gate (inner#1968, design 3.9) ─────────────────────────

/** A task as the running-task gate judges it. */
export interface GateTaskRow {
  id: string;
  userId: string;
  projectId: string | null;
  status: string;
  errorMessage: string | null;
  /** Full-precision text, so a comparison against another row's creation loses no microseconds. */
  createdAt: string;
  startedAt: Date | null;
  /** Whether a video mini-tool run's settlement period is open, which releases its credit hold (frames-split §7.19). */
  settling: boolean;
}

/**
 * Take one person's running-slot lock for the rest of the transaction, if nobody holds it.
 * @param userId - The person.
 * @param tx - The transaction that keeps it.
 * @returns Whether it was taken.
 */
export async function tryLockRunningSlots(userId: string, tx: DbTx): Promise<boolean> {
  const rows = await tx.execute<{ got: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${`running-tasks:${userId}`})) as got`);
  return rows[0]?.got === true;
}

/**
 * Wait for one person's running-slot lock and keep it for the rest of the transaction.
 * @param userId - The person.
 * @param tx - The transaction that keeps it.
 */
export async function lockRunningSlots(userId: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`running-tasks:${userId}`}))`);
}

/**
 * Read a task as the gate judges it.
 * @param id - The task.
 * @returns The row, or null when there is none.
 */
export async function findForGate(id: string): Promise<GateTaskRow | null> {
  const [row] = await db
    .select({
      id: tasks.id,
      userId: tasks.userId,
      projectId: tasks.projectId,
      status: tasks.status,
      errorMessage: tasks.errorMessage,
      createdAt: sql<string>`${tasks.createdAt}::text`,
      startedAt: tasks.startedAt,
      settling: sql<boolean>`coalesce(${tasks.result} ? 'settlement', false)`,
    })
    .from(tasks)
    .where(eq(tasks.id, id));
  return row ?? null;
}

/**
 * How many of a person's tasks run within their budget and the report grace.
 * @param userId - The person.
 * @param windowMs - The budget plus the grace: a row started longer ago holds no slot.
 * @param tx - The gate's transaction.
 * @returns The count.
 */
export async function countRunningForUser(userId: string, windowMs: number, tx: DbTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, "running"), sql`${tasks.startedAt} > now() - (${windowMs} * interval '1 millisecond')`));
  return row?.n ?? 0;
}

/**
 * How many of a person's tasks wait under the same limit, created before a given instant and judged recently.
 * @param userId - The person.
 * @param limit - The limit they wait under.
 * @param before - The instant, as full-precision text.
 * @param staleMs - A waiter not judged within this long is left out.
 * @param tx - The gate's transaction.
 * @returns The count.
 */
export async function countWaitingBefore(userId: string, limit: number, before: string, staleMs: number, tx: DbTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(
      eq(tasks.userId, userId),
      eq(tasks.status, "pending"),
      sql`${tasks.slotWaitSince} is not null`,
      eq(tasks.slotWaitLimit, limit),
      sql`${tasks.slotCheckedAt} > now() - (${staleMs} * interval '1 millisecond')`,
      sql`${tasks.createdAt} < ${before}::timestamptz`,
    ));
  return row?.n ?? 0;
}

/**
 * Note the gate's judgement of a pending task: the check time once it is older
 * than a third of the stale window, the limit when it changed. Writes nothing
 * when neither is due.
 * @param id - The task.
 * @param limit - The limit it was judged under.
 * @param staleMs - The stale window.
 * @param tx - The gate's transaction.
 */
export async function noteSlotCheck(id: string, limit: number, staleMs: number, tx: DbTx): Promise<void> {
  const due = sql`(${tasks.slotCheckedAt} is null or ${tasks.slotCheckedAt} < now() - (${staleMs / 3} * interval '1 millisecond'))`;
  await tx
    .update(tasks)
    .set({ slotCheckedAt: sql`case when ${due} then now() else ${tasks.slotCheckedAt} end`, slotWaitLimit: limit })
    .where(and(eq(tasks.id, id), eq(tasks.status, "pending"), sql`(${due} or ${tasks.slotWaitLimit} is distinct from ${limit})`));
}

/**
 * Whether a task is still pending, read in the gate's transaction under the
 * person's lock: another pickup may have started or ended it since this one
 * read it.
 * @param id - The task.
 * @param tx - The gate's transaction.
 * @returns True while it is pending.
 */
export async function isPending(id: string, tx: DbTx): Promise<boolean> {
  const [row] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, id));
  return row?.status === "pending";
}

/**
 * Mark a pending task as waiting for a slot, keeping the first moment it did,
 * and the job that judged it when the task has none recorded yet: that job is
 * the one that will pick it up again, and the stale-waiter sweep reads it.
 * @param id - The task.
 * @param jobId - The job judging it.
 * @param tx - The gate's transaction.
 */
export async function markSlotWait(id: string, jobId: string, tx: DbTx): Promise<void> {
  await tx
    .update(tasks)
    .set({ slotWaitSince: sql`now()`, arqJobId: sql`coalesce(${tasks.arqJobId}, ${jobId})` })
    .where(and(eq(tasks.id, id), eq(tasks.status, "pending"), isNull(tasks.slotWaitSince)));
}

/**
 * Start a pending task on a job: the gate's one write of a first start.
 * @param id - The task.
 * @param jobId - The job running it.
 * @param tx - The gate's transaction.
 * @returns Its start, or null when it was no longer pending.
 */
export async function startPending(id: string, jobId: string, tx: DbTx): Promise<Date | null> {
  const [row] = await tx
    .update(tasks)
    .set({ status: "running", arqJobId: jobId, startedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(tasks.id, id), eq(tasks.status, "pending")))
    .returning({ startedAt: tasks.startedAt });
  return row?.startedAt ?? null;
}

/**
 * Cancel a task that has not started.
 * @param id - The task.
 * @param tx - The cancel's transaction.
 * @returns True when this call cancelled it.
 */
export async function cancelPending(id: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .update(tasks)
    .set({ status: "cancelled", errorMessage: "cancelled", completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(tasks.id, id), eq(tasks.status, "pending")))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * Fail a task that has not ended, waiting or running.
 * @param id - The task.
 * @param error - The cause.
 * @param tx - The cleanup's transaction.
 * @returns True when this call failed it.
 */
export async function failOpen(id: string, error: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .update(tasks)
    .set({ status: "failed", errorMessage: error, completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(tasks.id, id), inArray(tasks.status, ["pending", "running"])))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * Waiting tasks the gate has not judged within the stale window, oldest check first.
 * @param staleMs - The stale window.
 * @param limit - How many at most.
 * @returns Each task, its owner and its job.
 */
export async function listStaleWaiters(staleMs: number, limit: number): Promise<Array<{ id: string; userId: string; arqJobId: string }>> {
  const rows = await db
    .select({ id: tasks.id, userId: tasks.userId, arqJobId: tasks.arqJobId })
    .from(tasks)
    .where(and(
      eq(tasks.status, "pending"),
      sql`${tasks.slotWaitSince} is not null`,
      // The gate records the judging job on its first wait.
      isNotNull(tasks.arqJobId),
      sql`${tasks.slotCheckedAt} < now() - (${staleMs} * interval '1 millisecond')`,
    ))
    .orderBy(tasks.slotCheckedAt)
    .limit(limit);
  return rows.flatMap(({ arqJobId, ...row }) => (arqJobId === null ? [] : [{ ...row, arqJobId }]));
}
