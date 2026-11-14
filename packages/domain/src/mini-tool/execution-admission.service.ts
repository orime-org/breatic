// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomInt } from "node:crypto";
import { z } from "zod";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError, budgetDeadlineFrom, db, env, getMiniToolsConfig, getNodeTaskConfig, projectAuthService, type MiniToolsConfig, type DbTx } from "@breatic/core";
import {
  TaskStatus, ceilToCreditCent, extractPromptText, readVideoPresentationCompact, readVideoPresentationLedger, t, videoPresentationKeyframeFlags,
  type MiniToolPlanTarget, type TaskEntity, type TaskStatusType, type VideoPresentationLedger, type VideoPresentationLedgerReceipt,
} from "@breatic/shared";
import {
  batchVideoRunOutputs, presentationFramesIn, canonicalMiniToolValue, miniToolById, planModelWindows, videoExpandLayout, type ModelGrid, type ModelWindow, type VideoExpandLayout, miniToolPlannedRequestSchema, presentationFrameAt, trackingClips, clipJobWindows, videoCarrierGeometry, plannedFailureRetryable, fitTransitions, estimateAudioEncodeSeconds, estimateVideoJobSeconds, lipsyncMonotonicSegments, lipsyncPictureBytes, lipsyncResultSourceFrames, lipsyncSourceSpan, hashMiniToolValue, isHdrTransfer, miniToolExecutionRequestSchema, planVideoEncodeChunks,
  plannedStageJobs, planVideoFrames, planVideoSplit, type FrameWindow, type FramesExecutionLayout, type MiniToolExecutionRequest, type MiniToolExecutionRetryRequest, type MiniToolPlannedRequest, type MiniToolPresentationRef, type MiniToolSourceBinding, type MiniToolStageJobs,
  type LipsyncExecutionLayout, type LipsyncTimeline, type TransitionExecutionLayout, type TransitionOutputProfile, planTransitionChunks, planVideoTimeline, transitionOutputProfile, type VideoEncodeChunk, type VideoEncoderRates, type VideoExecutionDialogue, type VideoJobWork, type VideoPresentationTable,
} from "@breatic/shared/mini-tools";
import { prepareVideoRemoveBackground, type PreparedVideoRemoveBackground } from "@domain/mini-tool/remove-background-preparation.service.js";
import { resolveSource } from "@domain/mini-tool/analysis.service.js";
import { planSlack, transitionSourceWindow } from "@domain/mini-tool/transition-source-window.js";
import { lipsyncClipCropBytes, lipsyncCompositeChunks, lipSyncDialogues, lipSyncModel, lipSyncPeople, lipsyncPersonStepKeys, lipsyncRawDiskBytes, lipsyncSharedStepKeys, lipsyncStepKey, lipSyncTimeline, type LipSyncGenerator, type LipSyncPerson } from "@domain/mini-tool/lipsync-admission.js";
import { eraseTracking, expandBox, type EraseTracking, type ExpandBox } from "@domain/mini-tool/erase-expand-admission.js";
import { assertOpaqueSource, eraseRangeGrid, trackingClipSeconds } from "@domain/mini-tool/tracking-range.js";
import { selectedToolInput } from "@domain/mini-tool/selected-tool-input.js";
import { executionPlanFromTask } from "@domain/mini-tool/execution-plan.service.js";
import { recordFromPlan } from "@domain/mini-tool/execution.service.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { estimateModelCredits, estimateTaskCredits, MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";
import * as pinRepo from "@domain/presentation/presentation-pin.repo.js";

/** Frozen common planning facts owned by the physical SQL task. */
interface ExecutionPlan {
  schemaVersion: 1; taskId: string; projectId: string; spaceId: string; targetNodeIds: string[];
  binding: MiniToolSourceBinding; sourceKey: string; draft: MiniToolPlannedRequest["draft"];
  analysisRefs: MiniToolPlannedRequest["analysis_refs"]; outputs: MiniToolPlannedRequest["outputs"][number][];
  model: string; credits: number; requestFingerprint: string; planFingerprint: string;
}
/** A frozen standard-4 container policy: class, precheck floor, size, prices and output limits. */
export type MiniToolContainerPolicy = { containerClass: "MiniToolContainerStd4"; precheckSeconds: number; size: MiniToolsConfig["classes"][string]; prices: MiniToolsConfig["prices"]; limits: MiniToolsConfig["plan_limits"] };
/** The model input a removal sends: prepared from the source by this run's (or the original run's) preparation `<taskId>:prep:0`. */
export type PreparedModelInputRef = { kind: "prepared"; inputId: "source"; job: string };
/** What every planned video execution freezes about its tool input (§7.11): the ref, both receipts and the selected version. */
type FrozenToolInput = {
  presentationRef: MiniToolPresentationRef;
  ledgerReceipts: Record<"source", VideoPresentationLedgerReceipt>;
  versionIds: Record<"source", string>;
  retry?: MiniToolExecutionRetryRequest["retry"];
};
/** The original server-owned execution stored under tasks.params.miniToolExecution. */
export type AcceptedMiniToolExecution = ExecutionPlan & (TransitionsExecution | (FrozenToolInput & (
  | { tool: "video.remove-bg"; provider: PreparedVideoRemoveBackground["provider"];
    body: Omit<PreparedVideoRemoveBackground["params"], "video"> & { video: PreparedModelInputRef };
    /** The model's own quote, frozen apart from the preparation so a failed-output retry quotes generate alone. */
    modelCredits: number;
    /** The standard-4 model-input preparation (§5.3): its policy, presentation-frame chunk windows and encode parameters (§91 D3b-5). */
    preparation: MiniToolContainerPolicy & { chunks: FrameWindow[]; chunkRetries: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] } } }
  | { tool: "video.extract-frames" | "video.split"; layout: FramesExecutionLayout;
    /** The container jobs each stage sends, counted from `layout` at admission (§97 D12-1); absent on plans admitted before. */
    stageJobs?: MiniToolStageJobs[];
    /** The standard-4 policy and the encoder start seconds every job of the layout pays, frozen so a retry re-quotes from them. */
    container: MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number };
    /** Each output's planned work in seconds without job start, frozen so a retry re-quotes its subset. */
    outputSeconds: number[] }
  | { tool: "video.lip-sync"; generator: LipSyncGenerator; timeline: LipsyncTimeline; usedRange: { start: 0; end: number };
    /** The rows with their registered audio durations, the people they name and the tracking model (DD §7.1). */
    dialogues: VideoExecutionDialogue[]; persons: LipSyncPerson[]; tracking: { model: string }; cropSize: number;
    /** The composite's face feather, a fraction of each face's shorter side, frozen from config/mini-tools.yaml (DD §7.2 step 6). */
    faceFeather: number;
    /** The container stages (frames-split §5.4) and their job counts, frozen beside each other as split freezes them (§97 D12-1). */
    layout: LipsyncExecutionLayout; stageJobs: MiniToolStageJobs[];
    /** The shared steps' frozen keys: `composite:<k>` per chunk and `stitch` (DD §7.1). */
    sharedStepKeys: Record<string, string>;
    /** The raw disk budget computed once at admission (execution design paragraph before §9.4); jobs read only this value. */
    container: MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number; rawDiskBytes: number } }
  | { tool: "video.erase";
    /** The tracking analysis the run reads and its RLE (execution design §10.4 request row). */
    tracking: EraseTracking;
    /** The range's presentation frames and the model grid over them (§10.4 model grid row). */
    range: FrameWindow; grid: ModelGrid;
    asyncRejection: { path: string; equals: unknown }; matte: { dilate: number; feather: number }; modelCredits: number;
    /** The composite chunks over the whole presentation and the frozen step keys (§10.4 steps row, §10.7). */
    composite: FrameWindow[]; stageJobs: MiniToolStageJobs[]; stepKeys: Record<string, string>;
    /** Each step's frozen quote, by step name (§10.4 quote row): a retry holds those not done on the original chain. */
    stepCredits: Record<string, number>;
    container: MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number } }
  | ({ tool: "video.expand";
    /** The even target layout (§10.5 geometry row), the resolved prompt, the frozen seed and the windows on the presentation. */
    layout: VideoExpandLayout; prompt: string; seed: number; windows: ModelWindow[]; modelFps: number; modelCredits: number;
    composite: FrameWindow[]; stageJobs: MiniToolStageJobs[]; stepKeys: Record<string, string>;
    /** Each step's frozen quote, by step name (§10.5 quote row): a retry holds those not done on the original chain. */
    stepCredits: Record<string, number>;
    container: MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number } } & ExpandBox)
)));
/**
 * A transitions run (frames-split §5.4, §7.17; §97 D23-3): both clips' frozen inputs by draft input id, the chunk layout on
 * the output grid, the output profile, and the classes its encode and window jobs run on.
 */
export type TransitionsExecution = {
  tool: "video.transitions";
  presentationRef: Record<string, MiniToolPresentationRef["source"]>;
  ledgerReceipts: Record<string, VideoPresentationLedgerReceipt>;
  versionIds: Record<string, string>;
  bindings: Record<string, MiniToolSourceBinding>;
  sourceKeys: Record<string, string>;
  retry?: MiniToolExecutionRetryRequest["retry"];
  layout: TransitionExecutionLayout; stageJobs: MiniToolStageJobs[]; profile: TransitionOutputProfile;
  container: MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number };
  windowContainer: Omit<MiniToolContainerPolicy, "containerClass"> & { containerClass: "MiniToolContainerGl" };
};
/** The plan facts every tool shares, before its tool-specific fields. */
type ExecutionCommon = Omit<ExecutionPlan, "binding" | "sourceKey" | "model" | "credits" | "requestFingerprint" | "planFingerprint">;
/** The complete executable projection hashed before its two identity fields are attached. */
type ExecutionProjection = AcceptedMiniToolExecution extends infer T ? T extends unknown ? Omit<T, "requestFingerprint" | "planFingerprint"> : never : never;
/** The narrow admission response, without prescribing terminal public result projection. */
export interface MiniToolExecutionAdmission { taskId: string; status: TaskStatusType }
/** The immutable task namespace, separate from analysis and worker-only steps. */
export interface MiniToolExecutionTaskParams extends Record<string, unknown> { miniToolExecution: AcceptedMiniToolExecution }
const replayIdentitySchema = z.object({
  schemaVersion: z.literal(1), tool: z.enum(["video.remove-bg", "video.extract-frames", "video.split", "video.lip-sync", "video.transitions", "video.erase", "video.expand"]),
  taskId: z.uuid(), projectId: z.uuid(), spaceId: z.uuid(), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const statusSchema = z.enum(TaskStatus);

/**
 * Return an accepted run before consulting changed registrations, drafts or prices.
 * @param task - The original physical parent.
 * @param request - The complete press-frozen request.
 * @param userId - The current editor.
 * @param fingerprint - Canonical whole-request identity.
 * @returns Original identity and current computation status.
 * @throws {ConflictError} When lane, actor or request identity differs.
 * @throws {z.ZodError} When the persisted computation status is invalid.
 */
function replay(task: TaskEntity, request: MiniToolExecutionRequest, userId: string, fingerprint: string): MiniToolExecutionAdmission {
  const identity = replayIdentitySchema.safeParse(task.params.miniToolExecution);
  if (task.source !== "mini_tool" || task.taskType !== (request.tool === "video.extract-frames" ? "image" : "video") || task.userId !== userId
    || task.projectId !== request.project_id || task.spaceId !== request.space_id || !identity.success || identity.data.tool !== request.tool
    || identity.data.taskId !== task.id || identity.data.projectId !== task.projectId
    || identity.data.spaceId !== task.spaceId || identity.data.requestFingerprint !== fingerprint) throw new ConflictError(t("server.idempotency.mismatch"));
  return { taskId: task.id, status: statusSchema.parse(task.status) };
}

/**
 * The frozen standard-4 policy of a container step.
 * @param containerClass - The configured class.
 * @param precheckSeconds - The step's precheck floor.
 * @param config - The acceptance snapshot.
 * @returns The policy.
 * @throws {Error} When the class is not configured.
 */
function containerPolicy(containerClass: string, precheckSeconds: number, config: MiniToolsConfig): MiniToolContainerPolicy {
  const size = config.classes[containerClass];
  if (size === undefined || containerClass !== "MiniToolContainerStd4") throw new Error(`Container class ${containerClass} is not a configured standard-4 class`);
  return { containerClass, precheckSeconds, size, prices: config.prices, limits: config.plan_limits };
}

/**
 * The one container quote rule (§5.4), for every container step, retries included: frozen seconds are the larger of the
 * precheck floor and the planned work; credits are those seconds at the frozen price, ceiled to the credit cent, never
 * under the task minimum.
 * @param policy - The frozen container policy.
 * @param plannedSeconds - The planned work's seconds over every job of the step.
 * @returns The credits.
 * @throws {Error} When pricing facts are invalid.
 */
function containerCredits(policy: MiniToolContainerPolicy, plannedSeconds: number): number {
  const usd = containerCostUsd({ wallMs: Math.max(policy.precheckSeconds, plannedSeconds) * 1000, cpuUsec: null }, policy.size, policy.prices);
  return Math.max(ceilToCreditCent(creditsForUsd(usd, env.CREDIT_MULTIPLIER)), MIN_TASK_CREDIT_COST);
}

/**
 * A model run's quote frozen per step (execution design §10.4, §10.5 quote rows): a model step is its price, a container
 * step its share of the one container quote rule (§5.4), the run's precheck floor spread over the container steps by their
 * planned seconds, so the shares add up to the rule's whole.
 * @param policy - The frozen container policy.
 * @param steps - Each step in order with its model credits or its planned container seconds.
 * @returns Each step's credits, by step name, in order.
 * @throws {Error} When pricing facts are invalid.
 */
function stepQuote(policy: MiniToolContainerPolicy, steps: readonly (readonly [string, { credits: number } | { seconds: number }])[]): Record<string, number> {
  const planned = steps.reduce((total, [, step]) => total + ("seconds" in step ? step.seconds : 0), 0);
  const scale = planned > 0 ? Math.max(policy.precheckSeconds, planned) / planned : 0;
  return Object.fromEntries(steps.map(([name, step]) => [name, "credits" in step ? step.credits
    : ceilToCreditCent(creditsForUsd(containerCostUsd({ wallMs: step.seconds * scale * 1000, cpuUsec: null }, policy.size, policy.prices), env.CREDIT_MULTIPLIER))]));
}

/**
 * The sum of frozen step quotes, settled to the cent: what a retry holds for the steps it still runs (§10.4, §10.5 quote
 * rows), as a removal retry holds its frozen model part alone.
 * @param credits - The steps' credits.
 * @returns The credits.
 * @throws {RangeError} When a figure is negative or not finite.
 */
function stepsCredits(credits: readonly number[]): number {
  return ceilToCreditCent(credits.reduce((total, value) => total + value, 0));
}

/**
 * The planned seconds of a layout: every batch job's start plus its outputs' work, every encoded output's work plus one
 * start per chunk job and one for its stitch.
 * @param layout - The layout.
 * @param seconds - Each output's frozen work, by output index.
 * @param startSeconds - The encoder's start seconds.
 * @returns The seconds.
 * @throws {never} Never.
 */
function layoutSeconds(layout: FramesExecutionLayout, seconds: ReadonlyMap<number, number>, startSeconds: number): number {
  /**
   * One output's frozen work.
   * @param index - The output index.
   * @returns Its seconds, 0 when not frozen.
   * @throws {never} Never.
   */
  const work = (index: number): number => seconds.get(index) ?? 0;
  return layout.batches.reduce((total, batch) => total + startSeconds + batch.reduce((sum, index) => sum + work(index), 0), 0)
    + layout.encodes.reduce((total, encode) => total + work(encode.outputIndex) + startSeconds * (encode.chunks.length + 1), 0);
}

/**
 * The encoder rates of the acceptance snapshot.
 * @param config - The snapshot.
 * @returns The rates.
 * @throws {never} Never.
 */
function encoderRates(config: MiniToolsConfig): VideoEncoderRates {
  const encoder = config.encoding.encoder;
  return { startSeconds: encoder.start_seconds, encodePixelsPerSecond: encoder.encode_pixels_per_second, decodeConvertPixelsPerSecond: encoder.decode_convert_pixels_per_second };
}

/**
 * The seconds one container job may take: the configured share of the task budget.
 * @param config - The snapshot.
 * @returns The seconds.
 * @throws {Error} When the task configuration cannot be read.
 */
function shareSeconds(config: MiniToolsConfig): number {
  return config.encoding.chunk_share * (getNodeTaskConfig().default_budget_ms / 1000);
}

/**
 * The decode pre-roll of a span (§5.4 estimate row, §7.17): from the latest source keyframe, presented or not, whose pts is
 * not after the span's first source frame, in that frame's source durations, rounded up. A frame's source duration is the
 * next source frame's start minus its own in the origin mapping; the last one ends at the declared or derived support end.
 * @param ledger - The validated full ledger.
 * @param first - The span's first presentation frame.
 * @param count - Its frame count.
 * @returns The pre-roll frames; 0 for a span without source frames.
 * @throws {never} Never.
 */
function prerollFrames(ledger: VideoPresentationLedger, first: number, count: number): number {
  const map = ledger.plan.originMapping;
  const [baseNumerator, baseDenominator] = [BigInt(map.timeBase.numerator), BigInt(map.timeBase.denominator)];
  const ticks: (bigint | null)[] = [];
  for (const entry of map.entries) {
    if (entry.kind !== "source") { ticks.push(null); continue; }
    for (let k = 0; k < entry.count; k += 1) ticks.push(BigInt(entry.start) + BigInt(k) * BigInt(entry.step));
  }
  const at = ticks.slice(first, first + Math.max(count, 1)).find((tick) => tick !== null);
  if (at === undefined || at === null) return 0;
  // Exact times as [numerator, denominator] with a positive denominator.
  const start: [bigint, bigint] = [at * baseNumerator, baseDenominator];
  const later = ticks.filter((tick): tick is bigint => tick !== null && tick > at);
  const end: [bigint, bigint] = later.length > 0 ? [later.reduce((low, tick) => (tick < low ? tick : low)) * baseNumerator, baseDenominator]
    : [BigInt(map.lastSource.supportEnd.numerator), BigInt(map.lastSource.supportEnd.denominator)];
  /**
   * Whether one exact time is at or before another.
   * @param left - One time.
   * @param right - The other.
   * @returns True when left is not after right.
   * @throws {never} Never.
   */
  const below = (left: [bigint, bigint], right: [bigint, bigint]): boolean => left[0] * right[1] <= right[0] * left[1];
  let keyframe: [bigint, bigint] | null = null;
  for (const { pts } of ledger.encoding.sourceKeyframes) {
    const time: [bigint, bigint] = [BigInt(pts.numerator), BigInt(pts.denominator)];
    if (below(time, start) && (keyframe === null || below(keyframe, time))) keyframe = time;
  }
  if (keyframe === null) return 0;
  // (start − keyframe) ÷ (end − start), rounded up.
  const numerator = (start[0] * keyframe[1] - keyframe[0] * start[1]) * (end[1] * start[1]);
  const denominator = (end[0] * start[1] - start[0] * end[1]) * (start[1] * keyframe[1]);
  if (denominator <= 0n) return 0;
  return Number((numerator + denominator - 1n) / denominator);
}

/**
 * The encode work of one frame span from the full ledger's encode facts: coded source size, display output, the plan's
 * bit depth and range, decoding from the span's source keyframe.
 * @param ledger - The validated full ledger.
 * @param first - The span's first presentation frame.
 * @param count - Its frame count.
 * @returns The job work.
 * @throws {never} Never.
 */
function spanWork(ledger: VideoPresentationLedger, first: number, count: number): VideoJobWork {
  const { plan, encoding } = ledger;
  return { encodedFrames: Math.max(count, 1), prerollFrames: prerollFrames(ledger, first, count), sourceWidth: encoding.codedWidth, sourceHeight: encoding.codedHeight,
    outputWidth: plan.display.width, outputHeight: plan.display.height, bitDepth: plan.source.bitDepth > 8 ? 10 : 8, hdr: isHdrTransfer(plan.source.transfer) };
}

/**
 * The exact §5.4 job layout of a run: each output's work from the full ledger's encode facts, stable batches within the
 * per-job cap and the chunk share, chunk windows for an output that alone exceeds the share, then one stitch for it.
 * @param outputs - The verified outputs.
 * @param table - The compact table.
 * @param ledger - The validated full ledger.
 * @param config - The acceptance snapshot.
 * @param tool - The tool.
 * @returns The layout and each output's work seconds.
 * @throws {RangeError} When the work or the configuration is out of range.
 */
function runLayout(outputs: MiniToolPlannedRequest["outputs"][number][], table: VideoPresentationTable, ledger: VideoPresentationLedger,
  config: MiniToolsConfig, tool: "video.extract-frames" | "video.split"): { layout: FramesExecutionLayout; works: number[] } {
  const rates = encoderRates(config);
  const flags = videoPresentationKeyframeFlags(ledger);
  const spans = outputs.map(({ recipe }) => ("frameIndex" in recipe ? { first: recipe.frameIndex, count: 1 } : "range" in recipe ? presentationFramesIn(table, recipe.range) : { first: 0, count: 1 }));
  const works = spans.map(({ first, count }) => estimateVideoJobSeconds(spanWork(ledger, first, count), rates) - rates.startSeconds);
  const share = shareSeconds(config);
  const { batches, oversized } = batchVideoRunOutputs(works, { maxOutputsPerJob: config.executions[tool].max_outputs_per_job, shareSeconds: share, fixedSeconds: rates.startSeconds });
  const encodes = oversized.map((index) => {
    const { first, count } = spans[index]!;
    const chunks = planVideoEncodeChunks({ keyframes: flags.slice(first, first + count), frameSeconds: works[index]! / Math.max(count, 1), targetSeconds: share - rates.startSeconds })
      .map((chunk) => ({ start: chunk.start + first, end: chunk.end + first }));
    return { outputIndex: outputs[index]!.outputIndex, chunks };
  });
  return { layout: { batches: batches.map((batch) => batch.map((index) => outputs[index]!.outputIndex)), encodes }, works };
}

/**
 * The model-input preparation of a removal (§5.3, §5.4): the whole presentation in one standard-4 job, or chunk windows
 * plus a stitch when it exceeds the chunk share.
 * @param ledger - The validated full ledger.
 * @param config - The acceptance snapshot.
 * @returns The chunk windows and the planned seconds.
 * @throws {RangeError} When the work is out of range.
 */
function preparationLayout(ledger: VideoPresentationLedger, config: MiniToolsConfig): { chunks: VideoEncodeChunk[]; seconds: number } {
  const rates = encoderRates(config);
  const flags = videoPresentationKeyframeFlags(ledger);
  const work = estimateVideoJobSeconds(spanWork(ledger, 0, flags.length), rates) - rates.startSeconds;
  const share = shareSeconds(config);
  if (rates.startSeconds + work <= share) return { chunks: [{ start: 0, end: flags.length }], seconds: rates.startSeconds + work };
  const chunks = planVideoEncodeChunks({ keyframes: flags, frameSeconds: work / flags.length, targetSeconds: share - rates.startSeconds });
  return { chunks, seconds: work + rates.startSeconds * (chunks.length + 1) };
}

/**
 * The lip-sync container work and its stage layout (frames-split §5.4 dispatch, budget and to-be-measured rows; execution design §9.3
 * and the paragraph before §9.4). The prepared video covers the used source range, chunked like a removal's preparation; each
 * person runs one faces job (the used frames decoded and searched by YuNet), one clip job (the prepared video decoded once,
 * forward, to the highest frame the result shows, and cropped and encoded over the result frames) and one stem job (the
 * result length encoded to AAC); each composite chunk decodes its source window once and every person's result and encodes
 * the picture over its result frames, chunked by the chunk share across loop and bounce segments, and cut further where its
 * source goes back and its window's raw frames would not fit the disk budget; the stitch encodes the result's audio once. The
 * disk budget, the class's disk times `encoding.raw_disk_share`, is computed here once and frozen.
 * @param ledger - The validated full ledger.
 * @param table - The compact table.
 * @param timing - The frozen timeline, the used range and the referenced people's count and crop size.
 * @param timing.timeline - The timeline.
 * @param timing.usedRange - The used source range.
 * @param timing.usedRange.start - Its start, 0.
 * @param timing.usedRange.end - Its end in seconds.
 * @param timing.persons - The referenced people.
 * @param timing.cropSize - The model's crop side.
 * @param timing.containerClass - The lip-sync jobs' container class, whose disk bounds their raw frames.
 * @param timing.anchor - The people analysis's anchor frame, from which the tracking clips are cut (execution design §10.2).
 * @param config - The acceptance snapshot.
 * @returns The layout, its planned seconds and the frozen raw disk budget.
 * @throws {AppError} When one faces, clip, stem, composite or stitch job alone would exceed one chunk share, or a clip's crops its raw disk.
 * @throws {RangeError} When the work or the configuration is out of range, or the anchor lies outside the used frames.
 */
export function lipSyncLayout(ledger: VideoPresentationLedger, table: VideoPresentationTable,
  timing: { timeline: LipsyncTimeline; usedRange: { start: 0; end: number }; persons: number; cropSize: number; containerClass: string; anchor: number }, config: MiniToolsConfig):
  { layout: LipsyncExecutionLayout; seconds: number; rawDiskBytes: number } {
  const rates = encoderRates(config);
  const share = shareSeconds(config);
  const used = presentationFramesIn(table, timing.usedRange).count;
  const keyframes = videoPresentationKeyframeFlags(ledger);
  const flags = keyframes.slice(0, used);
  const prepareWork = estimateVideoJobSeconds(spanWork(ledger, 0, used), rates) - rates.startSeconds;
  const preparation = rates.startSeconds + prepareWork <= share ? [{ start: 0, end: used }]
    : planVideoEncodeChunks({ keyframes: flags, frameSeconds: prepareWork / used, targetSeconds: share - rates.startSeconds });
  const { width, height } = ledger.plan.display;
  const picture = width * height;
  /**
   * Seconds to decode and convert this many source pixels at the source's depth and range.
   * @param pixels - The pixels.
   * @returns The seconds.
   * @throws {never} Never.
   */
  const decode = (pixels: number): number => pixels / rates.decodeConvertPixelsPerSecond[`${isHdrTransfer(ledger.plan.source.transfer) ? "hdr" : "sdr"}_${ledger.plan.source.bitDepth > 8 ? 10 : 8}bit`];
  const crop = timing.cropSize * timing.cropSize;
  const sources = lipsyncResultSourceFrames(timing.timeline, table);
  const resultFrames = sources.length;
  const highest = sources.reduce((top, frame) => Math.max(top, frame), 0);
  // A stem and the stitch each encode one AAC track over the result; the stitch copies the composite chunks' packets (§97 D24-3).
  const audio = estimateAudioEncodeSeconds(timing.timeline.duration, { startSeconds: rates.startSeconds, aacEncodeSecondsPerSecond: config.encoding.encoder.aac_encode_seconds_per_second });
  const faces = rates.startSeconds + used * (decode(picture) + picture / config.encoding.encoder.face_detect_pixels_per_second);
  const clip = rates.startSeconds + (highest + 1) * decode(picture) + resultFrames * (crop / rates.encodePixelsPerSecond);
  const rawDiskBytes = lipsyncRawDiskBytes(config.classes[timing.containerClass]!.disk_gb, config.encoding.raw_disk_share);
  if (lipsyncClipCropBytes(sources, timing.cropSize) > rawDiskBytes) throw new AppError(400, t("server.mini_tool.lipSyncStepTooLong"));
  const prerolls = new Map<string, number>();
  /**
   * One composite chunk's job seconds: its source window decoded once from the keyframe before it, every person's result
   * and the encode over its result frames.
   * @param window - The chunk's result frames.
   * @returns The seconds, its start included.
   * @throws {RangeError} When the window is empty.
   */
  const chunkSeconds = (window: FrameWindow): number => {
    const span = lipsyncSourceSpan(sources, window);
    const key = `${span.start}:${span.end}`;
    const preroll = prerolls.get(key) ?? prerollFrames(ledger, span.start, span.end - span.start);
    prerolls.set(key, preroll);
    return rates.startSeconds + (span.end - span.start + preroll) * decode(picture) + (window.end - window.start) * (decode(timing.persons * crop) + picture / rates.encodePixelsPerSecond);
  };
  const sourceBytes = lipsyncPictureBytes(width, height, ledger.plan.policy.emptyFill === "transparent");
  let composite: FrameWindow[];
  try {
    composite = lipsyncCompositeChunks({ sources, segments: lipsyncMonotonicSegments(timing.timeline, table, keyframes), seconds: chunkSeconds, shareSeconds: share,
      rawBytes: (span) => (span.end - span.start) * sourceBytes, diskBytes: rawDiskBytes });
  } catch (error) {
    if (error instanceof RangeError) throw new AppError(400, t("server.mini_tool.lipSyncStepTooLong"));
    throw error;
  }
  const compositeSeconds = composite.map(chunkSeconds);
  // Every single job fits one share, as every chunk of the preparation does (frames-split §5.4 dispatch row).
  if (Math.max(faces, clip, audio, ...compositeSeconds) > share) throw new AppError(400, t("server.mini_tool.lipSyncStepTooLong"));
  // Execution design §10.2: the anchor is tracked on [a, e) and, when a > 0, on [0, a] reversed; a forward clip other than
  // the preparation itself is prepared in one job, a reversed one in the chunks the frozen reverse buffer holds at the
  // prepared size, then stitched. Each job is priced over its own frames, the stitch by its start.
  const clips = trackingClips({ start: 0, end: used }, timing.anchor);
  const tracking = { forward: clips.forward === null || clips.forward.start === 0 ? [] : [clips.forward],
    reverse: clips.reverse === null ? [] : clipJobWindows(clips.reverse, "reverse", videoCarrierGeometry(ledger.plan.display, Number.MAX_SAFE_INTEGER), config.encoding.reverse_buffer_bytes) };
  const trackingWork = [...tracking.forward, ...tracking.reverse].reduce((total, window) => total + estimateVideoJobSeconds(spanWork(ledger, window.start, window.end - window.start), rates), 0)
    + (tracking.reverse.length > 1 ? rates.startSeconds : 0);
  const seconds = prepareWork + rates.startSeconds * (preparation.length + (preparation.length > 1 ? 1 : 0)) + trackingWork + timing.persons * (faces + clip + audio)
    + compositeSeconds.reduce((total, chunk) => total + chunk, 0) + audio;
  return { layout: { preparation, persons: timing.persons, composite, tracking }, seconds, rawDiskBytes };
}

/**
 * Refuse a run whose largest stage sends more standard-4 jobs at once than the parallel cap, with its reason (§97 D12-1;
 * frames-split §5.4).
 * @param stages - The planned stages and their job counts.
 * @param config - The acceptance snapshot.
 * @throws {AppError} When a stage exceeds the cap.
 */
function assertWithinParallelCap(stages: readonly MiniToolStageJobs[], config: MiniToolsConfig): void {
  const max = config.encoding.max_parallel_chunks;
  if (stages.some((stage) => stage.jobs > max)) throw new AppError(400, t("server.mini_tool.runTooLong", { max }));
}

/**
 * Admit a removal over its selected tool input (§5.3): the provider body takes the prepared model input of this run's
 * preparation `<taskId>:prep:0`; the quote is the model's (duration from the display) plus the preparation's container quote.
 * @param request - The fresh removal request.
 * @param common - The plan facts every tool shares.
 * @returns The plan projection.
 * @throws {ValidationError} When the tool input is not the selected, ready one.
 * @throws {AppError} When the model is unavailable, the source too long or the preparation over the parallel cap.
 * @throws {Error} When ingest, the ledger read or pricing fails.
 */
async function prepareRemoval(request: Extract<MiniToolPlannedRequest, { tool: "video.remove-bg" }>, common: ExecutionCommon): Promise<ExecutionProjection> {
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const config = structuredClone(getMiniToolsConfig());
  const settings = config.executions["video.remove-bg"];
  const prepared = await prepareVideoRemoveBackground(request.draft.source, settings.model);
  const { versionId, receipt } = await selectedToolInput(request.presentation_ref.source, prepared.binding, prepared.sourceKey, config);
  const ledger = await readVideoPresentationLedger(receipt, { maxBytes: config.presentation.source_ledger.max_bytes }, { deadlineAt });
  const { duration } = ledger.plan.display;
  const model = await estimateModelCredits(prepared.model, { params: prepared.params, durations: { video: [Number(duration.numerator) / Number(duration.denominator)] }, sources: ["video"] });
  if (model === undefined) throw new AppError(503, t("server.mini_tool.unavailable"));
  const layout = preparationLayout(ledger, config);
  assertWithinParallelCap(plannedStageJobs({ preparation: layout.chunks }), config);
  const preparation = { ...containerPolicy(settings.preparation.container_class, settings.preparation.precheck_seconds, config), chunks: layout.chunks,
    chunkRetries: config.encoding.chunk_retries, encode: { crf: config.presentation.crf, preset: config.presentation.preset } };
  return { ...common, tool: request.tool, binding: prepared.binding, sourceKey: prepared.sourceKey, model: prepared.model, provider: prepared.provider,
    body: { ...prepared.params, video: { kind: "prepared", inputId: "source", job: `${request.run_id}:prep:0` } },
    presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt }, versionIds: { source: versionId }, preparation,
    modelCredits: model.credits, credits: model.credits + containerCredits(preparation, layout.seconds) };
}

/**
 * Admit a lip-sync run (execution design §9.2, §9.3; DD §7.1): the selected model, the caps, the referenced people, the
 * registered audio durations, the timeline and the used source range are checked and frozen; the quote is each referenced
 * person's generation over the timeline and tracking over the used range, plus the standard-4 container work.
 * @param request - The fresh lip-sync request.
 * @param common - The plan facts every tool shares.
 * @returns The plan projection.
 * @throws {AppError} When a check refuses the run with its reason, or a model is not priced.
 * @throws {ValidationError} When the source, an audio or the tool input is not the registered, selected one.
 * @throws {Error} When ingest, the table or ledger read, or pricing fails.
 */
async function prepareLipSync(request: Extract<MiniToolPlannedRequest, { tool: "video.lip-sync" }>, common: ExecutionCommon): Promise<ExecutionProjection> {
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const config = structuredClone(getMiniToolsConfig());
  const { settings, model } = lipSyncModel(request, config.executions["video.lip-sync"]);
  if (request.outputs.length > settings.max_outputs) throw new ValidationError(t("server.mini_tool.foreignSource"));
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const { versionId, receipt } = await selectedToolInput(request.presentation_ref.source, binding, sourceKey, config);
  const limits = { maxBytes: config.presentation.source_ledger.max_bytes };
  const table = await readVideoPresentationCompact(receipt, limits, { deadlineAt });
  const ledger = await readVideoPresentationLedger(receipt, limits, { deadlineAt });
  const persons = await lipSyncPeople(request, request.project_id);
  const dialogues = await lipSyncDialogues(request);
  const { timeline, usedRange } = lipSyncTimeline(request, table, dialogues, settings, model);
  const generation = await estimateTaskCredits(model.name, { params: {}, durations: { video: [timeline.duration], audio: [timeline.duration] }, sources: ["video", "audio"] });
  const anchor = persons[0]!.anchor.frameIndex;
  const { layout, seconds: layoutWork, rawDiskBytes } = lipSyncLayout(ledger, table,
    { timeline, usedRange, persons: persons.length, cropSize: model.crop_size, containerClass: settings.container_class, anchor }, config);
  // Execution design §10.2: the one anchor is tracked on [a, e) and, when a > 0, on [0, a] reversed; each clip is priced
  // over its encoded length; the layout prepares the clips, and each person's tracks are joined.
  const clips = trackingClips({ start: 0, end: layout.preparation.at(-1)!.end }, anchor);
  let tracking = 0;
  for (const seconds of trackingClipSeconds(table, clips)) tracking += await estimateTaskCredits(settings.tracking.model, { params: {}, durations: { video: [seconds] }, sources: ["video"] });
  const seconds = layoutWork + persons.length * encoderRates(config).startSeconds;
  const stageJobs = plannedStageJobs(layout);
  // The reversed tracking chunks cover [0, anchor] whatever the outputs are, so their refusal names the anchor (§10.2).
  if (stageJobs.some((stage) => stage.stage === "track_prepare" && stage.jobs > config.encoding.max_parallel_chunks)) {
    throw new AppError(400, t("server.mini_tool.lipSyncAnchorTooLate"));
  }
  assertWithinParallelCap(stageJobs, config);
  const container = { ...containerPolicy(settings.container_class, settings.precheck_seconds, config), startSeconds: config.encoding.encoder.start_seconds,
    encode: { crf: config.presentation.crf, preset: config.presentation.preset }, chunkRetries: config.encoding.chunk_retries, rawDiskBytes };
  const plan = { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt },
    versionIds: { source: versionId }, model: model.name, container, layout, stageJobs, timeline, usedRange, dialogues, persons, cropSize: model.crop_size,
    faceFeather: settings.face_feather,
    tracking: { model: settings.tracking.model },
    generator: { backend: "wavespeed-crop" as const, modelId: model.name, schemaFingerprint: model.schema_fingerprint, providerSyncMode: model.accepts_sync_mode ? "cut_off" as const : null },
    credits: persons.length * (generation + tracking) + containerCredits(container, seconds) };
  // Every step key is computed once here and frozen (DD §7.1 steps row): over the plan's fingerprint before the keys, which
  // the keys cannot be part of; a retry copies them, so a step done anywhere along its chain is found again.
  const keyed = await hashMiniToolValue(plan);
  return { ...plan, persons: persons.map((person) => ({ ...person, stepKeys: lipsyncPersonStepKeys(keyed, person, clips) })),
    sharedStepKeys: lipsyncSharedStepKeys(keyed, layout.composite.length, clips) };
}

/**
 * Seconds to decode and convert one pixel of a source at its depth and range tier.
 * @param ledger - The validated full ledger.
 * @param rates - The encoder rates.
 * @returns The seconds per pixel.
 * @throws {never} Never.
 */
function decodePixelSeconds(ledger: VideoPresentationLedger, rates: VideoEncoderRates): number {
  return 1 / rates.decodeConvertPixelsPerSecond[`${isHdrTransfer(ledger.plan.source.transfer) ? "hdr" : "sdr"}_${ledger.plan.source.bitDepth > 8 ? 10 : 8}bit`];
}

/**
 * The composite chunks of a model run over the whole presentation (frames-split §5.4): one job when it fits the chunk share,
 * else keyframe-aligned chunks of it.
 * @param ledger - The validated full ledger.
 * @param frameSeconds - One output frame's composite work.
 * @param config - The acceptance snapshot.
 * @returns The chunks.
 * @throws {RangeError} When the work is out of range.
 */
function compositeChunks(ledger: VideoPresentationLedger, frameSeconds: number, config: MiniToolsConfig): FrameWindow[] {
  const rates = encoderRates(config);
  const share = shareSeconds(config);
  const flags = videoPresentationKeyframeFlags(ledger);
  if (rates.startSeconds + flags.length * frameSeconds <= share) return [{ start: 0, end: flags.length }];
  return planVideoEncodeChunks({ keyframes: flags, frameSeconds, targetSeconds: share - rates.startSeconds });
}

/**
 * The selected tool input of a model run and its compact table and full ledger, refusing a transparent source (execution
 * design §10.4 transparent source row: neither Bria nor VACE takes alpha).
 * @param request - The fresh request.
 * @param config - The acceptance snapshot.
 * @returns The source and its presentation.
 * @throws {AppError} When the source presents with transparency.
 * @throws {ValidationError} When the tool input is not the selected, ready one.
 * @throws {Error} When ingest or a read fails.
 */
async function modelRunSource(request: Extract<MiniToolPlannedRequest, { tool: "video.erase" | "video.expand" }>, config: MiniToolsConfig): Promise<{
  binding: MiniToolSourceBinding; sourceKey: string; versionId: string; receipt: VideoPresentationLedgerReceipt; table: VideoPresentationTable; ledger: VideoPresentationLedger;
}> {
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const { versionId, receipt } = await selectedToolInput(request.presentation_ref.source, binding, sourceKey, config);
  const limits = { maxBytes: config.presentation.source_ledger.max_bytes };
  const table = await readVideoPresentationCompact(receipt, limits, { deadlineAt });
  const ledger = await readVideoPresentationLedger(receipt, limits, { deadlineAt });
  assertOpaqueSource(ledger);
  return { binding, sourceKey, versionId, receipt, table, ledger };
}

/**
 * The frozen standard-4 policy of a model run's container steps.
 * @param settings - The tool's configured container class and precheck.
 * @param settings.container_class - The class.
 * @param settings.precheck_seconds - The precheck floor.
 * @param config - The acceptance snapshot.
 * @returns The policy with the encoder start, encode parameters and chunk retries.
 * @throws {Error} When the class is not configured.
 */
function runContainer(settings: { container_class: string; precheck_seconds: number }, config: MiniToolsConfig): MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number } {
  return { ...containerPolicy(settings.container_class, settings.precheck_seconds, config), startSeconds: config.encoding.encoder.start_seconds,
    encode: { crf: config.presentation.crf, preset: config.presentation.preset }, chunkRetries: config.encoding.chunk_retries };
}

/**
 * Admit an erase run (execution design §10.4): the anchor inside the range, the one completed tracking analysis made for
 * this selection, the model grid over the range within Bria's seconds; the quote is Bria over the grid's seconds plus the
 * prepare, mask, composite and stitch container work.
 * @param request - The fresh erase request.
 * @param common - The plan facts every tool shares.
 * @returns The plan projection.
 * @throws {AppError} When a check refuses the run with its reason, or the deployment offers no erase.
 * @throws {ValidationError} When the tool input is not the selected, ready one.
 * @throws {Error} When ingest, a read or pricing fails.
 */
async function prepareErase(request: Extract<MiniToolPlannedRequest, { tool: "video.erase" }>, common: ExecutionCommon): Promise<ExecutionProjection> {
  const config = structuredClone(getMiniToolsConfig());
  const settings = config.executions["video.erase"];
  if (settings === undefined) throw new AppError(400, t("server.mini_tool.unavailable"));
  const { binding, sourceKey, versionId, receipt, table, ledger } = await modelRunSource(request, config);
  const { params } = request.draft;
  const { first, count, grid } = eraseRangeGrid(table, params.range, params.anchor, settings.model);
  const tracking = await eraseTracking(request, request.project_id, binding.canonicalURL);
  const modelCredits = await estimateTaskCredits(settings.model.name, { params: {}, durations: { video: [grid.frameCount / grid.rate] }, sources: ["video"] });
  const rates = encoderRates(config);
  const pixels = ledger.plan.display.width * ledger.plan.display.height;
  const decode = pixels * decodePixelSeconds(ledger, rates);
  const encode = pixels / rates.encodePixelsPerSecond;
  // A composite frame decodes the source and, inside the range, the result, and encodes the output (§10.4 composite row).
  const frameSeconds = 2 * decode + encode;
  const composite = compositeChunks(ledger, frameSeconds, config);
  const { duration } = ledger.plan.display;
  const stageJobs = plannedStageJobs({ preparation: [{ start: first, end: first + count }], composite });
  assertWithinParallelCap(stageJobs, config);
  const container = runContainer(settings, config);
  // One quote per step (§10.4 quote row): Bria for generate; prepare, mask, each composite chunk and stitch their container work.
  const stepCredits = stepQuote(container, [
    ["prepare", { seconds: estimateVideoJobSeconds(spanWork(ledger, first, count), rates) }],
    ["mask", { seconds: rates.startSeconds + grid.frameCount * encode }],
    ["generate", { credits: modelCredits }],
    ...composite.map((chunk, k) => [`composite:${k}`, { seconds: rates.startSeconds + (chunk.end - chunk.start) * frameSeconds }] as const),
    ["stitch", { seconds: estimateAudioEncodeSeconds(Number(duration.numerator) / Number(duration.denominator),
      { startSeconds: rates.startSeconds, aacEncodeSecondsPerSecond: config.encoding.encoder.aac_encode_seconds_per_second }) }],
  ]);
  const plan = { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt },
    versionIds: { source: versionId }, model: settings.model.name, tracking, range: { start: first, end: first + count }, grid,
    asyncRejection: settings.model.async_rejection, matte: settings.matte, modelCredits, composite, stageJobs, container, stepCredits,
    credits: Math.max(stepsCredits(Object.values(stepCredits)), MIN_TASK_CREDIT_COST) };
  // Step keys are frozen over the plan's fingerprint before them, as lip-sync's are (§10.7), so a retry finds every done step.
  const keyed = await hashMiniToolValue(plan);
  return { ...plan, stepKeys: Object.fromEntries(Object.keys(stepCredits).map((step) => [step, lipsyncStepKey(keyed, null, step)])) };
}

/**
 * Admit an expand run (execution design §10.5): the source within the duration limit, the even target within the long-side
 * limit, the standard frame and its two rectangles, the resolved prompt, a random seed and the windows over the whole
 * presentation; the quote is each window's VACE price plus every window's three container jobs, the composite and stitch.
 * @param request - The fresh expand request.
 * @param common - The plan facts every tool shares.
 * @returns The plan projection.
 * @throws {AppError} When a check refuses the run with its reason, or the deployment offers no expand.
 * @throws {ValidationError} When the tool input is not the selected, ready one.
 * @throws {Error} When ingest, a read or pricing fails.
 */
async function prepareExpand(request: Extract<MiniToolPlannedRequest, { tool: "video.expand" }>, common: ExecutionCommon): Promise<ExecutionProjection> {
  const config = structuredClone(getMiniToolsConfig());
  const settings = config.executions["video.expand"];
  if (settings === undefined) throw new AppError(400, t("server.mini_tool.unavailable"));
  const { binding, sourceKey, versionId, receipt, table, ledger } = await modelRunSource(request, config);
  const { display } = ledger.plan;
  const videoSeconds = Number(display.duration.numerator) / Number(display.duration.denominator);
  if (videoSeconds > settings.max_duration_seconds) throw new AppError(400, t("server.mini_tool.expandTooLong", { max: settings.max_duration_seconds }));
  const layout = videoExpandLayout(request.draft.params.frame, display, settings.max_target_side);
  if (layout.overSide) throw new AppError(400, t("server.mini_tool.expandTooLarge", { max: settings.max_target_side }));
  const box = expandBox(layout, display);
  const prompt = extractPromptText(request.draft.params.prompt).trim() || (miniToolById("video.expand")?.prompt?.defaultText ?? "");
  const count = presentationFramesIn(table, { start: 0, end: Number.POSITIVE_INFINITY }).count;
  const windows = planModelWindows(Array.from({ length: count }, (_unused, at) => {
    const frame = presentationFrameAt(table, at);
    return { start: frame.pts, end: frame.displayEnd };
  }), settings.model.max_window_seconds, settings.model.overlap_seconds);
  const prices: number[] = [];
  for (const window of windows) prices.push(await estimateTaskCredits(settings.model.name, { params: { duration: window.duration }, durations: { video: [window.duration] }, sources: ["video"] }));
  const modelCredits = prices.reduce((total, price) => total + price, 0);
  const rates = encoderRates(config);
  const decode = decodePixelSeconds(ledger, rates);
  const standard = box.frame.width * box.frame.height;
  // A composite frame decodes the source and up to two overlapping backgrounds, and encodes the target.
  const frameSeconds = (display.width * display.height + 2 * standard) * decode + layout.width * layout.height / rates.encodePixelsPerSecond;
  const composite = compositeChunks(ledger, frameSeconds, config);
  const stageJobs = plannedStageJobs({ preparation: [], composite });
  assertWithinParallelCap(stageJobs, config);
  const container = runContainer(settings, config);
  // One quote per step (§10.5 quote row): each window renders its grid in the standard frame and its mask, a later window
  // takes one condition frame, and its VACE price; then each composite chunk and the stitch.
  const stepCredits = stepQuote(container, [
    ...windows.flatMap((window, k) => {
      const frames = settings.model.model_fps * window.duration;
      return [
        [`window:${k}`, { seconds: rates.startSeconds + frames * (display.width * display.height * decode + standard / rates.encodePixelsPerSecond) }],
        [`window_mask:${k}`, { seconds: rates.startSeconds + frames * standard / rates.encodePixelsPerSecond }],
        ...(k > 0 ? [[`condition:${k}`, { seconds: rates.startSeconds + standard * decode }] as const] : []),
        [`generate:${k}`, { credits: prices[k]! }],
      ] as const;
    }),
    ...composite.map((chunk, k) => [`composite:${k}`, { seconds: rates.startSeconds + (chunk.end - chunk.start) * frameSeconds }] as const),
    ["stitch", { seconds: estimateAudioEncodeSeconds(videoSeconds, { startSeconds: rates.startSeconds, aacEncodeSecondsPerSecond: config.encoding.encoder.aac_encode_seconds_per_second }) }],
  ]);
  const plan = { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt },
    versionIds: { source: versionId }, model: settings.model.name, layout, ...box, prompt, seed: randomInt(0, 2 ** 31 - 1), windows,
    modelFps: settings.model.model_fps, modelCredits, composite, stageJobs, container, stepCredits, credits: Math.max(stepsCredits(Object.values(stepCredits)), MIN_TASK_CREDIT_COST) };
  const keyed = await hashMiniToolValue(plan);
  return { ...plan, stepKeys: Object.fromEntries(Object.keys(stepCredits).map((step) => [step, lipsyncStepKey(keyed, null, step)])) };
}

/**
 * Verify current registered bytes and receipt, then rederive every exact recipe using shared planners.
 * @param request - A fresh complete press snapshot.
 * @returns The immutable server plan before its independent fingerprints.
 * @throws {ValidationError} When source, readiness, receipt or any ordered recipe differs.
 * @throws {Error} When current metadata or bounded compact delivery fails.
 */
async function prepare(request: MiniToolPlannedRequest): Promise<ExecutionProjection> {
  const common: ExecutionCommon = { schemaVersion: 1, taskId: request.run_id, projectId: request.project_id, spaceId: request.space_id,
    targetNodeIds: request.outputs.map((output) => output.nodeId), draft: request.draft, analysisRefs: request.analysis_refs, outputs: request.outputs };
  if (request.tool === "video.remove-bg") return prepareRemoval(request, common);
  if (request.tool === "video.lip-sync") return prepareLipSync(request, common);
  if (request.tool === "video.transitions") return prepareTransitions(request, common);
  if (request.tool === "video.erase") return prepareErase(request, common);
  if (request.tool === "video.expand") return prepareExpand(request, common);
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const config = structuredClone(getMiniToolsConfig());
  const maxOutputs = config.executions[request.tool].max_outputs;
  if (request.outputs.length > maxOutputs) throw new ValidationError(t("server.mini_tool.tooManyOutputs", { max: maxOutputs }));
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const { versionId, receipt } = await selectedToolInput(request.presentation_ref.source, binding, sourceKey, config);
  const limits = { maxBytes: config.presentation.source_ledger.max_bytes };
  const table = await readVideoPresentationCompact(receipt, limits, { deadlineAt });
  const ledger = await readVideoPresentationLedger(receipt, limits, { deadlineAt });
  let outputs: MiniToolPlannedRequest["outputs"][number][];
  try {
    outputs = request.tool === "video.extract-frames"
      ? planVideoFrames(table, request.draft.params, maxOutputs).map(({ outputIndex, frameIndex, pts }) => ({ outputIndex, nodeId: request.outputs[outputIndex]?.nodeId ?? "", recipe: { kind: "frame" as const, frameIndex, pts } }))
      : planVideoSplit(table, request.draft.params.cuts).map(({ outputIndex, start, end }) => ({ outputIndex, nodeId: request.outputs[outputIndex]?.nodeId ?? "", recipe: { kind: "segment" as const, range: { start, end } } }));
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof z.ZodError)) throw error;
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  if (outputs.length > maxOutputs || canonicalMiniToolValue(outputs) !== canonicalMiniToolValue(request.outputs)) throw new ValidationError(t("server.mini_tool.foreignSource"));
  const { layout, works } = runLayout(outputs, table, ledger, config, request.tool);
  const stageJobs = plannedStageJobs(layout);
  assertWithinParallelCap(stageJobs, config);
  const container = { ...containerPolicy(config.executions[request.tool].container_class, config.executions[request.tool].precheck_seconds, config),
    startSeconds: config.encoding.encoder.start_seconds,
    // §93 D5-2: the run's encode parameters and retry cap, frozen like the removal preparation's (§5.4).
    encode: { crf: config.presentation.crf, preset: config.presentation.preset }, chunkRetries: config.encoding.chunk_retries };
  const seconds = layoutSeconds(layout, new Map(outputs.map((output, index) => [output.outputIndex, works[index]!])), container.startSeconds);
  return { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt },
    versionIds: { source: versionId }, layout, stageJobs, outputSeconds: works, model: request.tool, container, credits: containerCredits(container, seconds) };
}

/**
 * Freeze a transitions run (frames-split §5.4 budget row, §7.17 transition output profile row; §97 D23-3): each clip's selected tool input and
 * full ledger, the output profile of the two plans in timeline order, the timeline on its grid and every chunk boundary,
 * the stage counts, and the encode and window classes; the quote is the encode work of every output frame, each job's
 * start and the stitch's one AAC track.
 * @param request - The fresh request.
 * @param common - The shared facts.
 * @returns The projection.
 * @throws {AppError} When the deployment offers no transitions, or a stage exceeds the parallel cap.
 * @throws {ValidationError} When a clip's source or plan does not fit the request.
 * @throws {Error} When a read fails.
 */
async function prepareTransitions(request: Extract<MiniToolPlannedRequest, { tool: "video.transitions" }>, common: ExecutionCommon): Promise<ExecutionProjection> {
  const config = structuredClone(getMiniToolsConfig());
  const settings = config.executions["video.transitions"];
  if (settings === undefined) throw new AppError(400, t("server.mini_tool.unavailable"));
  if (request.outputs.length > settings.max_outputs) throw new ValidationError(t("server.mini_tool.foreignSource"));
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const limits = { maxBytes: config.presentation.source_ledger.max_bytes };
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const clips = request.draft.params.clips;
  const inputs = await Promise.all(clips.map(async (clip) => {
    const input = request.draft.inputs.find((candidate) => candidate.inputId === clip.inputId);
    const ref = request.presentation_ref[clip.inputId];
    if (input === undefined || ref === undefined) throw new ValidationError(t("server.mini_tool.foreignSource"));
    // Only the URL names the registered source; the rest of the draft source shape is the host's.
    const resolved = await resolveSource({ ...request.draft.source, canonicalURL: input.url });
    const { versionId, receipt } = await selectedToolInput(ref, resolved.binding, resolved.sourceKey, config);
    return { inputId: clip.inputId, ...resolved, versionId, receipt, ledger: await readVideoPresentationLedger(receipt, limits, { deadlineAt }) };
  }));
  const [first, second] = inputs as [typeof inputs[number], typeof inputs[number]];
  const encode = { crf: config.presentation.crf, preset: config.presentation.preset };
  const profile = transitionOutputProfile(first.ledger.plan, second.ledger.plan, { encode });
  let timeline: ReturnType<typeof planVideoTimeline>;
  try {
    timeline = planVideoTimeline(clips, profile.fps);
    // §5.4: the panel's own length bound, checked again; a junction it would turn into a Cut does not fit.
    if (fitTransitions(clips, profile.fps).slice(0, -1).some((clip, index) => clip.transition.kind !== clips[index]!.transition.kind)) {
      throw new RangeError("A transition exceeds its duration bounds");
    }
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof z.ZodError)) throw error;
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  const rates = encoderRates(config);
  const outputPixels = profile.width * profile.height;
  /**
   * Seconds to decode one source frame of a clip at its coded size and its depth and range tier.
   * @param ledger - The clip's full ledger.
   * @returns The seconds.
   * @throws {never} Never.
   */
  const decodeFrame = (ledger: VideoPresentationLedger): number => ledger.encoding.codedWidth * ledger.encoding.codedHeight
    / rates.decodeConvertPixelsPerSecond[`${isHdrTransfer(ledger.plan.source.transfer) ? "hdr" : "sdr"}_${ledger.plan.source.bitDepth > 8 ? 10 : 8}bit`];
  const gl = config.classes[settings.window_container_class];
  if (gl === undefined || settings.window_container_class !== "MiniToolContainerGl" || gl.render_pixels_per_second === undefined) {
    throw new Error(`Container class ${settings.window_container_class} is not the configured GL class with a render rate`);
  }
  const renderRate = gl.render_pixels_per_second;
  /**
   * One output frame's work, by the same per-clip cost the quote sums: each clip it shows decoded at that clip's own size and
   * tier, its encode, and a window frame's render.
   * @param frame - The output frame.
   * @param window - Whether it lies in the overlap window.
   * @returns The seconds.
   * @throws {never} Never.
   */
  const frameSeconds = (frame: number, window: boolean): number => timeline.clips.reduce((total, clip, at) =>
    frame >= clip.startFrame && frame < clip.startFrame + clip.frameCount ? total + decodeFrame(inputs[at]!.ledger) : total, 0)
    + outputPixels / rates.encodePixelsPerSecond + (window ? outputPixels / renderRate : 0);
  // ponytail: a chunk's decode pre-roll is not in its size, so a chunk can pass its share by at most one GOP's decode (the
  // quote counts it). If a chunk is ever measured past its share, size each chunk with its first frame's pre-roll.
  const layout = planTransitionChunks(timeline, { targetSeconds: shareSeconds(config) - rates.startSeconds, frameSeconds });
  const stageJobs = plannedStageJobs(layout);
  assertWithinParallelCap(stageJobs, config);
  const container = { ...containerPolicy(settings.container_class, settings.precheck_seconds, config), startSeconds: rates.startSeconds, encode, chunkRetries: config.encoding.chunk_retries };
  const size = { instance_type: gl.instance_type, vcpu: gl.vcpu, memory_gib: gl.memory_gib, disk_gb: gl.disk_gb };
  const windowContainer = { containerClass: "MiniToolContainerGl" as const, precheckSeconds: settings.precheck_seconds, size, prices: config.prices, limits: config.plan_limits };
  // frames-split §5.4 (transition chunks): each chunk decodes each clip's source frames it shows, pre-roll included, at that
  // clip's size and tier; it encodes its output frames, and a window chunk also renders them.
  const fpsSeconds = Number(profile.fps.denominator) / Number(profile.fps.numerator);
  /**
   * The decode seconds of one chunk, summed over the clips it shows.
   * @param chunk - The chunk's output frames.
   * @returns The seconds.
   * @throws {RangeError} When a frame lies outside a clip's presentation.
   */
  const chunkDecode = (chunk: FrameWindow): number => timeline.clips.reduce((total, clip, at) => {
    const low = Math.max(chunk.start, clip.startFrame);
    const high = Math.min(chunk.end, clip.startFrame + clip.frameCount);
    if (high <= low) return total;
    const { ledger } = inputs[at]!;
    const window = transitionSourceWindow(ledger.plan.presentation, clip, { start: low, end: high }, profile.fps, planSlack(ledger.plan));
    const first = window.start;
    const count = window.end - first;
    return total + (count + prerollFrames(ledger, first, count)) * decodeFrame(ledger);
  }, 0);
  const chunks = [...layout.encode, ...layout.window];
  const windowFrames = layout.window.reduce((total, chunk) => total + chunk.end - chunk.start, 0);
  const seconds = chunks.reduce((total, chunk) => total + chunkDecode(chunk), 0) + timeline.frameCount * outputPixels / rates.encodePixelsPerSecond
    + windowFrames * outputPixels / renderRate + rates.startSeconds * chunks.length
    + estimateAudioEncodeSeconds(timeline.frameCount * fpsSeconds, { startSeconds: rates.startSeconds, aacEncodeSecondsPerSecond: config.encoding.encoder.aac_encode_seconds_per_second });
  /**
   * One value per clip input, by input id.
   * @param pick - The value of an input.
   * @returns The record.
   * @throws {never} Never.
   */
  const byInput = <T>(pick: (input: typeof first) => T): Record<string, T> => Object.fromEntries(inputs.map((input) => [input.inputId, pick(input)]));
  return { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref,
    ledgerReceipts: byInput((input) => input.receipt), versionIds: byInput((input) => input.versionId), bindings: byInput((input) => input.binding),
    sourceKeys: byInput((input) => input.sourceKey), layout, stageJobs, profile, model: request.tool, container, windowContainer, credits: containerCredits(container, seconds) };
}

/**
 * Quote a fresh planned run by the admission's own computation, with no side effect (§97 D26-1): the credits admission would
 * freeze for this body, task minimum included; a body admission refuses is refused the same way.
 * @param body - The fresh press-frozen request.
 * @param userId - The authenticated actor.
 * @returns The credits.
 * @throws {NotFoundError} When the actor is not a member of the project.
 * @throws {ForbiddenError} When a viewer asks.
 * @throws {AppError} When admission would refuse the body.
 * @throws {Error} When a read fails.
 */
export async function quoteMiniToolExecution(body: MiniToolPlannedRequest, userId: string): Promise<{ credits: number }> {
  const request = miniToolPlannedRequestSchema.parse(structuredClone(body));
  const role = await projectAuthService.loadProjectRole(userId, request.project_id);
  if (role === null) throw new NotFoundError(t("server.error.not_found"));
  if (role === "viewer") throw new ForbiddenError(t("server.error.forbidden"));
  return { credits: (await prepare(request)).credits };
}

/**
 * Admit or replay one complete execution through the existing task, hold and queue owners.
 * @param body - Fresh or retry press-frozen inputs.
 * @param userId - The authenticated initiating actor.
 * @param start - Existing application's row, hold and queue adapter; only a durable winner calls it.
 * @returns Original identity and current status.
 * @throws {NotFoundError} When current Project membership or original retry ownership is absent.
 * @throws {ForbiddenError} When a viewer starts work.
 * @throws {ConflictError} When an identity is occupied or an output already has active execution.
 * @throws {ValidationError} When source, receipt, exact plan or failed subset is invalid.
 * @throws {Error} When preparation, persistence or startup fails.
 */
export async function acceptMiniToolExecution(body: MiniToolExecutionRequest, userId: string, start: (accepted: AcceptedMiniToolExecution) => Promise<"pending" | "failed">): Promise<MiniToolExecutionAdmission> {
  const request = miniToolExecutionRequestSchema.parse(structuredClone(body));
  const role = await projectAuthService.loadProjectRole(userId, request.project_id);
  if (role === null) throw new NotFoundError(t("server.error.not_found"));
  if (role === "viewer") throw new ForbiddenError(t("server.error.forbidden"));
  const fingerprint = await hashMiniToolValue(request);
  const previous = await taskRepo.getMiniToolExecutionTask(request.run_id);
  if (previous !== null) return replay(previous, request, userId, fingerprint);
  let claim: { accepted: AcceptedMiniToolExecution; inserted: boolean };
  if ("retry" in request) claim = await claimRetry(request, userId, fingerprint);
  else {
    const plan = await prepare(request);
    claim = await db.transaction((tx) => claimPrepared(plan, request, userId, fingerprint, tx));
  }
  if (!claim.inserted) {
    const winner = await taskRepo.getMiniToolExecutionTask(request.run_id);
    if (winner === null) throw new ConflictError(t("server.idempotency.mismatch"));
    return replay(winner, request, userId, fingerprint);
  }
  await start(claim.accepted);
  const current = await taskRepo.getMiniToolExecutionTask(request.run_id);
  if (current === null) throw new Error("Accepted execution task disappeared");
  return { taskId: current.id, status: statusSchema.parse(current.status) };
}

/**
 * Fingerprint and claim a fully verified plan, initializing its public output slots atomically.
 * @param plan - Complete server-owned executable facts.
 * @param request - The fresh or retry identity.
 * @param userId - The new execution's actor.
 * @param fingerprint - Complete request fingerprint.
 * @param tx - The admission transaction; the run's execution pin is written in it (§7.15).
 * @returns The frozen plan and whether its task UUID was claimed.
 * @throws {Error} When hashing, task or pin persistence fails.
 */
async function claimPrepared(plan: ExecutionProjection, request: MiniToolExecutionRequest, userId: string, fingerprint: string, tx: DbTx): Promise<{ accepted: AcceptedMiniToolExecution; inserted: boolean }> {
  const accepted: AcceptedMiniToolExecution = { ...plan, requestFingerprint: fingerprint, planFingerprint: await hashMiniToolValue(plan) };
  const inserted = await taskRepo.claimMiniToolExecutionTask({ id: request.run_id, userId, projectId: request.project_id, spaceId: request.space_id,
    taskType: request.tool === "video.extract-frames" ? "image" : "video", model: accepted.model, params: { miniToolExecution: accepted },
    ...(request.tool === "video.remove-bg" ? {} : { result: { miniToolExecution: { schemaVersion: 1, runId: accepted.taskId, status: "pending", planFingerprint: accepted.planFingerprint,
      resultVersion: 0, sourceBindings: [accepted.binding], outputs: accepted.outputs.map((output) => ({ ...output, result: null, late: false })), usage: [], billingState: "idle", error: null } } }),
  }, tx);
  // The run's inputs stay alive until it can no longer be retried (§7.15 execution row).
  const inputs = accepted.tool === "video.transitions"
    ? Object.entries(accepted.presentationRef).map(([inputId, ref]) => ({ toolInputId: ref.toolInputId, sourceKey: accepted.sourceKeys[inputId]! }))
    : [{ toolInputId: accepted.presentationRef.source.toolInputId, sourceKey: accepted.sourceKey }];
  if (inserted) {
    for (const { toolInputId, sourceKey } of inputs) {
      await presentationPinService.acquire({ holderKind: "execution", holderId: accepted.taskId, toolInputId, objectKeys: presentationPinService.ledgerObjectKeys(sourceKey, toolInputId) }, tx);
    }
  }
  return { accepted, inserted };
}

/**
 * Serialize retry claims on the immutable original task without modifying its plan, results or funds.
 * @param request - A new execution selecting original failed output indices.
 * @param userId - Any current Project editor starting this new execution.
 * @param fingerprint - Whole retry request identity.
 * @returns One new claimed task, or the existing same-run winner.
 * @throws {NotFoundError} When the original execution belongs to another Project, Space or tool.
 * @throws {ValidationError} When any selected slot is not failed, was registered late or was already taken over by a retry.
 * @throws {ConflictError} When an overlapping execution is still active.
 * @throws {Error} When original frozen planning or transactional persistence is invalid.
 */
async function claimRetry(request: MiniToolExecutionRetryRequest, userId: string, fingerprint: string): Promise<{ accepted: AcceptedMiniToolExecution; inserted: boolean }> {
  // A retry of a failed retry shares the first execution's admission lock with
  // direct retries; otherwise two different original rows could reserve one node.
  let root = await taskRepo.getMiniToolExecutionTask(request.retry.runId);
  if (root === null || root.projectId !== request.project_id || root.spaceId !== request.space_id || root.source !== "mini_tool"
    || root.params.miniToolExecution === undefined) throw new NotFoundError(t("server.error.not_found"));
  for (;;) {
    const { execution } = await executionPlanFromTask(root);
    if (execution.retry === undefined) break;
    root = await taskRepo.getMiniToolExecutionTask(execution.retry.runId);
    if (root === null || root.projectId !== request.project_id || root.spaceId !== request.space_id) throw new NotFoundError(t("server.error.not_found"));
  }
  const rootId = root.id;
  return db.transaction(async (tx) => {
    // Root lock covers reservation arbitration; the selected original's lock
    // additionally fences late registration while its failed outputs are read.
    const lockedRoot = await taskRepo.lockMiniToolExecutionTask(rootId, tx);
    const original = rootId === request.retry.runId ? lockedRoot : await taskRepo.lockMiniToolExecutionTask(request.retry.runId, tx);
    if (original === null || original.projectId !== request.project_id || original.spaceId !== request.space_id
      || original.source !== "mini_tool") throw new NotFoundError(t("server.error.not_found"));
    const plan = await executionPlanFromTask(original);
    if (plan.execution.tool !== request.tool) throw new NotFoundError(t("server.error.not_found"));
    const sameRun = await taskRepo.getMiniToolExecutionTask(request.run_id, tx);
    if (sameRun !== null) {
      replay(sameRun, request, userId, fingerprint);
      return { accepted: (await executionPlanFromTask(sameRun)).execution, inserted: false };
    }
    const record = recordFromPlan(plan);
    const selected = record.outputs.filter((output) => request.retry.outputIndexes.includes(output.outputIndex));
    if (record.status === "cancelled" || selected.length !== request.retry.outputIndexes.length
      || selected.some((output) => output.result?.status !== "failed" || output.late
        // A failure no retry can clear (§9.4, §10.4, §10.5) is no retryable slot.
        || !plannedFailureRetryable(plan.execution.tool, output.result.error))) throw new ValidationError(t("server.mini_tool.foreignSource"));
    // A failed output an admitted retry took over accepts no further retry; the next one starts from that retry (§7.15).
    const takenOver = new Set(await taskRepo.listMiniToolRetriedOutputIndexes(original.id, tx));
    if (selected.some((output) => takenOver.has(output.outputIndex))) throw new ValidationError(t("server.mini_tool.alreadyRetried"));
    const outputs = plan.execution.outputs.filter((output) => request.retry.outputIndexes.includes(output.outputIndex));
    if (await taskRepo.hasActiveMiniToolExecutionNodes(request.project_id, request.space_id, outputs.map((output) => output.nodeId), tx)) throw new ConflictError(t("server.idempotency.mismatch"));
    const { requestFingerprint: _requestFingerprint, planFingerprint: _planFingerprint, ...frozen } = plan.execution;
    const retried = { taskId: request.run_id, outputs, targetNodeIds: outputs.map((output) => output.nodeId), retry: request.retry };
    // A removal retry reuses the original prepared model input and reruns only generate: it quotes the frozen model part alone.
    // When the original never finished preparing, the retry prepares under its own task and holds the frozen full quote
    // (frames-split retry row); its body then names its own preparation, which a later retry of it reuses.
    if (frozen.tool === "video.remove-bg") {
      const reused = await presentationPinService.heldPrepared(original.id, tx);
      const own = reused.length === 0
        ? { credits: frozen.credits, body: { ...frozen.body, video: { ...frozen.body.video, job: `${request.run_id}:prep:0` } } }
        : { credits: frozen.modelCredits };
      const claim = await claimPrepared({ ...frozen, ...retried, ...own }, request, userId, fingerprint, tx);
      // The retry reuses the original's prepared input, so it pins that input for itself (§7.15 prepared row).
      if (claim.inserted) {
        for (const held of reused) {
          await presentationPinService.acquire({ holderKind: "prepared", holderId: request.run_id, toolInputId: held.toolInputId, preparedKey: held.preparedKey, objectKeys: [held.preparedKey] }, tx);
        }
        await releaseTakenOver(original.id, record, tx);
      }
      return claim;
    }
    if (frozen.tool === "video.lip-sync" || frozen.tool === "video.erase" || frozen.tool === "video.expand") {
      // The same frozen plan with the original's frozen step keys, so the retry reuses every done step and its object
      // (§97 D21-6, DD §7.1, frames-split §7.11 retry row). A done step's object is on the original's execution pin, which
      // also holds every earlier run's of the chain (§7.15); an erase or expand retry holds only the frozen quotes of the
      // steps not done there (§10.4, §10.5 quote rows), a lip-sync retry its frozen quote.
      const held = await presentationPinService.heldExecutionObjects(original.id, tx);
      const credits = frozen.tool === "video.lip-sync" ? frozen.credits
        : stepsCredits(Object.entries(frozen.stepCredits).filter(([step]) => !held.some((key) => key.includes(frozen.stepKeys[step]!))).map(([, value]) => value));
      const claim = await claimPrepared({ ...frozen, ...retried, credits }, request, userId, fingerprint, tx);
      if (claim.inserted) {
        // The reused preparation and step objects stay pinned by the retry once the original stops being retryable (§7.15).
        for (const held of await presentationPinService.heldPrepared(original.id, tx)) {
          await presentationPinService.acquire({ holderKind: "prepared", holderId: request.run_id, toolInputId: held.toolInputId, preparedKey: held.preparedKey, objectKeys: [held.preparedKey] }, tx);
        }
        await pinRepo.appendExecutionPinObjects(request.run_id, held, tx);
        await releaseTakenOver(original.id, record, tx);
      }
      return claim;
    }
    const chosen = new Set(request.retry.outputIndexes);
    const layout = { batches: frozen.layout.batches.map((batch) => batch.filter((index) => chosen.has(index))).filter((batch) => batch.length > 0),
      encodes: frozen.layout.encodes.filter((encode) => chosen.has(encode.outputIndex)) };
    const works = new Map(frozen.outputs.map((output, index) => [output.outputIndex, frozen.outputSeconds[index]!]));
    const outputSeconds = outputs.map((output) => works.get(output.outputIndex)!);
    // The same quote rule as a fresh run, over the retried outputs' frozen jobs, start seconds and standard-4 price (§5.4);
    // the subset is drawn from the frozen plan, so nothing here reads today's configuration.
    const seconds = layoutSeconds(layout, works, frozen.container.startSeconds);
    const claim = await claimPrepared({ ...frozen, ...retried, layout, stageJobs: plannedStageJobs(layout), outputSeconds, credits: containerCredits(frozen.container, seconds) }, request, userId, fingerprint, tx);
    if (claim.inserted) await releaseTakenOver(original.id, record, tx);
    return claim;
  });
}

/**
 * End the retryability of a run once every failed output has been taken over by an admitted retry, which holds its
 * own pins (§7.15 end of retryability): release the run's execution and prepared pins in the retry's admission transaction.
 * @param runId - The retried run.
 * @param record - Its current record.
 * @param tx - The retry admission's transaction, after the retry's own pins were written.
 * @returns Nothing.
 * @throws {Error} When the read or the release fails.
 */
async function releaseTakenOver(runId: string, record: ReturnType<typeof recordFromPlan>, tx: DbTx): Promise<void> {
  const taken = new Set(await taskRepo.listMiniToolRetriedOutputIndexes(runId, tx));
  if (!record.outputs.every((output) => output.result?.status !== "failed" || taken.has(output.outputIndex))) return;
  await presentationPinService.release({ holderKind: "execution", holderId: runId }, tx);
  await presentationPinService.release({ holderKind: "prepared", holderId: runId }, tx);
}
