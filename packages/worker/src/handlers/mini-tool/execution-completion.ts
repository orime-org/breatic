// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { logger, type getStreamRedis } from "@breatic/core";
import { miniToolExecutionService, settleTaskForNode, type MiniToolExecution, type MiniToolExecutionCompletion } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { recordGenerationForNodes } from "@worker/handlers/dispatch.js";
import { generationMetadata } from "@worker/handlers/persisted-output.js";

/**
 * Commit indexed execution media before restoring history and original target notifications.
 * @param taskId - The original accepted task.
 * @param completion - The complete indexed observation and call-set proof.
 * @param streamRedis - The application's task-event stream connection.
 * @returns The committed execution and its SQL-owned notification destination.
 * @throws {Error} When the original computation state cannot be persisted.
 */
export async function finishMiniToolExecutionAndNotify(taskId: string, completion: MiniToolExecutionCompletion, streamRedis: ReturnType<typeof getStreamRedis>): Promise<MiniToolExecution> {
  let finished: MiniToolExecution;
  try {
    finished = await miniToolExecutionService.finishMiniToolExecution(taskId, completion);
  } catch (err) {
    logger.error({ err, ctx: { taskId, phase: "execution-commit" } }, "mini_tool_execution_commit_failed");
    throw err;
  }
  const { task, execution, record } = finished;
  const docName = canvasSpaceDocName(execution.projectId, execution.spaceId);
  try {
    const outputs = record.outputs.flatMap((output) => output.result?.status !== "registered" ? [] : [{
      nodeId: output.nodeId, content: output.result.canonicalURL,
      coverUrl: output.result.kind === "video" ? output.result.cover?.canonicalURL : undefined,
      width: output.result.width, height: output.result.height, duration: output.result.duration,
      mimeType: output.result.mimeType, size: output.result.size,
      resultOrigin: { kind: "mini-tool-output" as const, runId: execution.taskId, planFingerprint: execution.planFingerprint, outputIndex: output.outputIndex },
    }]);
    await recordGenerationForNodes(streamRedis, docName, {
      taskId, projectId: execution.projectId, userId: task.userId, taskType: task.taskType,
      metadata: generationMetadata({
        reportedModel: undefined, jobModel: execution.model, credits: task.billedCredits ?? undefined,
        durationMs: task.durationMs ?? undefined, toolId: execution.tool,
        params: { tool: execution.tool, draft: execution.draft, analysis_refs: execution.analysisRefs, outputs: execution.outputs },
      }),
    }, outputs, { rethrowOnRecordFailure: true });
    for (const output of record.outputs) {
      if (output.result?.status !== "failed") continue;
      const error = output.result.error;
      await settleTaskForNode(streamRedis, docName, {
        taskId, nodeId: output.nodeId, outcome: error.code === "expired" ? "expired" : "failed",
        errorMessage: typeof error.message === "string" ? error.message : typeof error.code === "string" ? error.code : "mini_tool_failed",
      });
    }
  } catch (err) {
    logger.error({ err, ctx: { taskId, projectId: execution.projectId, spaceId: execution.spaceId, phase: "execution-notify" } }, "mini_tool_execution_delivery_failed");
  }
  return finished;
}
