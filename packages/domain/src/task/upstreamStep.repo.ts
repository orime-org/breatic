// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upstream step repository — data access for `task_upstream_steps` (#2156).
 *
 * One row per upstream call a task makes, in order. The worker writes the
 * list on the task's first run and advances each step
 * pending -> submitted -> done | failed.
 */

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, taskUpstreamSteps } from "@breatic/core";

/** What a step does; decides what the executor reads off its answer. */
export type UpstreamStepKind =
  | "upload_reference"
  | "upload_melody"
  | "vocal"
  | "voice"
  | "element"
  | "generate"
  | "speak";

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
 * A task's steps in order.
 * @param taskId - The task.
 * @returns Its steps, by position.
 */
export async function listSteps(taskId: string): Promise<UpstreamStep[]> {
  const rows = await db
    .select()
    .from(taskUpstreamSteps)
    .where(eq(taskUpstreamSteps.taskId, taskId))
    .orderBy(asc(taskUpstreamSteps.position));
  return rows.map(toStep);
}

/**
 * Write a task's steps on its first run and answer what is stored. A task
 * that already has steps keeps them: a redelivered job resumes the list it
 * started with, whatever plan it would draw now.
 * @param taskId - The task.
 * @param plan - The steps in order.
 * @returns The stored steps, by position.
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
 * Record that a step was submitted, before it is polled.
 * @param stepId - The step.
 * @param predictionId - The WaveSpeed prediction id.
 * @returns Nothing.
 */
export async function markSubmitted(stepId: string, predictionId: string): Promise<void> {
  await db
    .update(taskUpstreamSteps)
    .set({ status: "submitted", predictionId })
    .where(eq(taskUpstreamSteps.id, stepId));
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
