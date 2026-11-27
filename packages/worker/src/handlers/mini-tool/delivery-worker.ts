// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Job, Worker } from "bullmq";
import {
  createQueue, getMiniToolsConfig, getStreamRedis, logger,
  MINI_TOOL_DELIVERY_JOB, MINI_TOOL_DELIVERY_DISCOVERY_JOB,
  miniToolDeliveryWakeSchema, miniToolDeliveryDiscoverySchema, type MiniToolDeliveryWake,
} from "@breatic/core";
import { miniToolDeliveryService, settleTaskForNode, type MiniToolDeliveryContext } from "@breatic/domain";
import { canvasSpaceDocName, type FocusImage } from "@breatic/shared";
import { recordGenerationForNodes } from "@worker/handlers/dispatch.js";
import { generationMetadata } from "@worker/handlers/persisted-output.js";

let queue: ReturnType<typeof createQueue> | undefined;
const retention = { removeOnComplete: true, removeOnFail: true };

/**
 * Resolve the existing tasks queue after application configuration is installed.
 * @returns This process's queue transport for pure delivery identities.
 * @throws {Error} When queue configuration or registration fails.
 */
function tasksQueue(): ReturnType<typeof createQueue> {
  return queue ??= createQueue("tasks");
}

/**
 * Enqueue the current SQL delivery identity on the existing tasks queue.
 * @param wake - The original task and delivery version.
 * @returns Nothing after Redis accepts the wake.
 * @throws {Error} When validation or transport fails.
 */
export async function enqueueMiniToolDelivery(wake: MiniToolDeliveryWake): Promise<void> {
  const data = miniToolDeliveryWakeSchema.parse(wake);
  await tasksQueue().add(MINI_TOOL_DELIVERY_JOB, data, { ...retention, jobId: `mini-tool-delivery-${data.taskId}-${data.deliveryVersion}` });
}

/**
 * Publish one canonical output and acknowledge its current SQL delivery version.
 * @param context - Original frozen inputs, public manifest and internal delivery state.
 * @param outputIndex - The original registered output slot.
 * @param streamRedis - The application's task-event stream connection (this process's own by default).
 * @returns Current context after acknowledgement or a recorded recoverable failure.
 * @throws {Error} When an internal caller names a slot without a registered result.
 */
export async function deliverMiniToolOutput(
  context: MiniToolDeliveryContext, outputIndex: number, streamRedis: ReturnType<typeof getStreamRedis> = getStreamRedis(),
): Promise<MiniToolDeliveryContext> {
  const { task, execution, record, delivery } = context;
  const output = record.outputs.find((slot) => slot.outputIndex === outputIndex);
  if (output?.result?.status !== "registered") throw new Error("Delivery requires an original registered output");
  const media = output.result;
  let stage = "history";
  const observed: { landed: boolean | null } = { landed: null };
  const ctx = { taskId: task.id, deliveryVersion: delivery?.version, outputIndex, projectId: execution.projectId, spaceId: execution.spaceId };
  try {
    if (execution.tool === "video.focus-crop") {
      // A video focus crop is no node content (frames-split §5.5 delivery row): the panel node's row settles done and its
      // counts event carries the image collab appends to the node's focus images, only when the row landed; no history.
      stage = "publish";
      const params = execution.draft.params as { sourceName: string };
      const image: FocusImage & { nodeId: string } = { nodeId: output.nodeId, id: task.id, url: media.canonicalURL, name: params.sourceName,
        width: media.width ?? 0, height: media.height ?? 0 };
      const verdict = await settleTaskForNode(streamRedis, canvasSpaceDocName(execution.projectId, execution.spaceId),
        { taskId: task.id, nodeId: output.nodeId, outcome: "done", focusImageAppend: image });
      if (verdict === null) { stage = "node-task"; throw new Error("Planned delivery has no original node task"); }
      observed.landed = verdict.landed;
    } else await recordGenerationForNodes(streamRedis, canvasSpaceDocName(execution.projectId, execution.spaceId), {
      taskId: task.id, projectId: execution.projectId, userId: task.userId, taskType: task.taskType,
      metadata: generationMetadata({
        reportedModel: undefined, jobModel: execution.model, credits: task.billedCredits ?? undefined,
        durationMs: task.durationMs ?? undefined, toolId: execution.tool,
        params: { tool: execution.tool, draft: execution.draft, analysis_refs: execution.analysisRefs, outputs: execution.outputs },
      }),
    }, [{
      nodeId: output.nodeId, content: media.canonicalURL,
      coverUrl: media.kind === "video" ? media.cover?.canonicalURL : undefined,
      width: media.width, height: media.height, duration: media.duration, mimeType: media.mimeType, size: media.size,
      resultOrigin: { kind: "mini-tool-output", runId: task.id, planFingerprint: execution.planFingerprint, outputIndex },
    }], {
      rethrowOnRecordFailure: true,
      onHistoryRecorded: () => { stage = "publish"; },
      onNodeSettled: (verdict) => {
        if (verdict === null) { stage = "node-task"; throw new Error("Planned delivery has no original node task"); }
        observed.landed = verdict.landed;
      },
    });
    if (observed.landed === null) { stage = "node-task"; throw new Error("Planned delivery has no original node verdict"); }
    stage = "ack";
    if (delivery !== null && delivery.outputs.some((slot) => slot.outputIndex === outputIndex && slot.state === "pending")) {
      return await miniToolDeliveryService.ackMiniToolDelivery(task.id, {
        deliveryVersion: delivery.version, planFingerprint: execution.planFingerprint, outputIndex,
        assetId: media.assetId, disposition: observed.landed ? "published" : "history_only",
      });
    }
  } catch (err) {
    logger.error({ err, ctx: { ...ctx, stage } }, "mini_tool_delivery_deferred");
    if (delivery !== null) {
      try {
        await miniToolDeliveryService.deferMiniToolDelivery(task.id, {
          deliveryVersion: delivery.version, outputIndex,
          errorCode: stage === "node-task" ? "delivery_node_task_missing" : `delivery_${stage}_failed`,
        });
      } catch (diagnosticError) {
        logger.error({ err: diagnosticError, ctx: { ...ctx, stage: "diagnostic" } }, "mini_tool_delivery_diagnostic_failed");
      }
    }
  }
  return context;
}

/**
 * Wake pending delivery after an inline attempt or another successful slot.
 * @param context - The latest observed SQL-owned context.
 * @returns Nothing after queue acceptance or the application's failure log.
 * @throws {never} Transport failures retain the durable pending state.
 */
export async function wakePendingMiniToolDelivery(context: MiniToolDeliveryContext): Promise<void> {
  if (!context.delivery?.outputs.some((output) => output.state === "pending")) return;
  try {
    await enqueueMiniToolDelivery({ taskId: context.task.id, deliveryVersion: context.delivery.version });
  } catch (err) {
    logger.error({ err, ctx: { taskId: context.task.id, deliveryVersion: context.delivery.version, stage: "enqueue" } }, "mini_tool_delivery_enqueue_failed");
  }
}

/**
 * Dispatch strict delivery and discovery jobs on the original tasks worker.
 * @param job - The original named queue envelope.
 * @returns The processor's current recovery marker.
 * @throws {Error} When a raw job name, shape or original SQL context is invalid.
 */
export async function runMiniToolDeliveryJob(job: Job<unknown>): Promise<Record<string, unknown>> {
  if (job.name === MINI_TOOL_DELIVERY_DISCOVERY_JOB) {
    const request = miniToolDeliveryDiscoverySchema.parse(job.data);
    try {
      const page = await miniToolDeliveryService.listPendingMiniToolDeliveries({ limit: getMiniToolsConfig().delivery.discovery_page_size, ...request });
      for (const wake of page.items) await enqueueMiniToolDelivery(wake);
      if (page.nextCursor !== null) await tasksQueue().add(MINI_TOOL_DELIVERY_DISCOVERY_JOB, { cursor: page.nextCursor }, retention);
      return {};
    } catch (err) {
      logger.error({ err, ctx: { jobId: job.id, stage: "discovery" } }, "mini_tool_delivery_discovery_failed");
      throw err;
    }
  }
  if (job.name !== MINI_TOOL_DELIVERY_JOB) throw new Error("Unknown mini-tool delivery job");
  const wake = miniToolDeliveryWakeSchema.parse(job.data);
  const context = await miniToolDeliveryService.readMiniToolDelivery(wake.taskId);
  if (context.delivery?.version !== wake.deliveryVersion) return {};
  const output = context.delivery.outputs.find((slot) => slot.state === "pending");
  if (output === undefined) return {};
  const current = await deliverMiniToolOutput(context, output.outputIndex, getStreamRedis());
  if (current.delivery?.version !== wake.deliveryVersion) await wakePendingMiniToolDelivery(current);
  return {};
}

/**
 * Install durable and immediate discovery on this instance's existing tasks worker.
 * @param tasksWorker - This instance's already-owned tasks worker.
 * @returns Nothing after scheduling and startup discovery are accepted.
 * @throws {Error} When recovery installation fails after draining the owned worker.
 */
export async function startMiniToolDeliveryRecovery(tasksWorker: Pick<Worker, "close">): Promise<void> {
  try {
    await tasksQueue().upsertJobScheduler(MINI_TOOL_DELIVERY_DISCOVERY_JOB, { every: getMiniToolsConfig().delivery.discovery_interval_ms }, {
      name: MINI_TOOL_DELIVERY_DISCOVERY_JOB, data: {}, opts: retention,
    });
    await tasksQueue().add(MINI_TOOL_DELIVERY_DISCOVERY_JOB, {}, retention);
  } catch (err) {
    logger.error({ err, ctx: { stage: "startup" } }, "mini_tool_delivery_recovery_start_failed");
    await tasksWorker.close();
    throw err;
  }
}
