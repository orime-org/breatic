// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { logger, type getStreamRedis } from "@breatic/core";
import { miniToolDeliveryService, miniToolExecutionService, settleTaskForNode, type MiniToolExecution, type MiniToolExecutionCompletion } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { deliverMiniToolOutput, wakePendingMiniToolDelivery } from "@worker/handlers/mini-tool/delivery-worker.js";

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
  const { execution, record } = finished;
  const docName = canvasSpaceDocName(execution.projectId, execution.spaceId);
  try {
    let context = await miniToolDeliveryService.readMiniToolDelivery(taskId);
    for (const output of record.outputs) {
      if (output.result?.status === "registered") context = await deliverMiniToolOutput(context, output.outputIndex, streamRedis);
    }
    await wakePendingMiniToolDelivery(context);
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
