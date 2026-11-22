// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data access for `timeline_executions` (inner#1711, #1490): web-animation creates, modifications and exports.
 *
 * {@link transition} is the one writer of `status`: each event is one
 * conditional `UPDATE ... RETURNING`, so a lost race or a stale attempt is
 * answered with the current row and `applied: false` instead of a write.
 */

import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { TimelineExecution, TimelineExecutionStatus } from "@breatic/shared";
import { WEB_ANIMATION_OPEN_STATUSES } from "@breatic/shared/space-content";
import { db, getWorkerConfig, timelineExecutions as t, type DbTx } from "@breatic/core";

/** What a caller sends to move an execution; the matrix in the design decides what each does in each state. */
export type TimelineExecutionEvent =
  /** `budgetMs`: an execution that waited for a running slot counts its deadline from this claim (inner#1968). */
  | { type: "claim"; budgetMs?: number }
  | { type: "retry" }
  | { type: "success"; fence: string | null; resultSourceVersionId: string }
  | { type: "success"; fence: string | null; resultAssetId: string }
  | { type: "failure"; fence: string | null; reason: string }
  | { type: "cancel" }
  | { type: "cancelAck" }
  | { type: "deadline" }
  /** `progress`: a running export's render as a whole percent; null in a phase that has none. */
  | { type: "progress"; fence: string | null; phase: NonNullable<TimelineExecution["phase"]>; progress?: number | null };

/** The fields an accepted execution is inserted with; `status` starts at the column's default, `queued`. */
export interface NewTimelineExecution {
  projectId: string;
  spaceId: string;
  actorUserId: string;
  kind: TimelineExecution["kind"];
  engine: TimelineExecution["engine"];
  actionId: string;
  input: Record<string, unknown>;
  inputHash: string;
  deadlineAt: Date;
  origin: TimelineExecution["origin"];
}

/** The outcome of one {@link transition} call. */
export interface TimelineExecutionTransition {
  /** True when this call wrote the row. */
  applied: boolean;
  /** The row after the call. */
  row: TimelineExecution;
}

/**
 * Render a timestamp as UTC ISO text at the microsecond precision the column stores.
 * @param column - The timestamp column.
 * @returns The SQL expression.
 * @throws {never} Never.
 */
function iso<T extends string | null = string>(column: PgColumn): SQL<T> {
  return sql<T>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The columns an execution is read with; a repository that joins the table selects these and maps them with {@link toEntity}. */
export const columns = {
  id: t.id,
  projectId: t.projectId,
  spaceId: t.spaceId,
  actorUserId: t.actorUserId,
  kind: t.kind,
  origin: t.origin,
  actionId: t.actionId,
  input: t.input,
  inputHash: t.inputHash,
  engine: t.engine,
  status: t.status,
  phase: t.phase,
  progress: t.progress,
  steps: t.steps,
  attempt: t.attempt,
  fence: t.fence,
  deadlineAt: iso(t.deadlineAt),
  resultSourceVersionId: t.resultSourceVersionId,
  resultAssetId: t.resultAssetId,
  failureReason: t.failureReason,
  billedCredits: t.billedCredits,
  billedAt: iso<string | null>(t.billedAt),
  slotWaitSince: iso<string | null>(t.slotWaitSince),
  slotWaitLimit: t.slotWaitLimit,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
};

/** A selected row before its text columns are narrowed to the entity's unions. */
export type Row = Omit<TimelineExecution, "kind" | "origin" | "engine" | "status" | "phase"> & {
  kind: string;
  origin: string;
  engine: string | null;
  status: string;
  phase: string | null;
};

/**
 * Map a selected row to the entity.
 * @param row - The selected columns.
 * @returns The entity.
 * @throws {never} Never.
 */
export function toEntity(row: Row): TimelineExecution {
  return {
    ...row,
    kind: row.kind as TimelineExecution["kind"],
    origin: row.origin as TimelineExecution["origin"],
    engine: row.engine as TimelineExecution["engine"],
    status: row.status as TimelineExecutionStatus,
    phase: row.phase as TimelineExecution["phase"],
  };
}

/**
 * Record an accepted execution, queued.
 * @param input - The execution.
 * @param tx - The transaction to write in.
 * @returns The row, or null when it would break a live unique index: an execution with this action id in the Project
 *   and Space, or a live export of the same source in the Space.
 * @throws {Error} When the write fails.
 */
export async function insert(input: NewTimelineExecution, tx?: DbTx): Promise<TimelineExecution | null> {
  const [row] = await (tx ?? db).insert(t).values(input).onConflictDoNothing().returning(columns);
  return row === undefined ? null : toEntity(row);
}

/**
 * Read a live execution.
 * @param id - The execution.
 * @param tx - The transaction to read in.
 * @returns The row, or undefined when there is none.
 * @throws {Error} When the read fails.
 */
export async function findById(id: string, tx?: DbTx): Promise<TimelineExecution | undefined> {
  const [row] = await (tx ?? db).select(columns).from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  return row === undefined ? undefined : toEntity(row);
}

/**
 * Read live executions.
 * @param ids - The executions.
 * @param tx - The transaction to read in.
 * @returns The ones that exist, in no particular order.
 * @throws {Error} When the read fails.
 */
export async function findByIds(ids: readonly string[], tx?: DbTx): Promise<TimelineExecution[]> {
  if (ids.length === 0) return [];
  const rows = await (tx ?? db).select(columns).from(t).where(and(inArray(t.id, [...ids]), isNull(t.deletedAt)));
  return rows.map(toEntity);
}

/**
 * Read the live execution an action created.
 * @param key - The action.
 * @param key.projectId - Its Project.
 * @param key.spaceId - Its Space.
 * @param key.actionId - Its idempotency key.
 * @param tx - The transaction to read in.
 * @returns The row, or undefined when there is none.
 * @throws {Error} When the read fails.
 */
export async function findByAction(
  key: { projectId: string; spaceId: string; actionId: string },
  tx?: DbTx,
): Promise<TimelineExecution | undefined> {
  const [row] = await (tx ?? db)
    .select(columns)
    .from(t)
    .where(and(eq(t.projectId, key.projectId), eq(t.spaceId, key.spaceId), eq(t.actionId, key.actionId), isNull(t.deletedAt)))
    .limit(1);
  return row === undefined ? undefined : toEntity(row);
}

/**
 * The guard for an attempt's report: the row is running or cancelling and still held by that attempt.
 * @param fence - The attempt's fence; null matches nothing.
 * @returns The guard.
 * @throws {never} Never.
 */
function fenced(fence: string | null): SQL | undefined {
  return fence === null ? sql`false` : and(inArray(t.status, ["running", "cancelling"]), eq(t.fence, fence));
}

/**
 * The condition the row must meet and the columns the event writes.
 * @param event - The event.
 * @returns The guard and the assignments.
 * @throws {never} Never.
 */
function plan(event: TimelineExecutionEvent): { where: SQL | undefined; set: PgUpdateSetSource<typeof t> } {
  const newAttempt = { attempt: sql`${t.attempt} + 1`, fence: sql`gen_random_uuid()` };
  switch (event.type) {
    case "claim":
      return {
        where: eq(t.status, "queued"),
        set: {
          status: "running",
          ...newAttempt,
          ...(event.budgetMs !== undefined && {
            deadlineAt: sql`CASE WHEN ${t.slotWaitSince} IS NOT NULL THEN now() + (${event.budgetMs} * interval '1 millisecond') ELSE ${t.deadlineAt} END`,
          }),
        },
      };
    case "retry":
      return { where: eq(t.status, "running"), set: newAttempt };
    case "success":
      return {
        where: fenced(event.fence),
        set: {
          status: sql`CASE WHEN ${t.status} = 'running' THEN 'succeeded' ELSE 'cancelled' END`,
          ...("resultAssetId" in event
            ? { resultAssetId: sql`CASE WHEN ${t.status} = 'running' THEN ${event.resultAssetId}::uuid END` }
            : { resultSourceVersionId: sql`CASE WHEN ${t.status} = 'running' THEN ${event.resultSourceVersionId}::uuid END` }),
          fence: null,
        },
      };
    case "failure":
      return {
        where: fenced(event.fence),
        set: {
          status: sql`CASE WHEN ${t.status} = 'cancelling' THEN 'cancelled' ELSE 'failed' END`,
          failureReason: sql`CASE WHEN ${t.status} = 'cancelling' THEN ${t.failureReason} ELSE ${event.reason} END`,
          fence: null,
        },
      };
    case "cancel":
      // A running attempt keeps its fence until it acknowledges the cancel.
      return {
        where: inArray(t.status, ["awaiting_landing", "queued", "running"]),
        set: { status: sql`CASE WHEN ${t.status} = 'running' THEN 'cancelling' ELSE 'cancelled' END` },
      };
    case "cancelAck":
      return { where: eq(t.status, "cancelling"), set: { status: "cancelled", fence: null } };
    case "deadline":
      // A queued row waiting for a running slot has no deadline yet (inner#1968).
      return {
        where: and(inArray(t.status, WEB_ANIMATION_OPEN_STATUSES), lte(t.deadlineAt, sql`now()`), sql`NOT (${t.status} = 'queued' AND ${t.slotWaitSince} IS NOT NULL)`),
        set: { status: "expired", fence: null },
      };
    case "progress":
      return { where: and(eq(t.status, "running"), event.fence === null ? sql`false` : eq(t.fence, event.fence)), set: { phase: event.phase, progress: event.progress ?? null } };
  }
}

/**
 * Apply one event to an execution with a single conditional update.
 * @param input - The call.
 * @param input.id - The execution.
 * @param input.event - The event.
 * @param tx - The transaction to write in.
 * @returns Whether this call wrote the row, and the row as it now stands.
 * @throws {Error} When the execution does not exist, or the write fails.
 */
export async function transition(
  input: { id: string; event: TimelineExecutionEvent },
  tx?: DbTx,
): Promise<TimelineExecutionTransition> {
  const executor = tx ?? db;
  const { where, set } = plan(input.event);
  const [updated] = await executor
    .update(t)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(eq(t.id, input.id), isNull(t.deletedAt), where))
    .returning(columns);
  if (updated !== undefined) return { applied: true, row: toEntity(updated) };
  const current = await findById(input.id, tx);
  if (current === undefined) throw new Error(`Timeline execution ${input.id} does not exist`);
  return { applied: false, row: current };
}

/**
 * Replace what an attempt reports about its run: the container job it submits under, then the runtime's own steps.
 * @param input - The write.
 * @param input.id - The execution.
 * @param input.fence - The attempt; only the attempt holding the row may write.
 * @param input.steps - The whole list.
 * @param tx - The transaction to write in.
 * @returns True when the row was written; false when the attempt no longer holds it.
 * @throws {Error} When the write fails.
 */
export async function recordSteps(input: { id: string; fence: string | null; steps: unknown[] }, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db)
    .update(t)
    .set({ steps: input.steps, updatedAt: sql`now()` })
    .where(and(eq(t.id, input.id), isNull(t.deletedAt), fenced(input.fence)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/**
 * Mark an execution billed, at most once.
 * @param id - The execution.
 * @param credits - The credits charged, as numeric text.
 * @param tx - The transaction to write in.
 * @returns True when this call set `billed_at`; false when it was already set.
 * @throws {Error} When the write fails.
 */
export async function markBilled(id: string, credits: string, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db)
    .update(t)
    .set({ billedAt: sql`now()`, billedCredits: credits, updatedAt: sql`now()` })
    .where(and(eq(t.id, id), isNull(t.deletedAt), isNull(t.billedAt)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/**
 * List one page of the executions that have not reached a terminal state, by id, for the worker sweep, which pages
 * through all of them so no row waits behind a full batch of others. A queued execution the running-task gate judged
 * within the stale window is left out, so waiters do not fill the page (inner#1968).
 * @param options - The page.
 * @param options.limit - The most rows to return.
 * @param options.afterId - The last id of the previous page; the first page when omitted.
 * @param tx - The transaction to read in.
 * @returns The rows.
 * @throws {Error} When the read fails.
 */
export async function listForSweep(options: { limit: number; afterId?: string }, tx?: DbTx): Promise<TimelineExecution[]> {
  const staleMs = getWorkerConfig().slot_wait_stale_ms;
  const rows = await (tx ?? db)
    .select(columns)
    .from(t)
    .where(and(
      inArray(t.status, WEB_ANIMATION_OPEN_STATUSES),
      isNull(t.deletedAt),
      options.afterId === undefined ? undefined : gt(t.id, options.afterId),
      sql`NOT (${t.status} = 'queued' AND ${t.slotWaitSince} IS NOT NULL AND ${t.slotCheckedAt} > now() - (${staleMs} * interval '1 millisecond'))`,
    ))
    .orderBy(asc(t.id))
    .limit(options.limit);
  return rows.map(toEntity);
}

// ─── The running-task gate (inner#1968, design 3.9) ─────────────────────────

/**
 * How many of a person's executions run within their deadline and the report grace.
 * @param actorUserId - The person.
 * @param graceMs - The grace past the deadline.
 * @param tx - The gate's transaction.
 * @returns The count.
 * @throws {Error} When the read fails.
 */
export async function countRunningForActor(actorUserId: string, graceMs: number, tx: DbTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.actorUserId, actorUserId), inArray(t.status, ["running", "cancelling"]), isNull(t.deletedAt), sql`${t.deadlineAt} > now() - (${graceMs} * interval '1 millisecond')`));
  return row?.n ?? 0;
}

/**
 * How many of a person's executions wait under the same limit, created before an instant and judged recently.
 * @param actorUserId - The person.
 * @param limit - The limit they wait under.
 * @param before - The instant, as full-precision text.
 * @param staleMs - A waiter not judged within this long is left out.
 * @param tx - The gate's transaction.
 * @returns The count.
 * @throws {Error} When the read fails.
 */
export async function countWaitingBefore(actorUserId: string, limit: number, before: string, staleMs: number, tx: DbTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(
      eq(t.actorUserId, actorUserId),
      eq(t.status, "queued"),
      isNull(t.deletedAt),
      sql`${t.slotWaitSince} IS NOT NULL`,
      eq(t.slotWaitLimit, limit),
      sql`${t.slotCheckedAt} > now() - (${staleMs} * interval '1 millisecond')`,
      sql`${t.createdAt} < ${before}::timestamptz`,
    ));
  return row?.n ?? 0;
}

/**
 * Note the gate's judgement of a queued execution: the check time once older than a third of the stale window, the
 * limit when it changed; nothing when neither is due.
 * @param id - The execution.
 * @param limit - The limit it was judged under.
 * @param staleMs - The stale window.
 * @param tx - The gate's transaction.
 * @returns Nothing.
 * @throws {Error} When the write fails.
 */
export async function noteSlotCheck(id: string, limit: number, staleMs: number, tx: DbTx): Promise<void> {
  const due = sql`(${t.slotCheckedAt} IS NULL OR ${t.slotCheckedAt} < now() - (${staleMs / 3} * interval '1 millisecond'))`;
  await tx
    .update(t)
    .set({ slotCheckedAt: sql`CASE WHEN ${due} THEN now() ELSE ${t.slotCheckedAt} END`, slotWaitLimit: limit })
    .where(and(eq(t.id, id), eq(t.status, "queued"), sql`(${due} OR ${t.slotWaitLimit} IS DISTINCT FROM ${limit})`));
}

/**
 * Mark a queued execution as waiting for a running slot, keeping the first moment it did.
 * @param id - The execution.
 * @param tx - The gate's transaction.
 * @returns True when this is its first wait.
 * @throws {Error} When the write fails.
 */
export async function markSlotWait(id: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .update(t)
    .set({ slotWaitSince: sql`now()` })
    .where(and(eq(t.id, id), eq(t.status, "queued"), isNull(t.slotWaitSince)))
    .returning({ id: t.id });
  return rows.length > 0;
}
