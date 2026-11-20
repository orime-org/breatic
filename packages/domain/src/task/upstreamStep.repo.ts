// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

/**
 * Where a step stands. A video mini-tool model step whose upstream answered is `submitted` with `output.providerReturn`
 * until its derived object is stored (returned, inner#1306 execution design §6.3).
 */
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

/** A model step's provider ticket and its send mark (inner#1306 execution design §11.2). */
export interface StoredStepTicket {
  ticket: ({ version: number } & Record<string, unknown>) | null;
  sendingAt: Date | null;
}

/**
 * The provider ticket a model step holds and whether a send of it is in flight.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param tx - The transaction, when one is open.
 * @returns What it holds; null when the task owns no such step.
 */
export async function getStepTicket(taskId: string, stepId: string, tx?: DbTx): Promise<StoredStepTicket | null> {
  const [row] = await (tx ?? db).select({ output: taskUpstreamSteps.output }).from(taskUpstreamSteps)
    .where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId)));
  if (row === undefined) return null;
  const output = (row.output ?? {}) as { providerTicket?: StoredStepTicket["ticket"]; providerSendingAt?: string };
  return { ticket: output.providerTicket ?? null, sendingAt: output.providerSendingAt === undefined ? null : new Date(output.providerSendingAt) };
}

/**
 * Store a model step's ticket over an older one: a run that kept an older ticket cannot write it back over a newer one.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param ticket - provider's ticket.
 * @returns True when stored, false when a ticket as new or newer is stored, null when the task owns no such step.
 */
export async function storeStepTicket(taskId: string, stepId: string, ticket: { version: number } & Record<string, unknown>): Promise<boolean | null> {
  const patch = sql.param({ providerTicket: ticket }, taskUpstreamSteps.output);
  const rows = await db.update(taskUpstreamSteps).set({
    output: sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${patch}`, updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId),
    sql`coalesce((${taskUpstreamSteps.output}->'providerTicket'->>'version')::int, -1) < ${ticket.version}`))
    .returning({ id: taskUpstreamSteps.id });
  if (rows.length > 0) return true;
  return (await getStepTicket(taskId, stepId)) === null ? null : false;
}

/**
 * Set or clear a model step's send mark; a send also records the upstream it goes to, which clearing keeps.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param send - The database instant of the send as text and its upstream, or null to clear the mark.
 * @param tx - The transaction, when one is open.
 * @returns Whether the task owns the step.
 */
export async function setStepSending(taskId: string, stepId: string, send: { at: string; upstream: string } | null, tx?: DbTx): Promise<boolean> {
  const output = send === null
    ? sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) - 'providerSendingAt'`
    : sql`coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) || ${sql.param({ providerSendingAt: send.at, providerUpstream: send.upstream }, taskUpstreamSteps.output)}`;
  const rows = await (tx ?? db).update(taskUpstreamSteps).set({
    output, ...(send === null ? {} : { status: sql`CASE WHEN ${taskUpstreamSteps.status} = 'pending' THEN 'submitted' ELSE ${taskUpstreamSteps.status} END` }),
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId))).returning({ id: taskUpstreamSteps.id });
  return rows.length === 1;
}

/**
 * Append the costs a model step's run handed over on a throw, before the step ends.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param costs - The costs, as JSON.
 * @param tx - The transaction holding the task lock.
 * @throws {Error} When the task owns no such step.
 */
export async function appendStepDeliveredCosts(taskId: string, stepId: string, costs: unknown[], tx: DbTx): Promise<void> {
  const rows = await tx.update(taskUpstreamSteps).set({
    output: sql`jsonb_set(coalesce(${taskUpstreamSteps.output}, '{}'::jsonb), '{deliveredCosts}',
      coalesce(${taskUpstreamSteps.output}->'deliveredCosts', '[]'::jsonb) || ${sql.param(costs, taskUpstreamSteps.output)})`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId))).returning({ id: taskUpstreamSteps.id });
  if (rows.length !== 1) throw new Error("Model step no longer belongs to its task");
}

/**
 * Write a model step's end: its status and output fields, its send mark cleared.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param status - `submitted` for a step whose upstream returned (its `providerReturn` in the patch), or `failed`.
 * @param patch - The output fields the end writes.
 * @param tx - The transaction holding the task lock.
 * @throws {Error} When the task owns no such step.
 */
export async function storeStepEnd(taskId: string, stepId: string, status: "submitted" | "failed", patch: Record<string, unknown>, tx: DbTx): Promise<void> {
  const rows = await tx.update(taskUpstreamSteps).set({
    status, output: sql`(coalesce(${taskUpstreamSteps.output}, '{}'::jsonb) - 'providerSendingAt') || ${sql.param(patch, taskUpstreamSteps.output)}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId))).returning({ id: taskUpstreamSteps.id });
  if (rows.length !== 1) throw new Error("Model step no longer belongs to its task");
}

/**
 * Count one send of a model step the upstream did not take.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @returns How many sends of it the upstream has not taken.
 * @throws {Error} When the task owns no such step.
 */
export async function countStepSendNotAccepted(taskId: string, stepId: string): Promise<number> {
  const [row] = await db.update(taskUpstreamSteps).set({
    output: sql`jsonb_set(coalesce(${taskUpstreamSteps.output}, '{}'::jsonb), '{sendNotAccepted}',
      to_jsonb(coalesce((${taskUpstreamSteps.output}->>'sendNotAccepted')::int, 0) + 1))`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(taskUpstreamSteps.taskId, taskId), eq(taskUpstreamSteps.id, stepId)))
    .returning({ count: sql<number>`(${taskUpstreamSteps.output}->>'sendNotAccepted')::int` });
  if (row === undefined) throw new Error("Model step no longer belongs to its task");
  return Number(row.count);
}
