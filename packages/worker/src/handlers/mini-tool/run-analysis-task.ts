// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { DelayedError, type Job } from "bullmq";
import { getStreamRedis, getWorkerConfig, logger } from "@breatic/core";
import { failureOutcome, hasUnresolvedMiniToolStepAttempts, miniToolAnalysisService, miniToolStepStateSchema, upstreamStepRepo,
  type MiniToolAnalysisJob } from "@breatic/domain";
import { DeadlinePassed } from "@breatic/shared";
import type { MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { isTerminalAttempt, verifyJobLockOwnership } from "@worker/handlers/dispatch.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { verdictStands } from "@worker/handlers/understand-failure.js";
import { finishMiniToolAnalysisAndNotify } from "@worker/handlers/mini-tool/analysis-completion.js";
import { TrackedMaskFailed } from "@worker/handlers/mini-tool/model-run-steps.js";
import { StillRunning } from "@worker/providers/still-running.js";

/** The original analysis computation is selected after loading its SQL identity. */
export type MiniToolAnalysisExecutor = (execution: miniToolAnalysisService.MiniToolAnalysisExecution, deadlineAt: number) => Promise<MiniToolAnalysisResult>;

/**
 * Execute one analysis pickup through the existing task lifecycle and completion owner.
 * @param job - The queue delivery of the original accepted analysis.
 * @param token - This pickup's existing BullMQ ownership token.
 * @param execute - The kind-specific executor consuming SQL-owned inputs.
 * @returns The current computation outcome or lost-ownership marker.
 * @throws {Error} When waiting, retry or infrastructure recovery belongs to the queue.
 */
export async function runMiniToolAnalysisTask(
  job: Job<MiniToolAnalysisJob>, token: string | undefined, execute: MiniToolAnalysisExecutor,
): Promise<Record<string, unknown>> {
  let ctx: Record<string, unknown> = { taskId: job.data.taskId, jobId: job.id, phase: "entry" };
  try {
    const execution = await miniToolAnalysisService.startMiniToolAnalysisExecution(job.data.taskId, job.id ?? job.data.taskId);
    const { record, context } = execution;
    ctx = { ...context, jobId: job.id, phase: "computation" };
    let completion: miniToolAnalysisService.MiniToolAnalysisCompletion;
    let marker: Record<string, unknown> = { analysisRunId: record.analysisRunId, status: record.status };
    if (record.status === "completed" || record.status === "failed") {
      completion = record.result !== null
        ? { kind: "result", result: record.result, consumptionSet: "uncertain" }
        : { kind: "error", error: record.error, consumptionSet: "uncertain" };
    } else {
      const deadlineAt = await taskDeadline(context.taskId, new Date(record.acceptedAt));
      try {
        completion = { kind: "result", result: await execute(execution, deadlineAt), consumptionSet: "uncertain" };
        marker = { analysisRunId: record.analysisRunId, status: "completed" };
      } catch (thrown) {
        if (thrown instanceof StillRunning) {
          if (token === undefined) throw thrown;
          await job.moveToDelayed(thrown.resumeAt, token);
          throw new DelayedError();
        }
        if (thrown instanceof TrackedMaskFailed) {
          // A tracking step failed for good: its code and step are the stored error, with no other attempt (§10.3).
          logger.error({ err: thrown, ctx }, "mini_tool_analysis_computation_failed");
          completion = { kind: "error", error: { ...thrown.failure }, consumptionSet: "uncertain" };
          marker = { failed: true, reason: thrown.failure.code };
        } else {
          const error = thrown instanceof DeadlinePassed || failureOutcome(deadlineAt) === "expired" ? new DeadlinePassed() : thrown;
          if (!isTerminalAttempt(job) && !verdictStands(error)) throw error;
          logger.error({ err: thrown, ctx }, "mini_tool_analysis_computation_failed");
          // A tracking analysis names a passed deadline by its panel code (§10.3 code table).
          const code = error instanceof DeadlinePassed ? (record.kind === "tracked_mask" ? "timeout" : "expired") : "analysis_failed";
          completion = { kind: "error", error: { code, message: error instanceof Error ? error.message : String(error) }, consumptionSet: "uncertain" };
          marker = { failed: true, reason: code };
        }
      }
      // Normal executors persist every call intent before IO. Their existing
      // unresolved-attempt predicate distinguishes known identities from an
      // ambiguous receipt; the completion transaction rechecks it under lock.
      const steps = await upstreamStepRepo.listSteps(context.taskId);
      completion.consumptionSet = steps.some((step) => step.output.miniToolStep !== undefined &&
        hasUnresolvedMiniToolStepAttempts(miniToolStepStateSchema.parse(step.output.miniToolStep))) ? "uncertain" : "complete";
    }
    ctx = { ...ctx, phase: "completion" };
    if (!await verifyJobLockOwnership(job, token, getWorkerConfig().lock_duration_ms)) {
      logger.warn({ ctx }, "mini_tool_analysis_lock_lost");
      return { discarded: true };
    }
    await finishMiniToolAnalysisAndNotify(context.taskId, completion, getStreamRedis());
    return marker;
  } catch (err) {
    if (!(err instanceof StillRunning) && !(err instanceof DelayedError)) logger.error({ err, ctx }, "mini_tool_analysis_pickup_failed");
    throw err;
  }
}
