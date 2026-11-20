// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { DelayedError, type Job } from "bullmq";
import { AppError, getMiniToolsConfig, getStreamRedis, getWorkerConfig, logger } from "@breatic/core";
import { failureOutcome, miniToolExecutionService,
  type MiniToolExecutionCompletion, type MiniToolExecutionJob } from "@breatic/domain";
import { DeadlinePassed } from "@breatic/shared";
import { isTerminalAttempt, verifyJobLockOwnership } from "@worker/handlers/dispatch.js";
import { commitMiniToolExecutionProgress, finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import { planReportingEnd } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { runMiniToolVideoTool, type VideoToolPickup } from "@worker/handlers/mini-tool/run-video-tool.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { verdictStands } from "@worker/handlers/understand-failure.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { MiniToolStepFailed } from "@worker/handlers/mini-tool/step-failed.js";

/**
 * Run one planned pickup through its original SQL-owned lifecycle.
 * @param job - The queue delivery of the accepted execution.
 * @param token - This pickup's existing queue-lock token.
 * @returns The pickup marker after persistence and permitted notifications.
 * @throws {Error} When initialization or a pre-return retry belongs to the queue.
 */
export async function runMiniToolExecutionTask(job: Job<MiniToolExecutionJob>, token?: string): Promise<Record<string, unknown>> {
  const taskId = job.data.taskId;
  let phase = "entry";
  let returned = false;
  let ctx: Record<string, unknown> = { taskId, jobId: job.id, phase };
  try {
    const current = await miniToolExecutionService.startMiniToolExecution(taskId, job.id ?? taskId);
    const { task, execution } = current;
    // The record the run last read or wrote: progress commits move it within the pickup (§93 D5-11).
    let record = current.record;
    ctx = { ...ctx, userId: task.userId, projectId: execution.projectId, spaceId: execution.spaceId };
    if (record.status === "cancelled") return { runId: taskId, status: record.status };
    let completion: MiniToolExecutionCompletion;
    if (record.status === "completed" || record.status === "failed") {
      completion = { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion,
        outputs: record.outputs, error: record.error };
      returned = true;
    } else {
      const deadlineAt = await taskDeadline(taskId, task.createdAt);
      phase = "computation";
      // What this pickup settled so far, kept when a later step throws: an output registered here is never shown failed.
      const settled: VideoToolPickup = { results: new Map(), waiting: false };
      // No run-level deadline check: a pickup after the deadline still reads every job submitted before it, while each step
      // whose next attempt is due after it ends expired; only a wait is bounded, by the reporting window below.
      try {
        const pickup = await runMiniToolVideoTool(execution, task.userId, deadlineAt, settled);
        const outputs = execution.outputs.map((output, index) => ({ ...output, result: pickup.results.get(output.outputIndex) ?? record.outputs[index]?.result ?? null, late: false }));
        // Each poll commits what finished non-terminally; the one terminal commit waits for every output (design §7.11, line 622).
        if (pickup.waiting || outputs.some((output) => output.result === null)) {
          const committed = record.outputs.map((output) => output.result?.status === "registered" ? output.result : null);
          const registeredNow = outputs.map((output) => output.result?.status === "registered" ? output.result : null);
          if (registeredNow.some((result, index) => result !== null && committed[index] === null)) {
            record = (await commitMiniToolExecutionProgress(taskId, { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion,
              outputs: outputs.map((output, index) => ({ ...output, result: registeredNow[index] ?? null })) })).record;
          }
          throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
        }
        const failed = outputs.find((output) => output.result?.status === "failed");
        completion = { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion, outputs,
          error: failed?.result?.status === "failed" ? failed.result.error : null };
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
        const failure: NonNullable<MiniToolExecutionCompletion["error"]> = error instanceof DeadlinePassed ? { code: "expired" }
            : error instanceof AppError || error instanceof MiniToolStepFailed ? { code: "mini_tool_failed", message: error.message }
              : { code: "internal" };
        // Only outputs not yet committed or registered in this pickup fail; a committed result is never rewritten (design line 622).
        completion = { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion,
          outputs: execution.outputs.map((output, index) => {
            const held = record.outputs[index]?.result;
            const now = settled.results.get(output.outputIndex);
            return { ...output, result: held?.status === "registered" ? held : now?.status === "registered" ? now : { status: "failed", error: failure }, late: false };
          }),
          error: failure };
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
