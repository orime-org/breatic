// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { DelayedError, type Job } from "bullmq";
import { AppError, budgetDeadlineFrom, getMiniToolsConfig, getStreamRedis, getWorkerConfig, logger } from "@breatic/core";
import { failureOutcome, miniToolExecutionService, type AcceptedMiniToolExecution,
  type MiniToolExecutionCompletion, type MiniToolExecutionJob } from "@breatic/domain";
import { DeadlinePassed } from "@breatic/shared";
import { isTerminalAttempt, verifyJobLockOwnership } from "@worker/handlers/dispatch.js";
import { finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import { planReportingEnd } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { firstFailure, registerReportedOutputs, runMiniToolVideoTool } from "@worker/handlers/mini-tool/run-video-tool.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { verdictStands } from "@worker/handlers/understand-failure.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { passRunningGate } from "@worker/handlers/running-gate.js";
import { MiniToolStepFailed } from "@worker/handlers/mini-tool/step-failed.js";

/**
 * Every output of a run failed with one error, as a run fails whole (frames-split §7.19).
 * @param execution - The frozen run.
 * @param expectedVersion - The record version the commit was read at.
 * @param error - The run's first failure.
 * @returns The completion.
 * @throws {never} Never.
 */
export function failedCompletion(execution: AcceptedMiniToolExecution, expectedVersion: number, error: NonNullable<MiniToolExecutionCompletion["error"]>): MiniToolExecutionCompletion {
  return { planFingerprint: execution.planFingerprint, expectedVersion, error,
    outputs: execution.outputs.map((output) => ({ ...output, result: { status: "failed", error } })) };
}

/**
 * Register every staged output of a run past its commit point and compose its completed commit (frames-split §7.19): the
 * presentation deadline of a video output counts from this registration.
 * @param execution - The frozen run.
 * @param expectedVersion - The record version the commit was read at.
 * @returns The completion.
 * @throws {Error} When a registration fails; past the commit point the throw goes back to the queue.
 */
export async function completedCompletion(execution: AcceptedMiniToolExecution, expectedVersion: number): Promise<MiniToolExecutionCompletion> {
  const results = await registerReportedOutputs(execution, budgetDeadlineFrom(Date.now()));
  return { planFingerprint: execution.planFingerprint, expectedVersion, error: null,
    outputs: execution.outputs.map((output) => {
      const result = results.get(output.outputIndex);
      if (result === undefined) throw new Error("A run past its commit point has an output with no registration");
      return { ...output, result };
    }) };
}

/**
 * Run one planned pickup through its original SQL-owned lifecycle (frames-split §7.19): it stages what its jobs report; the
 * first output that fails for good fails the run; once every output is reported it writes the commit point, registers every
 * output and commits completed once. Past the commit point a throw goes back to the queue whatever the attempt or deadline.
 * @param job - The queue delivery of the accepted execution.
 * @param token - This pickup's existing queue-lock token.
 * @returns The pickup marker after persistence and permitted notifications.
 * @throws {Error} When initialization, a registration past the commit point or a pre-return retry belongs to the queue.
 */
export async function runMiniToolExecutionTask(job: Job<MiniToolExecutionJob>, token?: string): Promise<Record<string, unknown>> {
  const taskId = job.data.taskId;
  let phase = "entry";
  let returned = false;
  let ctx: Record<string, unknown> = { taskId, jobId: job.id, phase };
  try {
    // A run first passes the running-task gate (inner#1968 design 3.9); one it finds ended is read as it stands.
    const gate = await passRunningGate(job, token, taskId);
    const { task, execution, record } = await miniToolExecutionService.startMiniToolExecution(taskId, job.id ?? taskId);
    ctx = { ...ctx, userId: task.userId, projectId: execution.projectId, spaceId: execution.spaceId };
    if (record.status === "cancelled") return { runId: taskId, status: record.status };
    let completion: MiniToolExecutionCompletion;
    if (record.status === "completed" || record.status === "failed") {
      completion = { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion, outputs: record.outputs, error: record.error };
      returned = true;
    } else if (record.commitPoint !== undefined) {
      // Past the commit point the run only completes: registration goes on, whatever the deadline (§7.19).
      phase = "registration";
      completion = await completedCompletion(execution, record.resultVersion);
    } else {
      const deadlineAt = await taskDeadline(taskId, gate.outcome === "started" ? gate.started : task.createdAt);
      phase = "computation";
      let failure: NonNullable<MiniToolExecutionCompletion["error"]> | null = null;
      // No run-level deadline check: a pickup after the deadline still reads every job submitted before it, while each step
      // whose next attempt is due after it ends expired; only a wait is bounded, by the reporting window below.
      try {
        const pickup = await runMiniToolVideoTool(execution, task.userId, deadlineAt);
        const first = firstFailure(pickup);
        if (first !== undefined) failure = first.error;
        else if (pickup.waiting || execution.outputs.some((output) => !pickup.results.has(output.outputIndex))) {
          throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
        }
      } catch (thrown) {
        // A step still running once the reporting window has closed is never read again: the run ends expired.
        if (thrown instanceof StillRunning && Date.now() < planReportingEnd(deadlineAt)) {
          if (token === undefined) throw thrown;
          await job.moveToDelayed(thrown.resumeAt, token);
          throw new DelayedError();
        }
        // A throw goes back to the queue until its attempts are used.
        const error = thrown instanceof DeadlinePassed || failureOutcome(deadlineAt) === "expired" ? new DeadlinePassed() : thrown;
        if (!isTerminalAttempt(job) && !verdictStands(error)) throw error;
        logger.error({ err: thrown, ctx: { ...ctx, phase } }, "mini_tool_execution_computation_failed");
        failure = error instanceof DeadlinePassed ? { code: "expired" }
          : error instanceof AppError || error instanceof MiniToolStepFailed ? { code: "mini_tool_failed", message: error.message }
            : { code: "internal" };
      }
      if (failure !== null) completion = failedCompletion(execution, record.resultVersion, failure);
      else {
        phase = "commit";
        const marked = await miniToolExecutionService.markMiniToolExecutionCommitPoint(taskId);
        // Another path ended the run first: it registers nothing.
        if (marked.state === "ended") return { runId: taskId, status: marked.record.status };
        phase = "registration";
        completion = await completedCompletion(execution, marked.record.resultVersion);
      }
    }
    phase = "ownership";
    if (!await verifyJobLockOwnership(job, token, getWorkerConfig().lock_duration_ms)) {
      logger.warn({ ctx: { ...ctx, phase } }, "mini_tool_execution_lock_lost");
      return { discarded: true };
    }
    phase = "completion";
    const finished = await finishMiniToolExecutionAndNotify(taskId, completion, getStreamRedis());
    return { runId: taskId, status: finished.record.status };
  } catch (err) {
    if (!(err instanceof StillRunning) && !(err instanceof DelayedError)) logger.error({ err, ctx: { ...ctx, phase } }, "mini_tool_execution_pickup_failed");
    if (returned) return { failed: true, reason: phase };
    throw err;
  }
}
