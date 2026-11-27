// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { logger, type getStreamRedis } from "@breatic/core";
import { miniToolDeliveryService, miniToolExecutionService, settleTaskForNode, type MiniToolExecution, type MiniToolExecutionCompletion } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { deliverMiniToolOutput, wakePendingMiniToolDelivery } from "@worker/handlers/mini-tool/delivery-worker.js";

/**
 * Commit indexed execution media before restoring history and original target notifications.
 * @param taskId - The original accepted task.
 * @param completion - The complete indexed observation.
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
    await deliverPending(taskId, streamRedis);
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

/**
 * Deliver every registered output whose delivery slot is still pending, then wake pending delivery (design §7.11).
 * @param taskId - The original accepted task.
 * @param streamRedis - The application's task-event stream connection.
 * @returns Nothing once each pending position was tried.
 * @throws {Error} When the delivery context cannot be read.
 */
async function deliverPending(taskId: string, streamRedis: ReturnType<typeof getStreamRedis>): Promise<void> {
  let context = await miniToolDeliveryService.readMiniToolDelivery(taskId);
  const pending = (context.delivery?.outputs ?? []).filter((slot) => slot.state === "pending"
    && context.record.outputs.some((output) => output.outputIndex === slot.outputIndex && output.result?.status === "registered"));
  for (const slot of pending) context = await deliverMiniToolOutput(context, slot.outputIndex, streamRedis);
  await wakePendingMiniToolDelivery(context);
}

