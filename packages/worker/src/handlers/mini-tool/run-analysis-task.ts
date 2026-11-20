// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { DelayedError, type Job } from "bullmq";
import { getStreamRedis, getWorkerConfig, logger } from "@breatic/core";
import { failureOutcome, miniToolAnalysisService, type MiniToolAnalysisJob } from "@breatic/domain";
import { DeadlinePassed } from "@breatic/shared";
import type { MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { isTerminalAttempt, verifyJobLockOwnership } from "@worker/handlers/dispatch.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { verdictStands } from "@worker/handlers/understand-failure.js";
import { finishMiniToolAnalysisAndNotify } from "@worker/handlers/mini-tool/analysis-completion.js";
import { planReportingEnd } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { StillRunning } from "@worker/handlers/still-running.js";

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
        ? { kind: "result", result: record.result }
        : { kind: "error", error: record.error };
    } else {
      const deadlineAt = await taskDeadline(context.taskId, new Date(record.acceptedAt));
      try {
        completion = { kind: "result", result: await execute(execution, deadlineAt) };
        marker = { analysisRunId: record.analysisRunId, status: "completed" };
      } catch (thrown) {
        // A step still running once the reporting window has closed is never waited for again: the analysis ends with its timeout code.
        if (thrown instanceof StillRunning && Date.now() < planReportingEnd(deadlineAt)) {
          if (token === undefined) throw thrown;
          await job.moveToDelayed(thrown.resumeAt, token);
          throw new DelayedError();
        }
        const error = thrown instanceof DeadlinePassed || failureOutcome(deadlineAt) === "expired" ? new DeadlinePassed() : thrown;
        if (!isTerminalAttempt(job) && !verdictStands(error)) throw error;
        logger.error({ err: thrown, ctx }, "mini_tool_analysis_computation_failed");
        const code = error instanceof DeadlinePassed ? "expired" : "analysis_failed";
        completion = { kind: "error", error: { code, message: error instanceof Error ? error.message : String(error) } };
        marker = { failed: true, reason: code };
      }
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
