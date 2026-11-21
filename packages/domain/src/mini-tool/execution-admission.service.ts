// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError, db, env, getMiniToolsConfig, getNodeTaskConfig, projectAuthService, type MiniToolsConfig, type DbTx } from "@breatic/core";
import {
  TaskStatus, ceilToCreditCent, decodePrerollFrames, t,
  type MiniToolPlanTarget, type TaskEntity, type TaskStatusType, type VideoPresentationVersion,
} from "@breatic/shared";
import {
  batchVideoRunOutputs, canonicalMiniToolValue, miniToolChargeTo, miniToolTaskType, miniToolPlannedRequestSchema, plannedFailureRetryable, estimateVideoJobSeconds,
  hashMiniToolValue, miniToolExecutionRequestSchema, planVideoEncodeChunks, plannedStageJobs, planVideoFrames, planVideoSplit, type FramesExecutionLayout,
  type MiniToolExecutionRequest, type MiniToolExecutionRetryRequest, type MiniToolPlannedRequest, type MiniToolPresentationRef, type MiniToolSourceBinding,
  type MiniToolStageJobs, type VideoDecodeKey, type VideoEncodeKey, type VideoEncoderRates, type VideoJobWork,
} from "@breatic/shared/mini-tools";
import { resolveSource, toolSourceObjects } from "@domain/mini-tool/analysis.service.js";
import { selectedToolInput } from "@domain/mini-tool/selected-tool-input.js";
import { videoEncoderRates } from "@domain/asset/video-encoder-rates.js";
import { executionPlanFromTask } from "@domain/mini-tool/execution-plan.service.js";
import { recordFromPlan } from "@domain/mini-tool/execution.service.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";

/** Frozen common planning facts owned by the physical SQL task. */
interface ExecutionPlan {
  schemaVersion: 1; taskId: string; projectId: string; spaceId: string; targetNodeIds: string[];
  binding: MiniToolSourceBinding; sourceKey: string; draft: MiniToolPlannedRequest["draft"];
  analysisRefs: MiniToolPlannedRequest["analysis_refs"]; outputs: MiniToolPlannedRequest["outputs"][number][];
  model: string; credits: number; requestFingerprint: string; planFingerprint: string;
  /** Who pays, frozen at admission from the platform-funded set; the runner and every retry read it (frames-split §5.5). */
  chargeTo: "platform" | "user";
}
/** A frozen standard-4 container policy: class, precheck floor, size, prices and output limits. */
export type MiniToolContainerPolicy = { containerClass: "MiniToolContainerStd4"; precheckSeconds: number; size: MiniToolsConfig["classes"][string]; prices: MiniToolsConfig["prices"]; limits: MiniToolsConfig["plan_limits"] };
/**
 * What every planned video execution freezes about its tool input (§7.11): the ref and the selected version, whose display
 * grid, tool source and source keyframe statistics the runner reads.
 */
type FrozenToolInput = {
  presentationRef: MiniToolPresentationRef;
  presentations: Record<"source", VideoPresentationVersion>;
  versionIds: Record<"source", string>;
  retry?: MiniToolExecutionRetryRequest["retry"];
};
/** The original server-owned execution stored under tasks.params.miniToolExecution. */
export type AcceptedMiniToolExecution = ExecutionPlan & FrozenToolInput & {
  tool: "video.extract-frames" | "video.split" | "video.focus-crop"; layout: FramesExecutionLayout;
  /** The container jobs each stage sends, counted from `layout` at admission (§97 D12-1); absent on plans admitted before. */
  stageJobs?: MiniToolStageJobs[];
  /** The standard-4 policy and the encoder start seconds every job of the layout pays, frozen so a retry re-quotes from them. */
  container: MiniToolContainerPolicy & { startSeconds: number; encode: { crf: number; preset: MiniToolPlanTarget["preset"] }; chunkRetries: number };
  /** Each output's planned work in seconds without job start, frozen so a retry re-quotes its subset. */
  outputSeconds: number[];
};
/** The plan facts every tool shares, before its tool-specific fields. */
type ExecutionCommon = Omit<ExecutionPlan, "binding" | "sourceKey" | "model" | "credits" | "requestFingerprint" | "planFingerprint" | "chargeTo">;
/** The complete executable projection hashed before its two identity fields are attached. */
type ExecutionProjection = Omit<AcceptedMiniToolExecution, "requestFingerprint" | "planFingerprint">;
/** The narrow admission response, without prescribing terminal public result projection. */
export interface MiniToolExecutionAdmission { taskId: string; status: TaskStatusType }
/** The immutable task namespace, separate from analysis and worker-only steps. */
export interface MiniToolExecutionTaskParams extends Record<string, unknown> { miniToolExecution: AcceptedMiniToolExecution }
const replayIdentitySchema = z.object({
  schemaVersion: z.literal(1), tool: z.enum(["video.extract-frames", "video.split", "video.focus-crop"]),
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
  if (task.source !== "mini_tool" || task.taskType !== miniToolTaskType(request.tool) || task.userId !== userId
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
 * The seconds one container job may take: the configured share of the task budget.
 * @param config - The snapshot.
 * @returns The seconds.
 * @throws {Error} When the task configuration cannot be read.
 */
function shareSeconds(config: MiniToolsConfig): number {
  return config.encoding.chunk_share * (getNodeTaskConfig().default_budget_ms / 1000);
}

/**
 * The decode-rate key a job reads its frames with (§5.4 estimate row): the edit file's tier when tools read it, else the
 * original's `sourceDecodeKey`, both frozen in the selected version's tool source.
 * @param version - The selected version.
 * @returns The key.
 * @throws {never} Never.
 */
function toolDecodeKey(version: VideoPresentationVersion): VideoDecodeKey {
  return version.toolSource.edit?.tier ?? version.toolSource.sourceDecodeKey;
}

/**
 * The decode pre-roll every job reading the tool source pays (§5.4 estimate row, §7.16): none on the all-intra edit file,
 * up to the largest keyframe interval on the original.
 * @param version - The selected version.
 * @returns The pre-roll frames.
 * @throws {never} Never.
 */
function prerollOf(version: VideoPresentationVersion): number {
  const { toolSource, display } = version;
  return decodePrerollFrames({ toolSource: toolSource.edit === null ? "original" : "edit", keyframes: toolSource.keyframes, fps: display.fps });
}

/**
 * The work of one job over a span of grid frames read from the tool source (§5.4 estimate row): the display geometry in and
 * out, the tool source's decode key and pre-roll, never a tone map (only an edit-file encode tone maps).
 * @param version - The selected version.
 * @param count - The span's frame count.
 * @param encodeKey - What the job encodes to.
 * @returns The job work.
 * @throws {never} Never.
 */
function spanWork(version: VideoPresentationVersion, count: number, encodeKey: VideoEncodeKey = "playback"): VideoJobWork {
  const { width, height } = version.display;
  return { encodedFrames: Math.max(count, 1), prerollFrames: prerollOf(version), sourceWidth: width, sourceHeight: height,
    outputWidth: width, outputHeight: height, decodeKey: toolDecodeKey(version), encodeKey, toneMap: false };
}

/**
 * One grid frame's work on the tool source, without the pre-roll: `planVideoEncodeChunks` adds each chunk's own pre-roll
 * (§5.4 chunking row), so a per-frame cost that already spread a span's pre-roll would count it twice.
 * @param version - The selected version.
 * @param rates - The frozen encoder rates.
 * @returns The seconds per frame.
 * @throws {RangeError} When a size or rate is out of range.
 */
function frameWorkSeconds(version: VideoPresentationVersion, rates: VideoEncoderRates): number {
  return estimateVideoJobSeconds({ ...spanWork(version, 1), prerollFrames: 0 }, rates) - rates.startSeconds;
}

/**
 * The exact §5.4 job layout of a run: each output's work on the tool source, stable batches within the per-job cap and the
 * chunk share, chunk windows for an output that alone exceeds the share, then one stitch for it.
 * @param outputs - The verified outputs.
 * @param version - The selected version.
 * @param config - The acceptance snapshot.
 * @param tool - The tool.
 * @returns The layout and each output's work seconds.
 * @throws {AppError} When an output that cannot be chunked alone exceeds the share.
 * @throws {RangeError} When the work or the configuration is out of range.
 */
export function runLayout(outputs: MiniToolPlannedRequest["outputs"][number][], version: VideoPresentationVersion,
  config: MiniToolsConfig, tool: "video.extract-frames" | "video.split" | "video.focus-crop"): { layout: FramesExecutionLayout; works: number[] } {
  const rates = videoEncoderRates(config);
  const spans = outputs.map(({ recipe }) => ("frameIndex" in recipe ? { first: recipe.frameIndex, count: 1 } : "range" in recipe ? { first: recipe.range.start, count: recipe.range.end - recipe.range.start } : { first: 0, count: 1 }));
  const works = spans.map(({ count }) => estimateVideoJobSeconds(spanWork(version, count), rates) - rates.startSeconds);
  const share = shareSeconds(config);
  const perJob = tool === "video.focus-crop" ? 1 : config.executions[tool].max_outputs_per_job;
  const { batches, oversized } = batchVideoRunOutputs(works, { maxOutputsPerJob: perJob, shareSeconds: share, fixedSeconds: rates.startSeconds });
  // Only a segment is encoded in chunks; any other output over one share has no layout that fits (§5.4 limit row).
  if (oversized.some((index) => outputs[index]!.recipe.kind !== "segment")) throw runTooLong(config);
  const encodes = oversized.map((index) => {
    const { first, count } = spans[index]!;
    const chunks = planVideoEncodeChunks({ frameCount: count, frameSeconds: frameWorkSeconds(version, rates), prerollFrames: prerollOf(version), targetSeconds: share - rates.startSeconds })
      .map((chunk) => ({ start: chunk.start + first, end: chunk.end + first }));
    return { outputIndex: outputs[index]!.outputIndex, chunks };
  });
  return { layout: { batches: batches.map((batch) => batch.map((index) => outputs[index]!.outputIndex)), encodes }, works };
}

/**
 * Refuse a run whose largest stage sends more standard-4 jobs at once than the parallel cap, with its reason (§97 D12-1;
 * frames-split §5.4).
 * @param stages - The planned stages and their job counts.
 * @param config - The acceptance snapshot.
 * @throws {AppError} When a stage exceeds the cap.
 */
function assertWithinParallelCap(stages: readonly MiniToolStageJobs[], config: MiniToolsConfig): void {
  if (stages.some((stage) => stage.jobs > config.encoding.max_parallel_chunks)) throw runTooLong(config);
}

/**
 * The refusal of a run that cannot be laid out within the parallel cap and the chunk share (frames-split §5.4).
 * @param config - The acceptance snapshot.
 * @returns The error.
 * @throws {never} Never.
 */
function runTooLong(config: MiniToolsConfig): AppError {
  return new AppError(400, t("server.mini_tool.runTooLong", { max: config.encoding.max_parallel_chunks }));
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
  if (request.tool === "video.focus-crop") return prepareFocusCrop(request, common);
  const config = structuredClone(getMiniToolsConfig());
  const maxOutputs = config.executions[request.tool].max_outputs;
  if (request.outputs.length > maxOutputs) throw new ValidationError(t("server.mini_tool.tooManyOutputs", { max: maxOutputs }));
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const version = await selectedToolInput(request.presentation_ref.source, binding, sourceKey, config);
  // Planned on the selected grid by frame number alone (frames-split §10.7, §10.8).
  const grid = { fps: version.display.fps, frameCount: version.display.frameCount };
  let outputs: MiniToolPlannedRequest["outputs"][number][];
  try {
    outputs = request.tool === "video.extract-frames"
      ? planVideoFrames(grid, request.draft.params).map(({ outputIndex, frameIndex }) => ({ outputIndex, nodeId: request.outputs[outputIndex]?.nodeId ?? "", recipe: { kind: "frame" as const, frameIndex } }))
      : planVideoSplit(grid, request.draft.params.cuts).map(({ outputIndex, start, end }) => ({ outputIndex, nodeId: request.outputs[outputIndex]?.nodeId ?? "", recipe: { kind: "segment" as const, range: { start, end } } }));
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof z.ZodError)) throw error;
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  if (outputs.length > maxOutputs || canonicalMiniToolValue(outputs) !== canonicalMiniToolValue(request.outputs)) throw new ValidationError(t("server.mini_tool.foreignSource"));
  const settings = config.executions[request.tool];
  return framesPlan(request, common, { binding, sourceKey, version, outputs, settings, config });
}

/**
 * The frames-shaped plan of extract-frames, split and the video focus crop (§5.4): the job layout, its stage counts, the
 * frozen container policy and payer, and the quote (0 for a platform-funded tool, §5.5).
 * @param request - The fresh request.
 * @param common - The plan facts every tool shares.
 * @param input - The bound source, its selected version, the verified outputs, the tool's settings and the snapshot.
 * @param input.binding - The registered source.
 * @param input.sourceKey - Its storage key.
 * @param input.version - The selected version.
 * @param input.outputs - The verified outputs.
 * @param input.settings - The tool's container class and precheck.
 * @param input.settings.container_class - The class.
 * @param input.settings.precheck_seconds - The precheck floor.
 * @param input.config - The acceptance snapshot.
 * @returns The plan projection.
 * @throws {AppError} When a stage exceeds the parallel cap.
 * @throws {RangeError} When the work is out of range.
 */
function framesPlan(request: Extract<MiniToolPlannedRequest, { tool: "video.extract-frames" | "video.split" | "video.focus-crop" }>, common: ExecutionCommon,
  input: { binding: MiniToolSourceBinding; sourceKey: string; version: VideoPresentationVersion; outputs: MiniToolPlannedRequest["outputs"][number][];
    settings: { container_class: string; precheck_seconds: number }; config: MiniToolsConfig }): ExecutionProjection {
  const { binding, sourceKey, version, outputs, settings, config } = input;
  const { layout, works } = runLayout(outputs, version, config, request.tool);
  const stageJobs = plannedStageJobs(layout);
  assertWithinParallelCap(stageJobs, config);
  const container = { ...containerPolicy(settings.container_class, settings.precheck_seconds, config),
    startSeconds: config.encoding.encoder.start_seconds,
    // §93 D5-2: the run's encode parameters and retry cap, frozen (§5.4).
    encode: { crf: config.presentation.crf, preset: config.presentation.preset }, chunkRetries: config.encoding.chunk_retries };
  const seconds = layoutSeconds(layout, new Map(outputs.map((output, index) => [output.outputIndex, works[index]!])), container.startSeconds);
  const chargeTo = miniToolChargeTo(request.tool);
  return { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, presentations: { source: version },
    versionIds: { source: version.versionId }, layout, stageJobs, outputSeconds: works, model: request.tool, container, chargeTo,
    // A platform-funded tool quotes 0 and holds nothing (frames-split §5.5 configuration row).
    credits: chargeTo === "platform" ? 0 : containerCredits(container, seconds) };
}

/**
 * Admit a video focus crop (frames-split §5.5 admission and plan shape rows): the framed video node is the draft's source,
 * checked against its selected version like every fresh admission; the one output is the panel node, a `frame` recipe on the
 * draft's grid frame with its crop inside P.display.
 * @param request - The fresh focus crop request.
 * @param common - The plan facts every tool shares.
 * @returns The plan projection.
 * @throws {ValidationError} When the source, the version, the frame or the crop does not fit.
 * @throws {Error} When ingest fails.
 */
async function prepareFocusCrop(request: Extract<MiniToolPlannedRequest, { tool: "video.focus-crop" }>, common: ExecutionCommon): Promise<ExecutionProjection> {
  const config = structuredClone(getMiniToolsConfig());
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const version = await selectedToolInput(request.presentation_ref.source, binding, sourceKey, config);
  const { frameIndex, crop } = request.draft.params;
  const { display } = version;
  if (frameIndex >= display.frameCount || crop.x + crop.width > display.width || crop.y + crop.height > display.height) throw new ValidationError(t("server.mini_tool.foreignSource"));
  return framesPlan(request, common, { binding, sourceKey, version, outputs: request.outputs, settings: config.executions["video.focus-crop"], config });
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
    taskType: miniToolTaskType(request.tool), model: accepted.model, params: { miniToolExecution: accepted },
    result: { miniToolExecution: { schemaVersion: 1, runId: accepted.taskId, status: "pending", planFingerprint: accepted.planFingerprint,
      resultVersion: 0, sourceBindings: [accepted.binding], outputs: accepted.outputs.map((output) => ({ ...output, result: null, late: false })), usage: [], billingState: "idle", error: null } },
  }, tx);
  // The run's input's edit file stays alive until it can no longer be retried (§7.15 execution row).
  if (inserted) {
    await presentationPinService.acquire({ holderKind: "execution", holderId: accepted.taskId, toolInputId: accepted.presentationRef.source.toolInputId,
      objectKeys: toolSourceObjects(accepted.presentations.source) }, tx);
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
        || !plannedFailureRetryable(plan.execution.tool))) throw new ValidationError(t("server.mini_tool.foreignSource"));
    // A failed output an admitted retry took over accepts no further retry; the next one starts from that retry (§7.15).
    const takenOver = new Set(await taskRepo.listMiniToolRetriedOutputIndexes(original.id, tx));
    if (selected.some((output) => takenOver.has(output.outputIndex))) throw new ValidationError(t("server.mini_tool.alreadyRetried"));
    const outputs = plan.execution.outputs.filter((output) => request.retry.outputIndexes.includes(output.outputIndex));
    if (await taskRepo.hasActiveMiniToolExecutionNodes(request.project_id, request.space_id, outputs.map((output) => output.nodeId), tx)) throw new ConflictError(t("server.idempotency.mismatch"));
    const { requestFingerprint: _requestFingerprint, planFingerprint: _planFingerprint, ...frozen } = plan.execution;
    const retried = { taskId: request.run_id, outputs, targetNodeIds: outputs.map((output) => output.nodeId), retry: request.retry };
    const chosen = new Set(request.retry.outputIndexes);
    const layout = { batches: frozen.layout.batches.map((batch) => batch.filter((index) => chosen.has(index))).filter((batch) => batch.length > 0),
      encodes: frozen.layout.encodes.filter((encode) => chosen.has(encode.outputIndex)) };
    const works = new Map(frozen.outputs.map((output, index) => [output.outputIndex, frozen.outputSeconds[index]!]));
    const outputSeconds = outputs.map((output) => works.get(output.outputIndex)!);
    // The same quote rule as a fresh run, over the retried outputs' frozen jobs, start seconds and standard-4 price (§5.4);
    // the subset is drawn from the frozen plan, so nothing here reads today's configuration.
    const seconds = layoutSeconds(layout, works, frozen.container.startSeconds);
    // The payer is the original's frozen one (frames-split §5.5): a platform-funded run's retry quotes 0 as it did.
    const credits = frozen.chargeTo === "platform" ? 0 : containerCredits(frozen.container, seconds);
    const claim = await claimPrepared({ ...frozen, ...retried, layout, stageJobs: plannedStageJobs(layout), outputSeconds, credits }, request, userId, fingerprint, tx);
    if (claim.inserted) await releaseTakenOver(original.id, record, tx);
    return claim;
  });
}

/**
 * End the retryability of a run once every failed output has been taken over by an admitted retry, which holds its
 * own pins (§7.15 end of retryability): release the run's execution pin in the retry's admission transaction.
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
}
