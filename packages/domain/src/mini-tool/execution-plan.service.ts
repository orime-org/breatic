// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import { miniToolPlanLimitsSchema, x264PresetSchema, videoPresentationVersionSchema, type TaskEntity } from "@breatic/shared";
import {
  canonicalMiniToolValue, hashMiniToolValue, miniToolExecutionRecipeSchema, miniToolPlannedRequestSchema,
  miniToolPresentationRefSchema, miniToolSourceBindingSchema, miniToolTaskType, videoFocusCropDraftSchema, videoToolAnalysisRefSchema, videoToolDraftSchema,
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
  // Who pays, frozen at admission and bound by the plan fingerprint (frames-split §5.5 configuration row).
  chargeTo: z.enum(["platform", "user"]),
};
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const layout = z.strictObject({
  batches: z.array(z.array(index).min(1)),
  encodes: z.array(z.strictObject({ outputIndex: index, chunks: z.array(z.strictObject({ start: index, end: index })).min(1) })),
});
const stageJobs = z.array(z.strictObject({ stage: z.enum(["encode", "stitch"]), jobs: z.number().int().positive() }));
const container = {
  containerClass: z.literal("MiniToolContainerStd4"), precheckSeconds: z.number().positive(),
  size: z.strictObject({ instance_type: z.string().min(1), vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
  limits: miniToolPlanLimitsSchema,
};
const frozenToolInput = {
  presentationRef: miniToolPresentationRefSchema,
  // The selected version: its display grid, tool source and source keyframe statistics (frames-split §7.11).
  presentations: z.strictObject({ source: videoPresentationVersionSchema }), versionIds: z.strictObject({ source: fingerprint }),
};
const storedPlanSchema = z.strictObject({ ...common, ...frozenToolInput, tool: z.enum(["video.extract-frames", "video.split", "video.focus-crop"]), layout,
  // The stage counts frozen beside the layout (§97 D12-1); plans admitted before them have none.
  stageJobs: stageJobs.optional(),
  outputSeconds: z.array(z.number().nonnegative().finite()), container: z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
    encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index }),
});

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
 * Validate a frozen plan under the caller's lock.
 * @param task - The original physical parent, never replacement queue data.
 * @returns Original parent and verified executable inputs.
 * @throws {z.ZodError} When persisted fields violate their versioned contract.
 * @throws {Error} When original lane, parent, output mapping or complete plan hash differs.
 */
export async function executionPlanFromTask(task: TaskEntity): Promise<MiniToolExecutionPlan> {
  if (task.source !== "mini_tool" || task.mode !== "append") throw new Error("Planned video execution has no owning task");
  const stored = storedPlanSchema.parse(task.params.miniToolExecution);
  // A focus crop's draft is its request's own (frames-split §5.5); the panel tools' drafts are their node drafts.
  const draft = stored.tool === "video.focus-crop" ? videoFocusCropDraftSchema.parse(stored.draft) : videoToolDraftSchema(stored.tool).parse(stored.draft);
  miniToolPlannedRequestSchema.parse({ tool: stored.tool, project_id: stored.projectId, space_id: stored.spaceId, run_id: stored.taskId,
    draft, analysis_refs: stored.analysisRefs, outputs: stored.outputs, presentation_ref: stored.presentationRef });
  const execution = { ...stored, draft } as AcceptedMiniToolExecution;
  const { requestFingerprint: _requestFingerprint, planFingerprint, ...projection } = execution;
  if (task.taskType !== miniToolTaskType(execution.tool)
    || execution.taskId !== task.id || execution.projectId !== task.projectId || execution.spaceId !== task.spaceId || execution.model !== task.model
    || !frozenInputsMatch(execution)
    || execution.model !== execution.tool || execution.outputSeconds.length !== execution.outputs.length
    || canonicalMiniToolValue(execution.targetNodeIds) !== canonicalMiniToolValue(execution.outputs.map((output) => output.nodeId))
    || await hashMiniToolValue(projection) !== planFingerprint) throw new Error("Planned execution differs from its original parent or complete plan");
  return { task, execution };
}

/**
 * Whether each frozen input's selected version is the one its ref and registered binding name.
 * @param execution - The plan.
 * @returns True when every input matches.
 * @throws {never} Never.
 */
function frozenInputsMatch(execution: AcceptedMiniToolExecution): boolean {
  const version = execution.presentations.source;
  return version.sourceFingerprint === execution.binding.contentHash && version.toolInputId === execution.presentationRef.source.toolInputId
    && version.planSha256 === execution.presentationRef.source.planSha256 && version.versionId === execution.versionIds.source;
}
