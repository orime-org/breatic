// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { miniToolPlanLimitsSchema, videoSourceLedgerReceiptV2Schema, type TaskEntity } from "@breatic/shared";
import { canonicalMiniToolValue, hashMiniToolValue, miniToolExecutionRecipeSchema, miniToolExecutionRetryRequestSchema, miniToolPlannedRequestSchema, miniToolSourceBindingSchema, videoToolAnalysisRefSchema, videoToolDraftSchema } from "@breatic/shared/mini-tools";
import type { AcceptedMiniToolExecution } from "@domain/mini-tool/execution-admission.service.js";
import * as taskRepo from "@domain/task/task.repo.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  schemaVersion: z.literal(1), taskId: z.uuid(), projectId: z.uuid(), spaceId: z.uuid(), targetNodeIds: z.array(z.uuid()),
  binding: miniToolSourceBindingSchema, sourceKey: z.string().min(1),
  draft: z.unknown(), analysisRefs: z.array(videoToolAnalysisRefSchema),
  outputs: z.array(z.strictObject({ outputIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), nodeId: z.uuid(), recipe: miniToolExecutionRecipeSchema })).min(1),
  model: z.string().min(1), credits: z.number().nonnegative(), requestFingerprint: fingerprint, planFingerprint: fingerprint,
};
const storedPlanSchema = z.union([
  z.strictObject({ ...common, tool: z.literal("video.remove-bg"),
    provider: z.strictObject({ provider: z.literal("wavespeed"), model_id: z.literal("bria/fibo/video-background-remover") }),
    body: z.strictObject({ video: z.url(), background_color: z.literal("Transparent"), output_container_and_codec: z.literal("webm_vp9"), preserve_audio: z.literal(true) }),
  }),
  z.strictObject({ ...common, tool: z.enum(["video.extract-frames", "video.split"]), sourceLedger: videoSourceLedgerReceiptV2Schema,
    container: z.strictObject({ containerClass: z.literal("MiniToolContainerStd4"), precheckSeconds: z.number().positive(),
      size: z.strictObject({ instance_type: z.string().min(1), vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
      prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }), limits: miniToolPlanLimitsSchema }),
    retry: miniToolExecutionRetryRequestSchema.shape.retry.optional(),
  }),
]);

/** The original SQL parent and its verified immutable execution plan. */
export interface MiniToolExecutionPlan { task: TaskEntity; execution: AcceptedMiniToolExecution }

/**
 * Bind every executable field to the original parent and complete persisted plan.
 * @param taskId - The immutable accepted run UUID.
 * @returns The physical parent and verified plan, including hidden history.
 * @throws {Error} When persistence, lane, identity, output mapping or hash differs.
 */
export async function readMiniToolExecutionPlan(taskId: string): Promise<MiniToolExecutionPlan> {
  const task = await taskRepo.getMiniToolExecutionTask(taskId);
  if (task === null) throw new Error("Planned video execution has no owning task");
  return executionPlanFromTask(task);
}

/**
 * Validate frozen fresh plans or original-global-index retry subsets under the caller's lock.
 * @param task - The original physical parent, never replacement queue data.
 * @returns Original parent and verified executable inputs.
 * @throws {z.ZodError} When persisted fields violate their versioned contract.
 * @throws {Error} When original lane, parent, output mapping or complete plan hash differs.
 */
export async function executionPlanFromTask(task: TaskEntity): Promise<MiniToolExecutionPlan> {
  if (task.source !== "mini_tool" || task.mode !== "append") throw new Error("Planned video execution has no owning task");
  const stored = storedPlanSchema.parse(task.params.miniToolExecution);
  const draft = videoToolDraftSchema(stored.tool).parse(stored.draft);
  if (stored.tool !== "video.remove-bg" && stored.retry !== undefined) {
    const indexes = stored.outputs.map((output) => output.outputIndex);
    if (stored.retry.runId === stored.taskId || canonicalMiniToolValue([...indexes].sort((a, b) => a - b)) !== canonicalMiniToolValue([...stored.retry.outputIndexes].sort((a, b) => a - b))
      || new Set(indexes).size !== indexes.length || new Set(stored.outputs.map((output) => output.nodeId)).size !== stored.outputs.length
      || stored.outputs.some((output, i) => output.nodeId === draft.source.nodeId || (i > 0 && output.outputIndex <= stored.outputs[i - 1]!.outputIndex)
        || output.recipe.kind !== (stored.tool === "video.split" ? "segment" : "frame"))) throw new Error("Retry differs from its frozen subset");
  } else {
    miniToolPlannedRequestSchema.parse({ tool: stored.tool, project_id: stored.projectId, space_id: stored.spaceId, run_id: stored.taskId,
      draft, analysis_refs: stored.analysisRefs, outputs: stored.outputs, ...(stored.tool === "video.remove-bg" ? {} : { source_ledger: stored.sourceLedger }) });
  }
  const execution = { ...stored, draft } as AcceptedMiniToolExecution;
  const { requestFingerprint: _requestFingerprint, planFingerprint, ...projection } = execution;
  if (task.taskType !== (execution.tool === "video.extract-frames" ? "image" : "video")
    || execution.taskId !== task.id || execution.projectId !== task.projectId || execution.spaceId !== task.spaceId || execution.model !== task.model
    || (execution.tool !== "video.remove-bg" && (execution.model !== execution.tool || execution.sourceLedger.sourceFingerprint !== execution.binding.contentHash))
    || canonicalMiniToolValue(execution.targetNodeIds) !== canonicalMiniToolValue(execution.outputs.map((output) => output.nodeId))
    || await hashMiniToolValue(projection) !== planFingerprint) throw new Error("Planned execution differs from its original parent or complete plan");
  return { task, execution };
}
