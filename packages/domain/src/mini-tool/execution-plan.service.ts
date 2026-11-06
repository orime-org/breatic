// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { miniToolPlanLimitsSchema, readVideoPresentationLedger, x264PresetSchema, videoPresentationLedgerReceiptSchema, type TaskEntity, type VideoPresentationLedger } from "@breatic/shared";
import { getMiniToolsConfig } from "@breatic/core";
import {
  canonicalMiniToolValue, hashMiniToolValue, miniToolExecutionRecipeSchema, miniToolExecutionRetryRequestSchema, miniToolPlannedRequestSchema,
  miniToolPresentationRefSchema, miniToolSourceBindingSchema, videoToolAnalysisRefSchema, videoToolDraftSchema, type MiniToolSourceBinding,
} from "@breatic/shared/mini-tools";
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
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const layout = z.strictObject({
  batches: z.array(z.array(index).min(1)),
  encodes: z.array(z.strictObject({ outputIndex: index, chunks: z.array(z.strictObject({ start: index, end: index })).min(1) })),
});
const frameWindows = z.array(z.strictObject({ start: index, end: index })).min(1);
const stageJobs = z.array(z.strictObject({ stage: z.enum(["prepare", "prepare_stitch", "encode", "stitch", "faces", "clip_stem", "model_composite", "composite"]), jobs: z.number().int().positive() }));
const container = {
  containerClass: z.literal("MiniToolContainerStd4"), precheckSeconds: z.number().positive(),
  size: z.strictObject({ instance_type: z.string().min(1), vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
  limits: miniToolPlanLimitsSchema,
};
const frozenToolInput = {
  presentationRef: miniToolPresentationRefSchema,
  ledgerReceipts: z.strictObject({ source: videoPresentationLedgerReceiptSchema }), versionIds: z.strictObject({ source: fingerprint }),
  retry: miniToolExecutionRetryRequestSchema.shape.retry.optional(),
};
const storedPlanSchema = z.union([
  z.strictObject({ ...common, ...frozenToolInput, tool: z.literal("video.remove-bg"),
    provider: z.strictObject({ provider: z.literal("wavespeed"), model_id: z.literal("bria/fibo/video-background-remover") }),
    body: z.strictObject({ video: z.strictObject({ kind: z.literal("prepared"), inputId: z.literal("source"), job: z.string().regex(/^[0-9a-f-]{36}:prep:0$/) }),
      background_color: z.literal("Transparent"), output_container_and_codec: z.literal("webm_vp9"), preserve_audio: z.literal(true) }),
    preparation: z.strictObject({ ...container, chunks: z.array(z.strictObject({ start: index, end: index })).min(1), chunkRetries: index,
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }) }),
    modelCredits: z.number().nonnegative(),
  }),
  z.strictObject({ ...common, ...frozenToolInput, tool: z.enum(["video.extract-frames", "video.split"]), layout,
    // The stage counts frozen beside the layout (§97 D12-1); plans admitted before them have none.
    stageJobs: stageJobs.optional(),
    outputSeconds: z.array(z.number().nonnegative().finite()), container: z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index }),
  }),
  // A lip-sync run (execution design §9.3; DD §7.1).
  z.strictObject({ ...common, ...frozenToolInput, tool: z.literal("video.lip-sync"),
    generator: z.strictObject({ backend: z.literal("wavespeed-crop"), modelId: z.string().min(1), schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/), providerSyncMode: z.literal("cut_off").nullable() }),
    timeline: z.strictObject({ duration: z.number().positive(), videoDuration: z.number().positive(), syncMode: z.enum(["cut_off", "silence", "loop", "bounce", "remap"]) }),
    usedRange: z.strictObject({ start: z.literal(0), end: z.number().positive() }),
    dialogues: z.array(z.strictObject({ dialogueId: z.string().min(1), personId: z.string().min(1), audioInputId: z.uuid(), startTime: z.number().nonnegative(), duration: z.number().positive() })).min(1),
    persons: z.array(z.strictObject({ personId: z.string().min(1), detectionNumber: z.number().int().positive(),
      anchor: z.strictObject({ frameIndex: index, pts: z.number().nonnegative() }),
      anchorFaceBox: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      // A retry freezes its original run's step keys (§97 D21-6); a fresh run derives them from its own fingerprint.
      stepKeys: z.strictObject({ track: fingerprint, faces: fingerprint, clip: fingerprint, stem: fingerprint, gen: fingerprint }).optional() })).min(1),
    tracking: z.strictObject({ model: z.string().min(1) }), cropSize: z.number().int().positive(),
    layout: z.strictObject({ preparation: frameWindows, persons: z.number().int().positive(), composite: frameWindows }), stageJobs,
    container: z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index }),
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
  if (stored.retry !== undefined) {
    const indexes = stored.outputs.map((output) => output.outputIndex);
    if (stored.retry.runId === stored.taskId || canonicalMiniToolValue([...indexes].sort((a, b) => a - b)) !== canonicalMiniToolValue([...stored.retry.outputIndexes].sort((a, b) => a - b))
      || new Set(indexes).size !== indexes.length || new Set(stored.outputs.map((output) => output.nodeId)).size !== stored.outputs.length
      || stored.outputs.some((output, i) => output.nodeId === draft.source.nodeId || (i > 0 && output.outputIndex <= stored.outputs[i - 1]!.outputIndex)
        || output.recipe.kind !== (stored.tool === "video.split" ? "segment" : stored.tool === "video.remove-bg" ? "remove-bg" : stored.tool === "video.lip-sync" ? "lip-sync" : "frame"))) throw new Error("Retry differs from its frozen subset");
  } else {
    miniToolPlannedRequestSchema.parse({ tool: stored.tool, project_id: stored.projectId, space_id: stored.spaceId, run_id: stored.taskId,
      draft, analysis_refs: stored.analysisRefs, outputs: stored.outputs, presentation_ref: stored.presentationRef });
  }
  const execution = { ...stored, draft } as AcceptedMiniToolExecution;
  const { requestFingerprint: _requestFingerprint, planFingerprint, ...projection } = execution;
  if (task.taskType !== (execution.tool === "video.extract-frames" ? "image" : "video")
    || execution.taskId !== task.id || execution.projectId !== task.projectId || execution.spaceId !== task.spaceId || execution.model !== task.model
    || execution.ledgerReceipts.source.sourceFingerprint !== execution.binding.contentHash
    || execution.ledgerReceipts.source.toolInputId !== execution.presentationRef.source.toolInputId
    || ((execution.tool === "video.extract-frames" || execution.tool === "video.split") && (execution.model !== execution.tool || execution.outputSeconds.length !== execution.outputs.length))
    || (execution.tool === "video.lip-sync" && execution.model !== execution.generator.modelId)
    || canonicalMiniToolValue(execution.targetNodeIds) !== canonicalMiniToolValue(execution.outputs.map((output) => output.nodeId))
    || await hashMiniToolValue(projection) !== planFingerprint) throw new Error("Planned execution differs from its original parent or complete plan");
  return { task, execution };
}

/** One frozen tool input resolved for execution (§5.3): never the currently selected version. */
export interface ResolvedVideoToolInput {
  originalBinding: MiniToolSourceBinding;
  selectedVersion: { versionId: string; toolInputId: string };
  toolInputId: string;
  validatedFullLedger: VideoPresentationLedger;
}

/**
 * The version-resolution exit (§5.3): resolve one input of a frozen plan from its own presentationRef and receipt only,
 * reading and validating the full ledger the receipt names; the presentation DO is never asked.
 * @param plan - The frozen execution plan.
 * @param inputId - The input id, `source` for single-input tools.
 * @param bound - The read deadline and optional cancellation.
 * @param bound.deadlineAt - The absolute read deadline in epoch milliseconds.
 * @param bound.signal - The caller's cancellation.
 * @returns The original binding, the frozen version, the toolInputId and the validated full ledger.
 * @throws {Error} When the plan names no such input or the full object no longer matches its receipt.
 */
export async function resolveVideoToolInput(plan: AcceptedMiniToolExecution, inputId: string, bound: { deadlineAt: number; signal?: AbortSignal }): Promise<ResolvedVideoToolInput> {
  if (plan.tool === "video.remove-bg" || inputId !== "source") throw new Error(`The plan names no frozen tool input ${inputId}`);
  const ref = plan.presentationRef.source;
  const receipt = plan.ledgerReceipts.source;
  const validatedFullLedger = await readVideoPresentationLedger(receipt, { maxBytes: getMiniToolsConfig().presentation.source_ledger.max_bytes }, bound);
  return { originalBinding: plan.binding, selectedVersion: { versionId: plan.versionIds.source, toolInputId: ref.toolInputId }, toolInputId: ref.toolInputId, validatedFullLedger };
}
