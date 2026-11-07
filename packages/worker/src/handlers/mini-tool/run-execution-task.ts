// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { DelayedError, type Job } from "bullmq";
import { AppError, getMiniToolsConfig, getStreamRedis, getWorkerConfig, logger } from "@breatic/core";
import { failureOutcome, hasUnresolvedMiniToolStepAttempts, miniToolExecutionService, miniToolStepStateSchema, upstreamStepRepo,
  type MiniToolExecution, type MiniToolExecutionCompletion, type MiniToolExecutionJob } from "@breatic/domain";
import { assertBeforeDeadline, DeadlinePassed, type StudioAssetEntity } from "@breatic/shared";
import { miniToolExecutionOutputSchema, type MiniToolExecutionOutput } from "@breatic/shared/mini-tools";
import { isTerminalAttempt, verifyJobLockOwnership } from "@worker/handlers/dispatch.js";
import { commitMiniToolExecutionProgress, finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import { runMiniToolRemoveBackground } from "@worker/handlers/mini-tool/run-remove-background.js";
import { runMiniToolVideoTool } from "@worker/handlers/mini-tool/run-video-tool.js";
import { runMiniToolLipSync } from "@worker/handlers/mini-tool/run-lip-sync.js";
import { runMiniToolTransitions } from "@worker/handlers/mini-tool/run-transitions.js";
import { runMiniToolErase } from "@worker/handlers/mini-tool/run-erase.js";
import { runMiniToolExpand } from "@worker/handlers/mini-tool/run-expand.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { verdictStands } from "@worker/handlers/understand-failure.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";

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
        outputs: record.outputs, error: record.error, consumptionSet: "uncertain" };
      returned = true;
    } else {
      const deadlineAt = await taskDeadline(taskId, task.createdAt);
      phase = "computation";
      try {
        assertBeforeDeadline(deadlineAt);
        if (execution.tool !== "video.remove-bg") {
          // Lip-sync walks its steps per pickup like the frames runner (DD §7.2, §7.3); its one output ends registered or with
          // the one §9.4 reason as its error, which the terminal commit carries as the run's error.
          // Erase and expand walk theirs the same way and end with their own reason (execution design §10.4, §10.5).
          const pickup = execution.tool === "video.lip-sync" ? await runMiniToolLipSync(execution, task.userId, deadlineAt)
            : execution.tool === "video.transitions" ? await runMiniToolTransitions(execution, task.userId, deadlineAt)
              : execution.tool === "video.erase" ? await runMiniToolErase(execution, task.userId, deadlineAt)
                : execution.tool === "video.expand" ? await runMiniToolExpand(execution, task.userId, deadlineAt) : await runMiniToolVideoTool(execution, task.userId, deadlineAt);
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
            error: failed?.result?.status === "failed" ? failed.result.error : null, consumptionSet: "uncertain" };
        } else {
          const output = await runMiniToolRemoveBackground(taskId, deadlineAt, (job.attemptsMade ?? 0) + (job.stalledCounter ?? 0) > 0, (stepId) => {
            returned = true;
            ctx = { ...ctx, stepId };
          });
          returned = true;
          completion = { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion,
            outputs: [registeredOutput(current, output)], error: null, consumptionSet: "uncertain" };
        }
      } catch (thrown) {
        if (thrown instanceof StillRunning) {
          if (token === undefined) throw thrown;
          await job.moveToDelayed(thrown.resumeAt, token);
          throw new DelayedError();
        }
        const steps = await upstreamStepRepo.listSteps(taskId);
        // Only the vendor call (generate) returning is the no-throw boundary; preparation container jobs retry on their own.
        const pastReturn = steps.find((step) => step.kind === "generate" && step.output.miniToolStep !== undefined && miniToolStepStateSchema.parse(step.output.miniToolStep).result?.outcome === "done");
        returned ||= pastReturn !== undefined;
        ctx = { ...ctx, ...(pastReturn === undefined ? {} : { stepId: pastReturn.id }) };
        const error = thrown instanceof DeadlinePassed || failureOutcome(deadlineAt) === "expired" ? new DeadlinePassed() : thrown;
        if (!returned && !isTerminalAttempt(job) && !verdictStands(error)) throw error;
        logger.error({ err: thrown, ctx: { ...ctx, phase: error instanceof UpstreamTaskFailed ? "provider" : returned ? "registration" : phase } }, "mini_tool_execution_computation_failed");
        const failure: NonNullable<MiniToolExecutionCompletion["error"]> = error instanceof DeadlinePassed ? { code: "expired" }
          : error instanceof AppError || error instanceof UpstreamTaskFailed ? { code: "mini_tool_failed", message: error.message }
            : { code: "internal" };
        // Only outputs not yet committed fail; a committed result is never rewritten (design line 622).
        completion = { planFingerprint: execution.planFingerprint, expectedVersion: record.resultVersion,
          outputs: execution.outputs.map((output, index) => {
            const held = record.outputs[index]?.result;
            return { ...output, result: held?.status === "registered" ? held : { status: "failed", error: failure }, late: false };
          }),
          error: failure, consumptionSet: "uncertain" };
      }
      const steps = await upstreamStepRepo.listSteps(taskId);
      returned ||= steps.some((step) => step.kind === "generate" && step.output.miniToolStep !== undefined && miniToolStepStateSchema.parse(step.output.miniToolStep).result?.outcome === "done");
      completion.consumptionSet = steps.some((step) => step.output.miniToolStep !== undefined
        && hasUnresolvedMiniToolStepAttempts(miniToolStepStateSchema.parse(step.output.miniToolStep))) ? "uncertain" : "complete";
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

/**
 * Keep the actual registered rows separate from the source's measured media.
 * @param current - The original accepted mapping and parent.
 * @param stored - The canonical registered winner and its cover.
 * @param stored.asset - The actual primary registered asset.
 * @param stored.cover - Its registered cover, when present.
 * @returns The complete original slot with actual canonical media.
 * @throws {Error} When the registered observation violates the public media contract.
 */
function registeredOutput(current: MiniToolExecution, stored: { asset: StudioAssetEntity; cover: StudioAssetEntity | null }): MiniToolExecutionOutput {
  const { asset, cover } = stored;
  return miniToolExecutionOutputSchema.parse({ ...current.execution.outputs[0], late: false, result: {
    status: "registered", assetId: asset.id, canonicalURL: asset.fileUrl, kind: asset.kind, contentHash: asset.contentHash,
    mimeType: asset.mimeType, size: asset.sizeBytes, width: asset.width, height: asset.height, duration: asset.durationSeconds,
    cover: cover === null ? null : { assetId: cover.id, canonicalURL: cover.fileUrl, kind: cover.kind,
      contentHash: cover.contentHash, mimeType: cover.mimeType, size: cover.sizeBytes, width: cover.width, height: cover.height },
  } });
}
