// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tracked mask analysis (inner#1306 execution design §10.2, §10.3): the tracker takes its prompt on frame 0 only, so the
 * range [s, e) is tracked from the anchor a on the forward clip [a, e) and, when a > s, on [s, a] played backwards. Each clip
 * is prepared on standard-4 (`prepare:fwd`, `prepare:rev`), tracked by SAM3 (`track:fwd`, `track:rev`) with the selection on
 * its frame 0, and the two RLEs are joined (`join`, `rle_join`) into the one registered `rle` artifact. The clips and the
 * fetched RLEs stay on the analysis pin until the analysis ends. A step that fails for good ends the analysis with
 * `TrackedMaskFailed`, whose code and step the pickup stores.
 */
import { getMiniToolsConfig, getStorageAdapter } from "@breatic/core";
import { DeadlinePassed } from "@breatic/shared";
import { lipsyncStepKey, miniToolModelRoute, upstreamStepRepo, type miniToolAnalysisService } from "@breatic/domain";
import {
  hashMiniToolValue, miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema, trackingClips, clipJobWindows,
  type MiniToolAnalysisResult,
} from "@breatic/shared/mini-tools";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { advanceClip, advanceGenerate, eachSubmitted, storedRequest, TrackedMaskFailed, trackedMaskFailure, type ModelStepRun } from "@worker/handlers/mini-tool/model-run-steps.js";
import { advanceAnalysisJob } from "@worker/handlers/mini-tool/run-container-analysis.js";
import { modelInputTarget, toolInputOf } from "@worker/handlers/video-presentation-recipes.js";

type Execution = miniToolAnalysisService.MiniToolAnalysisExecution;
type TrackedMaskResult = Extract<MiniToolAnalysisResult, { kind: "tracked_mask" }>;

/** The input ids the join binds the tracks under, fixed so a rebuilt request is the same request. */
const TRACKS = { forward: "00000000-0000-4000-8002-000000000000", reverse: "00000000-0000-4000-8007-000000000000" } as const;

/**
 * Advance one accepted tracked mask analysis through its steps.
 * @param execution - The SQL-owned accepted analysis.
 * @param deadlineAt - The task deadline.
 * @returns The complete result.
 * @throws {TrackedMaskFailed} When a step failed for good.
 * @throws {DeadlinePassed} When a step expired: its next attempt was due after the deadline, or ingest ended it there.
 * @throws {StillRunning} While a step runs.
 * @throws {Error} When the frozen inputs are not a tracked mask, or persistence or IO fails.
 */
export async function runMiniToolTrackedMaskAnalysis(execution: Execution, deadlineAt: number): Promise<TrackedMaskResult> {
  const record = miniToolAnalysisRecordSchema.parse(execution.record);
  const input = record.analysisInput;
  if (input.kind !== "tracked_mask") throw new Error("A tracked mask analysis requires its tracked mask input");
  const { context, params } = execution;
  const config = getMiniToolsConfig();
  // The range and the anchor are grid frames of the frozen version, read from its tool source (§7.16).
  const version = params.analysis.presentations.source;
  const tool = toolInputOf(version, params.sourceKey);
  const count = input.range.end - input.range.start;
  const clips = trackingClips(input.range, input.anchor.frameIndex);
  // A tracking analysis freezes no plan route (execution design §11.5 names the four execution plans); its calls take
  // the configured upstream.
  const route = miniToolModelRoute();
  const target = modelInputTarget(version, { crf: config.presentation.crf, preset: config.presentation.preset });
  const run: ModelStepRun = { taskId: context.taskId, projectId: context.projectId, sourceKey: params.sourceKey,
    container: { containerClass: config.analyses.tracked_mask.preparation.container_class, limits: config.plan_limits, chunkRetries: config.encoding.chunk_retries }, log: "tracked_mask" };
  /**
   * A step's key, over the analysis run (execution design §10.7).
   * @param step - The step.
   * @returns The key.
   * @throws {never} Never.
   */
  const keyOf = (step: string): string => lipsyncStepKey(context.taskId, null, step);
  const storage = await getStorageAdapter();
  const rect = target.displayRect ?? { x: 0, y: 0, width: target.width, height: target.height };
  const { box, points } = input.region;
  const sides = [...(clips.forward === null ? [] : [{ order: "forward" as const, clip: clips.forward, suffix: "fwd", itemIndex: 0 }]),
    ...(clips.reverse === null ? [] : [{ order: "reverse" as const, clip: clips.reverse, suffix: "rev", itemIndex: 1 }])];

  const prepared = await eachSubmitted(sides.map((side) => async (): Promise<string> => {
    const windows = clipJobWindows(side.clip, side.order, target, config.encoding.reverse_buffer_bytes);
    const ended = await advanceClip(run, { stepKey: keyOf(`prepare:${side.suffix}`), windows, order: side.order, input: tool, target, failed: (reason) => ({ failed: reason }) }, deadlineAt);
    // An expired step is the analysis's budget ending, stored as its timeout code (§10.3), never a step failure.
    if (!("key" in ended)) throw ended.expired === true ? new DeadlinePassed() : new TrackedMaskFailed(trackedMaskFailure("prepare", { reason: ended.failed }));
    return ended.key;
  }));
  const tracks = await eachSubmitted(sides.map((side, at) => async (): Promise<string> => {
    // The selection in the clip's pixels on its frame 0, the anchor (§10.2); the RLE is read, so no mask is applied.
    const ended = await advanceGenerate(run, { route: route, model: input.profile.id, itemIndex: side.itemIndex, stepKey: keyOf(`track:${side.suffix}`), contentType: "text/plain",
      // The binding reads SAM3's object answer through its `output_field`, the RLE link (§11.2 output row).
      input: () => Promise.resolve({ prompt: input.trackingPrompt, params: {
        video: storage.publicUrl(prepared[at]!), apply_mask: input.profile.params.apply_mask ?? false,
        ...(box === null ? {} : { box_prompts: [{ frame_index: 0, object_id: 1, x_min: Math.round(rect.x + box.x * rect.width), y_min: Math.round(rect.y + box.y * rect.height),
          x_max: Math.round(rect.x + (box.x + box.width) * rect.width), y_max: Math.round(rect.y + (box.y + box.height) * rect.height) }] }),
        ...(points.length === 0 ? {} : { point_prompts: points.map((point) => ({ frame_index: 0, object_id: 1, x: Math.round(rect.x + point.x * rect.width),
          y: Math.round(rect.y + point.y * rect.height), label: point.label === "positive" ? 1 : 0 })) }),
      } }) }, context.userId, deadlineAt);
    if (!("key" in ended)) throw ended.expired === true ? new DeadlinePassed() : new TrackedMaskFailed({ code: ended.failed as "model_rejected" | "timeout" | "failed", step: "track" });
    return ended.key;
  }));

  // The join is registered as the result's artifact; it keeps its step position across pickups.
  const steps = await upstreamStepRepo.listSteps(context.taskId);
  const position = steps.find((step) => storedRequest(step)?.outputs[0]?.recipe.kind === "rle_join")?.position ?? steps.length;
  let join: Awaited<ReturnType<typeof advanceAnalysisJob>>;
  try {
    join = await advanceAnalysisJob(execution, deadlineAt, position,
      () => Promise.resolve([{ outputIndex: 0, modality: "text", recipe: { kind: "rle_join",
        inputs: sides.map((side) => ({ inputId: TRACKS[side.order], order: side.order, frameCount: side.clip.end - side.clip.start })), width: target.width, height: target.height } }]),
      undefined, () => Promise.resolve(sides.map((side, at) => ({ inputId: TRACKS[side.order], storageKey: tracks[at]! }))));
  } catch (error) {
    if (error instanceof ContainerJobFailed) throw new TrackedMaskFailed(trackedMaskFailure("join", { reason: error.reason }));
    throw error;
  }
  const asset = join.job.assets.find((entry) => entry.outputIndex === 0)?.asset;
  if (asset === undefined) throw new Error("The tracked mask join has no registered output");
  return miniToolAnalysisResultSchema.parse({
    schemaVersion: 1, kind: "tracked_mask", draftId: record.draftId, revision: record.revision, analysisRunId: record.analysisRunId, acceptedAt: record.acceptedAt,
    binding: record.binding, analysisInput: input, inputFingerprint: record.inputFingerprint,
    width: target.width, height: target.height, frameCount: count, fps: version.display.fps,
    anchor: input.anchor, regionFingerprint: await hashMiniToolValue(input.region),
    artifactRefs: [{ role: "rle", assetId: asset.id, canonicalURL: asset.fileUrl, contentHash: asset.contentHash, kind: asset.kind, mimeType: asset.mimeType,
      size: asset.sizeBytes, frameMetadata: null }],
  }) as TrackedMaskResult;
}
