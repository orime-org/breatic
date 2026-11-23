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
