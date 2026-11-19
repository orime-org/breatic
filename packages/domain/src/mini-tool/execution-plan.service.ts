// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { miniToolPlanLimitsSchema, x264PresetSchema, videoPresentationVersionSchema, type TaskEntity } from "@breatic/shared";
import {
  canonicalMiniToolValue, hashMiniToolValue, miniToolExecutionRecipeSchema, miniToolExecutionRetryRequestSchema, miniToolPlannedRequestSchema,
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
const frameWindows = z.array(z.strictObject({ start: index, end: index })).min(1);
const stageJobs = z.array(z.strictObject({ stage: z.enum(["prepare", "prepare_stitch", "track_prepare", "track_prepare_stitch", "track_join", "encode", "stitch", "faces", "clip_stem", "mask", "window", "model_composite", "composite"]), jobs: z.number().int().positive() }));
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
  retry: miniToolExecutionRetryRequestSchema.shape.retry.optional(),
};
const runContainer = z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
  encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index });
const rect = z.strictObject({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() });
/** The recipe kind each tool's outputs carry. */
const RECIPE_KIND = { "video.split": "segment", "video.remove-bg": "remove-bg", "video.lip-sync": "lip-sync", "video.extract-frames": "frame", "video.focus-crop": "frame",
  "video.transitions": "transitions", "video.erase": "erase", "video.expand": "expand" } as const;
const storedPlanSchema = z.union([
  z.strictObject({ ...common, ...frozenToolInput, tool: z.literal("video.remove-bg"),
    provider: z.strictObject({ provider: z.literal("wavespeed"), model_id: z.literal("bria/fibo/video-background-remover") }),
    body: z.strictObject({ video: z.strictObject({ kind: z.literal("prepared"), inputId: z.literal("source"), job: z.string().regex(/^[0-9a-f-]{36}:prep:0$/) }),
      background_color: z.literal("Transparent"), output_container_and_codec: z.literal("webm_vp9"), preserve_audio: z.literal(true) }),
    preparation: z.strictObject({ ...container, chunks: z.array(z.strictObject({ start: index, end: index })).min(1), chunkRetries: index,
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }) }),
    modelCredits: z.number().nonnegative(),
  }),
  z.strictObject({ ...common, ...frozenToolInput, tool: z.enum(["video.extract-frames", "video.split", "video.focus-crop"]), layout,
    // The stage counts frozen beside the layout (§97 D12-1); plans admitted before them have none.
    stageJobs: stageJobs.optional(),
    outputSeconds: z.array(z.number().nonnegative().finite()), container: z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index }),
  }),
  // A transitions run (frames-split §5.4, §7.17; §97 D23-3): both clips' inputs by draft input id.
  z.strictObject({ ...common, tool: z.literal("video.transitions"),
    presentationRef: z.record(z.uuid(), miniToolPresentationRefSchema.shape.source), presentations: z.record(z.uuid(), videoPresentationVersionSchema),
    versionIds: z.record(z.uuid(), fingerprint), bindings: z.record(z.uuid(), miniToolSourceBindingSchema), sourceKeys: z.record(z.uuid(), z.string().min(1)),
    retry: miniToolExecutionRetryRequestSchema.shape.retry.optional(),
    layout: z.strictObject({ encode: z.array(z.strictObject({ start: index, end: index })), window: z.array(z.strictObject({ start: index, end: index })) }), stageJobs,
    // The profile is checked where it is used, by the job recipe schema; the plan hash binds it here.
    profile: z.record(z.string(), z.json()),
    container: z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index }),
    windowContainer: z.strictObject({ ...container, containerClass: z.literal("MiniToolContainerGl") }),
  }),
  // A lip-sync run (execution design §9.3; DD §7.1).
  z.strictObject({ ...common, ...frozenToolInput, tool: z.literal("video.lip-sync"),
    generator: z.strictObject({ backend: z.literal("wavespeed-crop"), modelId: z.string().min(1), schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/), providerSyncMode: z.literal("cut_off").nullable() }),
    timeline: z.strictObject({ duration: z.number().positive(), videoDuration: z.number().positive(), syncMode: z.enum(["cut_off", "silence", "loop", "bounce", "remap"]) }),
    usedRange: z.strictObject({ start: z.literal(0), end: z.number().positive() }),
    dialogues: z.array(z.strictObject({ dialogueId: z.string().min(1), personId: z.string().min(1), audioInputId: z.uuid(), startTime: z.number().nonnegative(), duration: z.number().positive() })).min(1),
    persons: z.array(z.strictObject({ personId: z.string().min(1), detectionNumber: z.number().int().positive(),
      anchor: z.strictObject({ frameIndex: index }),
      anchorFaceBox: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      // Every step key is frozen at the first admission and copied by each retry (DD §7.1).
      stepKeys: z.strictObject({ "track:fwd": fingerprint.optional(), "track:rev": fingerprint.optional(), track_join: fingerprint, faces: fingerprint,
        clip: fingerprint, stem: fingerprint, gen: fingerprint }) })).min(1),
    sharedStepKeys: z.record(z.string().regex(/^(prepare:fwd|prepare:rev|composite:\d+|stitch)$/), fingerprint),
    tracking: z.strictObject({ model: z.string().min(1) }), cropSize: z.number().int().positive(), faceFeather: z.number().min(0).max(1),
    layout: z.strictObject({ preparation: frameWindows, persons: z.number().int().positive(), composite: frameWindows,
      tracking: z.strictObject({ forward: z.array(z.strictObject({ start: index, end: index })).max(1), reverse: z.array(z.strictObject({ start: index, end: index })) }) }), stageJobs,
    container: z.strictObject({ ...container, startSeconds: z.number().nonnegative().finite(),
      encode: z.strictObject({ crf: z.number().int().min(0).max(51), preset: x264PresetSchema }), chunkRetries: index,
      rawDiskBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  }),
  // An erase run (execution design §10.4).
  z.strictObject({ ...common, ...frozenToolInput, tool: z.literal("video.erase"),
    tracking: z.strictObject({ analysisRunId: z.uuid(), rleKey: z.string().min(1) }), range: z.strictObject({ start: index, end: index }),
    grid: z.strictObject({ mode: z.enum(["frames", "resample"]), rate: z.number().positive(), frameCount: z.number().int().positive() }),
    asyncRejection: z.strictObject({ path: z.string().min(1), equals: z.json() }), matte: z.strictObject({ dilate: index, feather: index }),
    modelCredits: z.number().nonnegative(), composite: frameWindows, stageJobs,
    stepKeys: z.record(z.string().regex(/^(prepare|mask|generate|composite:\d+|stitch)$/), fingerprint), container: runContainer,
    stepCredits: z.record(z.string().regex(/^(prepare|mask|generate|composite:\d+|stitch)$/), z.number().nonnegative()),
  }),
  // An expand run (execution design §10.5).
  z.strictObject({ ...common, ...frozenToolInput, tool: z.literal("video.expand"),
    layout: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), sourceX: z.number().int(), sourceY: z.number().int(), overSide: z.literal(false) }),
    frame: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }), size: z.enum(["832*480", "480*832"]), targetRoi: rect, sourceRoi: rect,
    prompt: z.string().min(1), seed: index, modelFps: z.number().int().positive(), modelCredits: z.number().nonnegative(),
    windows: z.array(z.strictObject({ span: z.strictObject({ start: z.number().nonnegative(), end: z.number().positive() }), duration: z.union([z.literal(5), z.literal(10)]) })).min(1),
    composite: frameWindows, stageJobs, stepKeys: z.record(z.string().regex(/^((window|window_mask|condition|generate|composite):\d+|stitch)$/), fingerprint), container: runContainer,
    stepCredits: z.record(z.string().regex(/^((window|window_mask|condition|generate|composite):\d+|stitch)$/), z.number().nonnegative()),
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
  // A focus crop's draft is its request's own (frames-split §5.5); the seven panel tools' drafts are their node drafts.
  const draft = stored.tool === "video.focus-crop" ? videoFocusCropDraftSchema.parse(stored.draft) : videoToolDraftSchema(stored.tool).parse(stored.draft);
  if (stored.retry !== undefined) {
    const indexes = stored.outputs.map((output) => output.outputIndex);
    if (stored.retry.runId === stored.taskId || canonicalMiniToolValue([...indexes].sort((a, b) => a - b)) !== canonicalMiniToolValue([...stored.retry.outputIndexes].sort((a, b) => a - b))
      || new Set(indexes).size !== indexes.length || new Set(stored.outputs.map((output) => output.nodeId)).size !== stored.outputs.length
      || stored.outputs.some((output, i) => output.nodeId === draft.source.nodeId || (i > 0 && output.outputIndex <= stored.outputs[i - 1]!.outputIndex)
        || output.recipe.kind !== RECIPE_KIND[stored.tool])) throw new Error("Retry differs from its frozen subset");
  } else {
    miniToolPlannedRequestSchema.parse({ tool: stored.tool, project_id: stored.projectId, space_id: stored.spaceId, run_id: stored.taskId,
      draft, analysis_refs: stored.analysisRefs, outputs: stored.outputs, presentation_ref: stored.presentationRef });
  }
  const execution = { ...stored, draft } as AcceptedMiniToolExecution;
  const { requestFingerprint: _requestFingerprint, planFingerprint, ...projection } = execution;
  if (task.taskType !== miniToolTaskType(execution.tool)
    || execution.taskId !== task.id || execution.projectId !== task.projectId || execution.spaceId !== task.spaceId || execution.model !== task.model
    || !frozenInputsMatch(execution)
    || ((execution.tool === "video.extract-frames" || execution.tool === "video.split" || execution.tool === "video.focus-crop") && (execution.model !== execution.tool || execution.outputSeconds.length !== execution.outputs.length))
    || (execution.tool === "video.lip-sync" && execution.model !== execution.generator.modelId)
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
  if (execution.tool !== "video.transitions") {
    const version = execution.presentations.source;
    return version.sourceFingerprint === execution.binding.contentHash && version.toolInputId === execution.presentationRef.source.toolInputId
      && version.planSha256 === execution.presentationRef.source.planSha256 && version.versionId === execution.versionIds.source;
  }
  const ids = Object.keys(execution.presentationRef);
  return ids.length === 2 && ids.every((id) => execution.presentations[id]?.toolInputId === execution.presentationRef[id]!.toolInputId
    && execution.presentations[id]?.sourceFingerprint === execution.bindings[id]?.contentHash && execution.sourceKeys[id] !== undefined
    && execution.presentations[id]?.versionId === execution.versionIds[id]);
}
