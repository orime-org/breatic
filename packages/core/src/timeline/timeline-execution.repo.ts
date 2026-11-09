// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Data access for `timeline_executions` (inner#1711).
 *
 * {@link transition} is the one writer of `status`: each event is one
 * conditional `UPDATE ... RETURNING`, so a lost race or a stale attempt is
 * answered with the current row and `applied: false` instead of a write.
 */

import { and, asc, desc, eq, inArray, isNull, lte, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { TimelineExecution, TimelineExecutionStatus } from "@breatic/shared";
import { db, type DbTx } from "@core/db/client.js";
import { timelineExecutions as t } from "@core/db/schema.js";

/** What a caller sends to move an execution; the matrix in the design decides what each does in each state. */
export type TimelineExecutionEvent =
  | { type: "land"; inputHash: string }
  | { type: "claim" }
  | { type: "retry" }
  | { type: "success"; fence: string | null; resultSourceVersionId: string }
  | { type: "failure"; fence: string | null; reason: string }
  | { type: "cancel" }
  | { type: "cancelAck" }
  | { type: "deadline" }
  | { type: "progress"; fence: string | null; phase: NonNullable<TimelineExecution["phase"]> };

/** The fields an accepted execution is inserted with. */
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
}

/** The outcome of one {@link transition} call. */
export interface TimelineExecutionTransition {
  /** True when this call wrote the row. */
  applied: boolean;
  /** The row after the call. */
  row: TimelineExecution;
}

const OPEN: readonly TimelineExecutionStatus[] = ["awaiting_landing", "queued", "running", "cancelling"];

/**
 * Render a timestamp as UTC ISO text at the microsecond precision the column stores.
 * @param column - The timestamp column.
 * @returns The SQL expression.
 * @throws {never} Never.
 */
function iso<T extends string | null = string>(column: PgColumn): SQL<T> {
  return sql<T>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const columns = {
  id: t.id,
  projectId: t.projectId,
  spaceId: t.spaceId,
  actorUserId: t.actorUserId,
  kind: t.kind,
  actionId: t.actionId,
  input: t.input,
  inputHash: t.inputHash,
  engine: t.engine,
  status: t.status,
  phase: t.phase,
  steps: t.steps,
  attempt: t.attempt,
  fence: t.fence,
  deadlineAt: iso(t.deadlineAt),
  resultSourceVersionId: t.resultSourceVersionId,
  failureReason: t.failureReason,
  billedCredits: t.billedCredits,
  billedAt: iso<string | null>(t.billedAt),
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
};

/** A selected row before its text columns are narrowed to the entity's unions. */
type Row = Omit<TimelineExecution, "kind" | "engine" | "status" | "phase"> & {
  kind: string;
  engine: string;
  status: string;
  phase: string | null;
};

/**
 * Map a selected row to the entity.
 * @param row - The selected columns.
 * @returns The entity.
 * @throws {never} Never.
 */
function toEntity(row: Row): TimelineExecution {
  return {
    ...row,
    kind: row.kind as TimelineExecution["kind"],
    engine: row.engine as TimelineExecution["engine"],
    status: row.status as TimelineExecutionStatus,
    phase: row.phase as TimelineExecution["phase"],
  };
}

/**
 * Record an accepted execution, waiting for its landing receipt.
 * @param input - The execution.
 * @param tx - The transaction to write in.
 * @returns The row, or null when the Project and Space already hold a live execution with this action id.
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
    case "land":
      return {
        where: and(eq(t.status, "awaiting_landing"), eq(t.inputHash, event.inputHash), gt(t.deadlineAt, sql`now()`)),
        // The sweep adds the job again if the enqueue right after this is lost.
        set: { status: "queued" },
      };
    case "claim":
      return { where: eq(t.status, "queued"), set: { status: "running", ...newAttempt } };
    case "retry":
      return { where: eq(t.status, "running"), set: newAttempt };
    case "success":
      return {
        where: fenced(event.fence),
        set: {
          status: sql`CASE WHEN ${t.status} = 'running' THEN 'succeeded' ELSE 'cancelled' END`,
          resultSourceVersionId: sql`CASE WHEN ${t.status} = 'running' THEN ${event.resultSourceVersionId}::uuid END`,
          fence: null,
        },
      };
    case "failure":
      return {
        // A queued row has no attempt yet: only a fenceless failure (enqueue failed) ends it.
        where: event.fence === null ? eq(t.status, "queued") : fenced(event.fence),
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
      return { where: and(inArray(t.status, OPEN), lte(t.deadlineAt, sql`now()`)), set: { status: "expired", fence: null } };
    case "progress":
      return { where: and(eq(t.status, "running"), event.fence === null ? sql`false` : eq(t.fence, event.fence)), set: { phase: event.phase } };
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
 * List a Space's executions in its own Project, newest first.
 * @param key - The Space.
 * @param key.projectId - Its Project.
 * @param key.spaceId - The Space.
 * @param key.status - Only rows in this status; every status when omitted.
 * @param tx - The transaction to read in.
 * @returns The rows.
 * @throws {Error} When the read fails.
 */
export async function listForSpace(
  key: { projectId: string; spaceId: string; status?: TimelineExecutionStatus },
  tx?: DbTx,
): Promise<TimelineExecution[]> {
  const rows = await (tx ?? db)
    .select(columns)
    .from(t)
    .where(and(
      eq(t.projectId, key.projectId),
      eq(t.spaceId, key.spaceId),
      key.status === undefined ? undefined : eq(t.status, key.status),
      isNull(t.deletedAt),
    ))
    .orderBy(desc(t.createdAt), desc(t.id));
  return rows.map(toEntity);
}

/**
 * List executions that have not reached a terminal state, oldest first, for the worker sweep.
 * @param options - The page.
 * @param options.limit - The most rows to return.
 * @param tx - The transaction to read in.
 * @returns The rows.
 * @throws {Error} When the read fails.
 */
export async function listForSweep(options: { limit: number }, tx?: DbTx): Promise<TimelineExecution[]> {
  const rows = await (tx ?? db)
    .select(columns)
    .from(t)
    .where(and(inArray(t.status, OPEN), isNull(t.deletedAt)))
    .orderBy(asc(t.createdAt))
    .limit(options.limit);
  return rows.map(toEntity);
}
