// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Upstream step repository — data access for `task_upstream_steps` (#2156).
 *
 * One row per upstream call a task makes, in order. The worker writes the
 * list on the task's first run and advances each step
 * pending -> submitted -> done | failed.
 */

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, taskUpstreamSteps } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { MiniToolConsumptionRecord } from "@domain/mini-tool/consumption.types.js";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import type { MiniToolStepState } from "@domain/mini-tool/upstream-step.types.js";

/** What a step does; decides what the executor reads off its answer. */
export type UpstreamStepKind =
  | "upload_reference"
  | "upload_melody"
  | "vocal"
  | "voice"
  | "element"
  | "generate"
  | "speak"
  | "rig"
  | "container_job";

/** Where a step stands. */
export type UpstreamStepStatus = "pending" | "submitted" | "done" | "failed";

/** One step as the worker plans it. */
export interface PlannedStep {
  kind: UpstreamStepKind;
  endpoint: string;
  itemIndex: number | null;
}

/** One step as stored. */
export interface UpstreamStep extends PlannedStep {
  id: string;
  position: number;
  status: UpstreamStepStatus;
  predictionId: string | null;
  output: Record<string, unknown>;
  inlineCostUsd: number;
}

/**
 * Convert a row to a step.
 * @param row - The stored row.
 * @returns The step.
 */
function toStep(row: typeof taskUpstreamSteps.$inferSelect): UpstreamStep {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind as UpstreamStepKind,
    endpoint: row.endpoint,
    itemIndex: row.itemIndex,
    status: row.status as UpstreamStepStatus,
    predictionId: row.predictionId,
    output: row.output ?? {},
    inlineCostUsd: row.inlineCostUsd,
  };
}

/**
 * Re-read a step only after its parent task's consumption lock is held.
 * @param taskId - The immutable owning task.
 * @param stepId - The immutable step identity.
 * @param tx - The transaction holding that task's row lock.
 * @returns The current owned step, or null when it does not belong to the task.
 * @throws {Error} When the database read fails.
 */
export async function getStepForConsumption(taskId: string, stepId: string, tx: DbTx): Promise<UpstreamStep | null> {
  const [row] = await tx.select().from(taskUpstreamSteps)
    .where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId)));
  return row ? toStep(row) : null;
}

/**
 * Merge only the consumption fact, preserving concurrent execution output fields.
 * @param taskId - The owning task whose row lock is held.
 * @param stepId - The step to update.
 * @param consumption - The validated recorded consumption.
 * @param tx - The transaction that already wrote this consumption's usage.
 * @returns Nothing.
 * @throws {Error} When the step vanished or its write fails.
 */
export async function storeMiniToolConsumption(
  taskId: string, stepId: string, consumption: MiniToolConsumptionRecord, tx: DbTx,
): Promise<void> {
  const patch = sql.param({ miniToolConsumption: consumption }, taskUpstreamSteps.output);
  const rows = await tx.update(taskUpstreamSteps).set({
    output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${patch}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId)))
    .returning({ id: taskUpstreamSteps.id });
  if (rows.length !== 1) throw new Error("Consumption step no longer belongs to its task");
}

/**
 * Freeze the complete planned request in its owning step before submission.
 * @param taskId - The immutable parent whose row lock is held.
 * @param stepId - The parent-owned container step.
 * @param request - The first validated indexed job request.
 * @param tx - The transaction that also stores its pending consumption and period.
 * @returns Nothing.
 * @throws {Error} When the step disappeared or persistence fails.
 */
export async function storeMiniToolPlanJob(taskId: string, stepId: string, request: MiniToolPlanJobRequest, tx: DbTx): Promise<void> {
  const patch = sql.param({ miniToolPlanJob: request }, taskUpstreamSteps.output);
  const rows = await tx.update(taskUpstreamSteps).set({
    output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${patch}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId)))
    .returning({ id: taskUpstreamSteps.id });
  if (rows.length !== 1) throw new Error("Planned job step no longer belongs to its task");
}

/**
 * A task's steps in order.
 * @param taskId - The task.
 * @param tx - An enclosing transaction when consumption state must be current.
 * @returns Its steps, by position.
 * @throws {Error} When the database read fails.
 */
export async function listSteps(taskId: string, tx?: DbTx): Promise<UpstreamStep[]> {
  const rows = await (tx ?? db)
    .select()
    .from(taskUpstreamSteps)
    .where(eq(taskUpstreamSteps.taskId, taskId))
    .orderBy(asc(taskUpstreamSteps.position));
  return rows.map(toStep);
}

/**
 * Insert missing step positions and answer the stored list. Existing positions
 * retain their original descriptors; callers extending a plan carry that stored
 * prefix before appending newly discovered steps.
 * @param taskId - The task.
 * @param plan - The steps in order.
 * @returns The stored steps, by position.
 * @throws {Error} When step persistence or reading fails.
 */
export async function ensureSteps(taskId: string, plan: readonly PlannedStep[]): Promise<UpstreamStep[]> {
  if (plan.length > 0) {
    await db
      .insert(taskUpstreamSteps)
      .values(plan.map((step, position) => ({ taskId, position, ...step })))
      .onConflictDoNothing({ target: [taskUpstreamSteps.taskId, taskUpstreamSteps.position] });
  }
  return listSteps(taskId);
}

/**
 * Record what a step learned before it is submitted, and what that cost
 * outside its prediction — the element's description and its understand call.
 * @param stepId - The step.
 * @param output - Fields merged into the step's output.
 * @param costUsd - Added to the step's inline cost.
 * @returns Nothing.
 */
export async function recordInline(
  stepId: string,
  output: Record<string, unknown>,
  costUsd: number,
): Promise<void> {
  await db
    .update(taskUpstreamSteps)
    .set({
      output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${JSON.stringify(output)}::jsonb`,
      inlineCostUsd: sql`${taskUpstreamSteps.inlineCostUsd} + ${costUsd}`,
    })
    .where(eq(taskUpstreamSteps.id, stepId));
}

/**
 * Record that a step finished, with what it answered.
 * @param stepId - The step.
 * @param output - Fields merged into the step's output.
 * @returns Nothing.
 */
export async function markDone(stepId: string, output: Record<string, unknown>): Promise<void> {
  await db
    .update(taskUpstreamSteps)
    .set({
      status: "done",
      output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${JSON.stringify(output)}::jsonb`,
    })
    .where(eq(taskUpstreamSteps.id, stepId));
}

/**
 * The columns a failed step is written with: its status, and the reason
 * beside whatever it already learned.
 * @param reason - Why it failed.
 * @returns The update's set clause.
 */
function failedWith(reason: string): { status: "failed"; output: SQL } {
  return {
    status: "failed",
    output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${JSON.stringify({ error: reason })}::jsonb`,
  };
}

/**
 * Record that the upstream failed a step, and its own words for why: a
 * redelivered task answers with them rather than retrying the step.
 * @param stepId - The step.
 * @param reason - The upstream's reason.
 * @returns Nothing.
 */
export async function markFailed(stepId: string, reason: string): Promise<void> {
  await db
    .update(taskUpstreamSteps)
    .set(failedWith(reason))
    .where(eq(taskUpstreamSteps.id, stepId));
}

/**
 * Fail every step of a task still pending or submitted, with the task's own
 * reason: the task has failed for good and none of them will run again.
 * @param taskId - The task.
 * @param reason - Why the task failed.
 * @returns Nothing.
 */
export async function failOpenSteps(taskId: string, reason: string): Promise<void> {
  await db
    .update(taskUpstreamSteps)
    .set(failedWith(reason))
    .where(and(eq(taskUpstreamSteps.taskId, taskId), inArray(taskUpstreamSteps.status, ["pending", "submitted"])));
}


/**
 * Merge only planned execution facts after the caller locks the immutable parent.
 * @param taskId - The task whose lock serializes result and consumption writers.
 * @param stepId - The step belonging to that task.
 * @param execution - The operation-owned state, without fee or complete-plan patches.
 * @param columns - Only the step status and canonical provider identity may also change.
 * @param columns.status - The monotonic execution state, when it changes.
 * @param columns.predictionId - The first canonical provider identity, when newly received.
 * @param tx - The same transaction used by the identity and consumption producer.
 * @returns Nothing after exactly one owned row was written.
 * @throws {Error} When the row disappeared, belongs elsewhere or SQL fails.
 */
export async function storeMiniToolStepExecution(
  taskId: string, stepId: string, execution: MiniToolStepState,
  columns: { status?: UpstreamStepStatus; predictionId?: string }, tx: DbTx,
): Promise<void> {
  const patch = sql.param({ miniToolStep: execution }, taskUpstreamSteps.output);
  const rows = await tx.update(taskUpstreamSteps).set({
    ...columns, output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${patch}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId)))
    .returning({ id: taskUpstreamSteps.id });
  if (rows.length !== 1) throw new Error("Planned execution step no longer belongs to its task");
}
