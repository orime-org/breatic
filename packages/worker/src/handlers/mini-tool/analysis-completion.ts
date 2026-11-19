// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { logger, type getStreamRedis } from "@breatic/core";
import { miniToolAnalysisService, settleTaskForNode } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";

/**
 * Commit the observed analysis outcome and publish its original host's task counts.
 * @param taskId - The immutable accepted analysis.
 * @param completion - The computation outcome.
 * @param streamRedis - The application's task-event stream connection.
 * @returns Nothing after the committed host notification succeeds.
 * @throws {Error} When metadata persistence or host notification fails.
 */
export async function finishMiniToolAnalysisAndNotify(
  taskId: string,
  completion: miniToolAnalysisService.MiniToolAnalysisCompletion,
  streamRedis: ReturnType<typeof getStreamRedis>,
): Promise<void> {
  let ctx: Record<string, unknown> = { taskId, phase: "commit" };
  try {
    const finished = await miniToolAnalysisService.finishMiniToolAnalysis(taskId, completion);
    const { record, context } = finished;
    ctx = { ...context, phase: "notify" };
    const error = record.error;
    const message = typeof error?.message === "string" ? error.message : typeof error?.code === "string" ? error.code : "analysis_failed";
    const outcome = record.status === "completed" ? "done" : error?.code === "expired" ? "expired" : "failed";
    await settleTaskForNode(streamRedis, canvasSpaceDocName(context.projectId, context.spaceId), {
      taskId: context.taskId, nodeId: context.hostNodeId, outcome,
      ...(outcome !== "done" ? { errorMessage: message } : {}),
    });
  } catch (err) {
    logger.error({ err, ctx }, "mini_tool_analysis_completion_failed");
    throw err;
  }
}
