// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError, budgetDeadlineFrom, db, env, getMiniToolsConfig, getNodeTaskConfig, getStorageAdapter, projectAuthService, type MiniToolsConfig, type DbTx } from "@breatic/core";
import {
  TaskStatus, ceilToCreditCent, readVideoPresentationCompact, readVideoPresentationLedger, t, videoPresentationAtIngest, videoPresentationKeyframeFlags,
  videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor, type TaskEntity, type TaskStatusType, type VideoPresentationLedger, type VideoPresentationLedgerReceipt,
} from "@breatic/shared";
import {
  batchVideoRunOutputs, canonicalMiniToolValue, estimateVideoJobSeconds, hashMiniToolValue, isHdrTransfer, miniToolExecutionRequestSchema, planVideoEncodeChunks,
  planVideoFrames, planVideoSplit, type MiniToolExecutionRequest, type MiniToolExecutionRetryRequest, type MiniToolPlannedRequest, type MiniToolSourceBinding,
  type VideoEncodeChunk, type VideoEncoderRates, type VideoJobWork, type VideoPresentationTable,
} from "@breatic/shared/mini-tools";
import { prepareVideoRemoveBackground, type PreparedVideoRemoveBackground } from "@domain/mini-tool/remove-background-preparation.service.js";
import { resolveSource } from "@domain/mini-tool/analysis.service.js";
import { executionPlanFromTask } from "@domain/mini-tool/execution-plan.service.js";
import { recordFromPlan } from "@domain/mini-tool/execution.service.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { estimateModelCredits, MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** Frozen common planning facts owned by the physical SQL task. */
interface ExecutionPlan {
  schemaVersion: 1; taskId: string; projectId: string; spaceId: string; targetNodeIds: string[];
  binding: MiniToolSourceBinding; sourceKey: string; draft: MiniToolPlannedRequest["draft"];
  analysisRefs: MiniToolPlannedRequest["analysis_refs"]; outputs: MiniToolPlannedRequest["outputs"][number][];
  model: string; credits: number; requestFingerprint: string; planFingerprint: string;
}
/** A presentation-frame window; a JSON type alias so frozen plans stay assignable to stored JSON. */
type FrameWindow = { start: number; end: number };
/** The §5.4 job layout frozen at admission: batches of output indices, and the outputs encoded in chunks. */
export type MiniToolExecutionLayout = { batches: number[][]; encodes: { outputIndex: number; chunks: FrameWindow[] }[] };
/** A frozen standard-4 container policy: class, precheck floor, size, prices and output limits. */
export type MiniToolContainerPolicy = { containerClass: "MiniToolContainerStd4"; precheckSeconds: number; size: MiniToolsConfig["classes"][string]; prices: MiniToolsConfig["prices"]; limits: MiniToolsConfig["plan_limits"] };
/** The model input a removal sends: prepared from the source by this run's (or the original run's) preparation `<taskId>:prep:0`. */
export type PreparedModelInputRef = { kind: "prepared"; inputId: "source"; job: string };
/** What every planned video execution freezes about its tool input (§7.11): the ref, both receipts and the selected version. */
type FrozenToolInput = {
  presentationRef: MiniToolPlannedRequest["presentation_ref"];
  ledgerReceipts: Record<"source", VideoPresentationLedgerReceipt>;
  versionIds: Record<"source", string>;
  retry?: MiniToolExecutionRetryRequest["retry"];
};
/** The original server-owned execution stored under tasks.params.miniToolExecution. */
export type AcceptedMiniToolExecution = ExecutionPlan & FrozenToolInput & (
  | { tool: "video.remove-bg"; provider: PreparedVideoRemoveBackground["provider"];
    body: Omit<PreparedVideoRemoveBackground["params"], "video"> & { video: PreparedModelInputRef };
    /** The model's own quote, frozen apart from the preparation so a failed-output retry quotes generate alone. */
    modelCredits: number;
    /** The standard-4 model-input preparation (§5.3): its policy and presentation-frame chunk windows. */
    preparation: MiniToolContainerPolicy & { chunks: FrameWindow[]; chunkRetries: number } }
  | { tool: "video.extract-frames" | "video.split"; layout: MiniToolExecutionLayout; container: MiniToolContainerPolicy;
    /** Each output's planned work in seconds without job start, frozen so a retry re-quotes its subset. */
    outputSeconds: number[] }
);
/** The plan facts every tool shares, before its tool-specific fields. */
type ExecutionCommon = Omit<ExecutionPlan, "binding" | "sourceKey" | "model" | "credits" | "requestFingerprint" | "planFingerprint">;
/** The complete executable projection hashed before its two identity fields are attached. */
type ExecutionProjection = Omit<Extract<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>, "requestFingerprint" | "planFingerprint">
  | Omit<Exclude<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>, "requestFingerprint" | "planFingerprint">;
/** The narrow admission response, without prescribing terminal public result projection. */
export interface MiniToolExecutionAdmission { taskId: string; status: TaskStatusType }
/** The immutable task namespace, separate from analysis and worker-only steps. */
export interface MiniToolExecutionTaskParams extends Record<string, unknown> { miniToolExecution: AcceptedMiniToolExecution }
const replayIdentitySchema = z.object({
  schemaVersion: z.literal(1), tool: z.enum(["video.remove-bg", "video.extract-frames", "video.split"]),
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
 * The planned seconds of a layout: every batch job's start plus its outputs' work, every encoded output's work plus one
 * start per chunk job and one for its stitch.
 * @param layout - The layout.
 * @param seconds - Each output's frozen work, by output index.
 * @param startSeconds - The encoder's start seconds.
 * @returns The seconds.
 * @throws {never} Never.
 */
function layoutSeconds(layout: MiniToolExecutionLayout, seconds: ReadonlyMap<number, number>, startSeconds: number): number {
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
 * The encode work of one frame span from the full ledger's encode facts: coded source size, display output, the plan's
 * bit depth and range, decoding from the span's previous keyframe.
 * @param ledger - The validated full ledger.
 * @param flags - Its keyframe flags.
 * @param first - The span's first presentation frame.
 * @param count - Its frame count.
 * @returns The job work.
 * @throws {never} Never.
 */
function spanWork(ledger: VideoPresentationLedger, flags: readonly boolean[], first: number, count: number): VideoJobWork {
  let keyframe = first;
  while (keyframe > 0 && flags[keyframe] !== true) keyframe -= 1;
  const { plan, encoding } = ledger;
  return { encodedFrames: Math.max(count, 1), prerollFrames: first - keyframe, sourceWidth: encoding.codedWidth, sourceHeight: encoding.codedHeight,
    outputWidth: plan.display.width, outputHeight: plan.display.height, bitDepth: plan.source.bitDepth > 8 ? 10 : 8, hdr: isHdrTransfer(plan.source.transfer) };
}

/**
 * The presentation frame indices whose windows start inside a range, from the compact table.
 * @param table - The compact table.
 * @param range - The range in seconds.
 * @param range.start - Its start.
 * @param range.end - Its end.
 * @returns The first index and the count.
 * @throws {never} Never.
 */
function framesIn(table: VideoPresentationTable, range: { start: number; end: number }): { first: number; count: number } {
  let index = 0;
  let first = -1;
  let count = 0;
  for (const run of table.runs) {
    for (let k = 0; k < run.count; k += 1, index += 1) {
      const time = (run.start + k * run.step) / table.timescale;
      if (time >= range.start && time < range.end) { if (first < 0) first = index; count += 1; }
    }
  }
  return { first: Math.max(first, 0), count };
}

/**
 * The exact §5.4 job layout of a run: each output's work from the full ledger's encode facts, stable batches within the
 * per-job cap and the chunk share, chunk windows for an output that alone exceeds the share, then one stitch for it.
 * @param outputs - The verified outputs.
 * @param table - The compact table.
 * @param ledger - The validated full ledger.
 * @param config - The acceptance snapshot.
 * @param tool - The tool.
 * @returns The layout, its job count and each output's work seconds.
 * @throws {RangeError} When the work or the configuration is out of range.
 */
function runLayout(outputs: MiniToolPlannedRequest["outputs"][number][], table: VideoPresentationTable, ledger: VideoPresentationLedger,
  config: MiniToolsConfig, tool: "video.extract-frames" | "video.split"): { layout: MiniToolExecutionLayout; jobs: number; works: number[] } {
  const rates = encoderRates(config);
  const flags = videoPresentationKeyframeFlags(ledger);
  const spans = outputs.map(({ recipe }) => ("frameIndex" in recipe ? { first: recipe.frameIndex, count: 1 } : "range" in recipe ? framesIn(table, recipe.range) : { first: 0, count: 1 }));
  const works = spans.map(({ first, count }) => estimateVideoJobSeconds(spanWork(ledger, flags, first, count), rates) - rates.startSeconds);
  const share = shareSeconds(config);
  const { batches, oversized } = batchVideoRunOutputs(works, { maxOutputsPerJob: config.executions[tool].max_outputs_per_job, shareSeconds: share, fixedSeconds: rates.startSeconds });
  const encodes = oversized.map((index) => {
    const { first, count } = spans[index]!;
    const chunks = planVideoEncodeChunks({ keyframes: flags.slice(first, first + count), frameSeconds: works[index]! / Math.max(count, 1), targetSeconds: share - rates.startSeconds })
      .map((chunk) => ({ start: chunk.start + first, end: chunk.end + first }));
    return { outputIndex: outputs[index]!.outputIndex, chunks };
  });
  return { layout: { batches: batches.map((batch) => batch.map((index) => outputs[index]!.outputIndex)), encodes },
    jobs: batches.length + encodes.reduce((total, encode) => total + encode.chunks.length + 1, 0), works };
}

/**
 * The model-input preparation of a removal (§5.3, §5.4): the whole presentation in one standard-4 job, or chunk windows
 * plus a stitch when it exceeds the chunk share.
 * @param ledger - The validated full ledger.
 * @param config - The acceptance snapshot.
 * @returns The chunk windows, the job count and the planned seconds.
 * @throws {RangeError} When the work is out of range.
 */
function preparationLayout(ledger: VideoPresentationLedger, config: MiniToolsConfig): { chunks: VideoEncodeChunk[]; jobs: number; seconds: number } {
  const rates = encoderRates(config);
  const flags = videoPresentationKeyframeFlags(ledger);
  const work = estimateVideoJobSeconds(spanWork(ledger, flags, 0, flags.length), rates) - rates.startSeconds;
  const share = shareSeconds(config);
  if (rates.startSeconds + work <= share) return { chunks: [{ start: 0, end: flags.length }], jobs: 1, seconds: rates.startSeconds + work };
  const chunks = planVideoEncodeChunks({ keyframes: flags, frameSeconds: work / flags.length, targetSeconds: share - rates.startSeconds });
  return { chunks, jobs: chunks.length + 1, seconds: work + rates.startSeconds * (chunks.length + 1) };
}

/**
 * Require the request's tool input to be the selected version's, with its ledger ready (§7.11); a target-policy
 * preparation in progress does not matter.
 * @param request - The fresh request.
 * @param binding - The registered source.
 * @param sourceKey - Its storage key.
 * @param config - The acceptance snapshot.
 * @returns The selected version and its receipt.
 * @throws {ValidationError} When the tool input is not the selected, ready one.
 * @throws {Error} When ingest fails.
 */
async function selectedToolInput(request: MiniToolPlannedRequest, binding: MiniToolSourceBinding, sourceKey: string, config: MiniToolsConfig): Promise<{ versionId: string; receipt: VideoPresentationLedgerReceipt }> {
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: "read", storageKey: sourceKey, sourceFingerprint: binding.contentHash, targetPolicyVersion: config.presentation.policy_version,
  });
  const ref = request.presentation_ref.source;
  const selected = snapshot.presentation;
  const receipt = snapshot.ledger?.state === "ready" ? snapshot.ledger.receipt : null;
  const storage = await getStorageAdapter();
  if (selected === null || selected.sourceFingerprint !== binding.contentHash || selected.toolInputId !== ref.toolInputId || selected.planSha256 !== ref.planSha256
    || receipt === null || receipt.sourceFingerprint !== binding.contentHash || receipt.toolInputId !== ref.toolInputId || receipt.planSha256 !== ref.planSha256
    || receipt.url !== storage.publicUrl(videoSourceLedgerKeyFor(sourceKey))
    || receipt.table.url !== storage.publicUrl(videoSourceLedgerTableKeyFor(sourceKey))) throw new ValidationError(t("server.mini_tool.foreignSource"));
  return { versionId: selected.versionId, receipt };
}

/**
 * Refuse a run whose standard-4 job count exceeds the parallel cap, with its reason.
 * @param jobs - The planned job count.
 * @param config - The acceptance snapshot.
 * @throws {AppError} When the count exceeds the cap.
 */
function assertWithinParallelCap(jobs: number, config: MiniToolsConfig): void {
  const max = config.encoding.max_parallel_chunks;
  if (jobs > max) throw new AppError(400, t("server.mini_tool.runTooLong", { max }));
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
  const { versionId, receipt } = await selectedToolInput(request, prepared.binding, prepared.sourceKey, config);
  const ledger = await readVideoPresentationLedger(receipt, { maxBytes: config.presentation.source_ledger.max_bytes }, { deadlineAt });
  const { duration } = ledger.plan.display;
  const model = await estimateModelCredits(prepared.model, { params: prepared.params, durations: { video: [Number(duration.numerator) / Number(duration.denominator)] }, sources: ["video"] });
  if (model === undefined) throw new AppError(503, t("server.mini_tool.unavailable"));
  const layout = preparationLayout(ledger, config);
  assertWithinParallelCap(layout.jobs, config);
  const preparation = { ...containerPolicy(settings.preparation.container_class, settings.preparation.precheck_seconds, config), chunks: layout.chunks,
    chunkRetries: config.encoding.chunk_retries };
  return { ...common, tool: request.tool, binding: prepared.binding, sourceKey: prepared.sourceKey, model: prepared.model, provider: prepared.provider,
    body: { ...prepared.params, video: { kind: "prepared", inputId: "source", job: `${request.run_id}:prep:0` } },
    presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt }, versionIds: { source: versionId }, preparation,
    modelCredits: model.credits, credits: model.credits + containerCredits(preparation, layout.seconds) };
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
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const config = structuredClone(getMiniToolsConfig());
  const maxOutputs = config.executions[request.tool].max_outputs;
  if (request.outputs.length > maxOutputs) throw new ValidationError(t("server.mini_tool.foreignSource"));
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const { versionId, receipt } = await selectedToolInput(request, binding, sourceKey, config);
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
  const { layout, jobs, works } = runLayout(outputs, table, ledger, config, request.tool);
  assertWithinParallelCap(jobs, config);
  const container = containerPolicy(config.executions[request.tool].container_class, config.executions[request.tool].precheck_seconds, config);
  const seconds = layoutSeconds(layout, new Map(outputs.map((output, index) => [output.outputIndex, works[index]!])), config.encoding.encoder.start_seconds);
  return { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt },
    versionIds: { source: versionId }, layout, outputSeconds: works, model: request.tool, container, credits: containerCredits(container, seconds) };
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
  const claim = "retry" in request ? await claimRetry(request, userId, fingerprint) : await claimPrepared(await prepare(request), request, userId, fingerprint);
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
 * @param tx - Original retry arbitration transaction, if any.
 * @returns The frozen plan and whether its task UUID was claimed.
 * @throws {Error} When hashing or task persistence fails.
 */
async function claimPrepared(plan: ExecutionProjection, request: MiniToolExecutionRequest, userId: string, fingerprint: string, tx?: DbTx): Promise<{ accepted: AcceptedMiniToolExecution; inserted: boolean }> {
  const accepted: AcceptedMiniToolExecution = { ...plan, requestFingerprint: fingerprint, planFingerprint: await hashMiniToolValue(plan) };
  const inserted = await taskRepo.claimMiniToolExecutionTask({ id: request.run_id, userId, projectId: request.project_id, spaceId: request.space_id,
    taskType: request.tool === "video.extract-frames" ? "image" : "video", model: accepted.model, params: { miniToolExecution: accepted },
    ...(request.tool === "video.remove-bg" ? {} : { result: { miniToolExecution: { schemaVersion: 1, runId: accepted.taskId, status: "pending", planFingerprint: accepted.planFingerprint,
      resultVersion: 0, sourceBindings: [accepted.binding], outputs: accepted.outputs.map((output) => ({ ...output, result: null, late: false })), usage: [], billingState: "idle", error: null } } }),
  }, tx);
  return { accepted, inserted };
}

/**
 * Serialize retry claims on the immutable original task without modifying its plan, results or funds.
 * @param request - A new execution selecting original failed output indices.
 * @param userId - Any current Project editor starting this new execution.
 * @param fingerprint - Whole retry request identity.
 * @returns One new claimed task, or the existing same-run winner.
 * @throws {NotFoundError} When the original execution belongs to another Project, Space or tool.
 * @throws {ValidationError} When any selected slot is not failed or was registered late.
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
      || (request.tool !== "video.remove-bg" && selected.length > getMiniToolsConfig().executions[request.tool].max_outputs)
      || selected.some((output) => output.result?.status !== "failed" || output.late)) throw new ValidationError(t("server.mini_tool.foreignSource"));
    const outputs = plan.execution.outputs.filter((output) => request.retry.outputIndexes.includes(output.outputIndex));
    if (await taskRepo.hasActiveMiniToolExecutionNodes(request.project_id, request.space_id, outputs.map((output) => output.nodeId), tx)) throw new ConflictError(t("server.idempotency.mismatch"));
    const { requestFingerprint: _requestFingerprint, planFingerprint: _planFingerprint, ...frozen } = plan.execution;
    const retried = { taskId: request.run_id, outputs, targetNodeIds: outputs.map((output) => output.nodeId), retry: request.retry };
    // A removal retry reuses the original prepared model input and reruns only generate: it quotes the frozen model part alone.
    if (frozen.tool === "video.remove-bg") return claimPrepared({ ...frozen, ...retried, credits: frozen.modelCredits }, request, userId, fingerprint, tx);
    const chosen = new Set(request.retry.outputIndexes);
    const layout = { batches: frozen.layout.batches.map((batch) => batch.filter((index) => chosen.has(index))).filter((batch) => batch.length > 0),
      encodes: frozen.layout.encodes.filter((encode) => chosen.has(encode.outputIndex)) };
    const works = new Map(frozen.outputs.map((output, index) => [output.outputIndex, frozen.outputSeconds[index]!]));
    const outputSeconds = outputs.map((output) => works.get(output.outputIndex)!);
    // The same quote rule as a fresh run, over the retried outputs' frozen jobs at the frozen standard-4 price (§5.4).
    const seconds = layoutSeconds(layout, works, getMiniToolsConfig().encoding.encoder.start_seconds);
    return claimPrepared({ ...frozen, ...retried, layout, outputSeconds, credits: containerCredits(frozen.container, seconds) }, request, userId, fingerprint, tx);
  });
}
