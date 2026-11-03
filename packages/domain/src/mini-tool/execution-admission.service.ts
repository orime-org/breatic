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
  type VideoEncodeChunk, type VideoEncoderRates, type VideoPresentationTable,
} from "@breatic/shared/mini-tools";
import { prepareVideoRemoveBackground, type PreparedVideoRemoveBackground } from "@domain/mini-tool/remove-background-preparation.service.js";
import { resolveSource } from "@domain/mini-tool/analysis.service.js";
import { executionPlanFromTask } from "@domain/mini-tool/execution-plan.service.js";
import { recordFromPlan } from "@domain/mini-tool/execution.service.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** Frozen common planning facts owned by the physical SQL task. */
interface ExecutionPlan {
  schemaVersion: 1; taskId: string; projectId: string; spaceId: string; targetNodeIds: string[];
  binding: MiniToolSourceBinding; sourceKey: string; draft: MiniToolPlannedRequest["draft"];
  analysisRefs: MiniToolPlannedRequest["analysis_refs"]; outputs: MiniToolPlannedRequest["outputs"][number][];
  model: string; credits: number; requestFingerprint: string; planFingerprint: string;
}
/** The §5.4 job layout frozen at admission: batches of output indices, and the outputs encoded in chunks. */
export interface MiniToolExecutionLayout { batches: number[][]; encodes: { outputIndex: number; chunks: VideoEncodeChunk[] }[] }
/** The original server-owned execution stored under tasks.params.miniToolExecution. */
export type AcceptedMiniToolExecution = ExecutionPlan & (
  | { tool: "video.remove-bg"; provider: PreparedVideoRemoveBackground["provider"]; body: PreparedVideoRemoveBackground["params"];
    /** ponytail: optional until remove-bg admission reads the selected version (round E3b). */
    presentationRef?: MiniToolPlannedRequest["presentation_ref"] }
  | { tool: "video.extract-frames" | "video.split";
    /** The tool input each request input was planned against (§7.11). */
    presentationRef: MiniToolPlannedRequest["presentation_ref"];
    /** Each input's full and compact receipt, and the version selected at admission (§7.11). */
    ledgerReceipts: Record<"source", VideoPresentationLedgerReceipt>; versionIds: Record<"source", string>; layout: MiniToolExecutionLayout;
    container: { containerClass: "MiniToolContainerStd4"; precheckSeconds: number; size: MiniToolsConfig["classes"][string]; prices: MiniToolsConfig["prices"]; limits: MiniToolsConfig["plan_limits"] };
    retry?: MiniToolExecutionRetryRequest["retry"] }
);
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
 * The one container quote rule (§5.4): frozen seconds are the larger of the tool's precheck floor and the planned work;
 * credits are those seconds at the frozen standard-4 price, ceiled to the credit cent, never under the task minimum.
 * @param tool - The planned container tool.
 * @param config - The acceptance snapshot of instance and prices.
 * @param plannedSeconds - The planned work's seconds over every standard-4 job.
 * @returns The estimate and the immutable operating policy.
 * @throws {Error} When configured pricing or instance facts are invalid.
 */
function containerEstimate(tool: "video.extract-frames" | "video.split", config: MiniToolsConfig = structuredClone(getMiniToolsConfig()), plannedSeconds = 0): Pick<Exclude<AcceptedMiniToolExecution, { tool: "video.remove-bg" }>, "container" | "credits"> {
  const operation = config.executions[tool];
  const size = config.classes[operation.container_class]!;
  const seconds = Math.max(operation.precheck_seconds, plannedSeconds);
  const usd = containerCostUsd({ wallMs: seconds * 1000, cpuUsec: null }, size, config.prices);
  return { credits: Math.max(ceilToCreditCent(creditsForUsd(usd, env.CREDIT_MULTIPLIER)), MIN_TASK_CREDIT_COST),
    container: { containerClass: operation.container_class, precheckSeconds: operation.precheck_seconds, size, prices: config.prices, limits: config.plan_limits } };
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
 * The exact §5.4 job layout of a run and its planned standard-4 seconds: each output's work from the full ledger's encode
 * facts (decoding from the previous keyframe), stable batches within the per-job cap and the chunk share, chunk windows
 * for an output that alone exceeds the share, then one stitch for it.
 * @param outputs - The verified outputs.
 * @param table - The compact table.
 * @param ledger - The validated full ledger.
 * @param config - The acceptance snapshot.
 * @param tool - The tool.
 * @returns The layout, its job count and its planned seconds.
 * @throws {RangeError} When the work or the configuration is out of range.
 */
function runLayout(outputs: MiniToolPlannedRequest["outputs"][number][], table: VideoPresentationTable, ledger: VideoPresentationLedger,
  config: MiniToolsConfig, tool: "video.extract-frames" | "video.split"): { layout: MiniToolExecutionLayout; jobs: number; seconds: number } {
  const encoder = config.encoding.encoder;
  const rates: VideoEncoderRates = { startSeconds: encoder.start_seconds, encodePixelsPerSecond: encoder.encode_pixels_per_second, decodeConvertPixelsPerSecond: encoder.decode_convert_pixels_per_second };
  const flags = videoPresentationKeyframeFlags(ledger);
  const { plan, encoding } = ledger;
  const base = { sourceWidth: encoding.codedWidth, sourceHeight: encoding.codedHeight, outputWidth: plan.display.width, outputHeight: plan.display.height,
    bitDepth: plan.source.bitDepth > 8 ? 10 as const : 8 as const, hdr: isHdrTransfer(plan.source.transfer) };
  /**
   * The keyframe a frame decodes from.
   * @param frame - A presented frame.
   * @returns The nearest keyframe at or before it, or 0.
   * @throws {never} Never.
   */
  const previousKeyframe = (frame: number): number => { let at = frame; while (at > 0 && flags[at] !== true) at -= 1; return at; };
  const spans = outputs.map(({ recipe }) => ("frameIndex" in recipe ? { first: recipe.frameIndex, count: 1 } : "range" in recipe ? framesIn(table, recipe.range) : { first: 0, count: 1 }));
  const works = spans.map(({ first, count }) => estimateVideoJobSeconds({ ...base, encodedFrames: Math.max(count, 1), prerollFrames: first - previousKeyframe(first) }, rates) - rates.startSeconds);
  const shareSeconds = config.encoding.chunk_share * (getNodeTaskConfig().default_budget_ms / 1000);
  const { batches, oversized } = batchVideoRunOutputs(works, { maxOutputsPerJob: config.executions[tool].max_outputs_per_job, shareSeconds, fixedSeconds: rates.startSeconds });
  let seconds = batches.reduce((total, batch) => total + rates.startSeconds + batch.reduce((sum, index) => sum + works[index]!, 0), 0);
  const encodes = oversized.map((index) => {
    const { first, count } = spans[index]!;
    const frameSeconds = works[index]! / Math.max(count, 1);
    const chunks = planVideoEncodeChunks({ keyframes: flags.slice(first, first + count), frameSeconds, targetSeconds: shareSeconds - rates.startSeconds })
      .map((chunk) => ({ start: chunk.start + first, end: chunk.end + first }));
    // Every chunk job and the one stitch job start a container.
    seconds += works[index]! + rates.startSeconds * (chunks.length + 1);
    return { outputIndex: outputs[index]!.outputIndex, chunks };
  });
  return { layout: { batches: batches.map((batch) => batch.map((index) => outputs[index]!.outputIndex)), encodes },
    jobs: batches.length + encodes.reduce((total, encode) => total + encode.chunks.length + 1, 0), seconds };
}

/**
 * Verify current registered bytes and receipt, then rederive every exact recipe using shared planners.
 * @param request - A fresh complete press snapshot.
 * @returns The immutable server plan before its independent fingerprints.
 * @throws {ValidationError} When source, readiness, receipt or any ordered recipe differs.
 * @throws {Error} When current metadata or bounded compact delivery fails.
 */
async function prepare(request: MiniToolPlannedRequest): Promise<ExecutionProjection> {
  const common = { schemaVersion: 1 as const, tool: request.tool, taskId: request.run_id, projectId: request.project_id, spaceId: request.space_id,
    targetNodeIds: request.outputs.map((output) => output.nodeId), draft: request.draft, analysisRefs: request.analysis_refs, outputs: request.outputs };
  if (request.tool === "video.remove-bg") {
    const prepared = await prepareVideoRemoveBackground(request.draft.source, getMiniToolsConfig().executions[request.tool].model);
    // ponytail: remove-bg freezes its ref only; reading the selected version and preparing its model input is round E3b.
    return { ...common, tool: request.tool, binding: prepared.binding, sourceKey: prepared.sourceKey, model: prepared.model,
      provider: prepared.provider, body: prepared.params, credits: prepared.credits, presentationRef: request.presentation_ref };
  }
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const config = structuredClone(getMiniToolsConfig());
  const maxOutputs = config.executions[request.tool].max_outputs;
  if (request.outputs.length > maxOutputs) throw new ValidationError(t("server.mini_tool.foreignSource"));
  const { binding, sourceKey } = await resolveSource(request.draft.source);
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: "read", storageKey: sourceKey, sourceFingerprint: binding.contentHash, targetPolicyVersion: config.presentation.policy_version,
  });
  // The request's tool input must be the selected version's, with its ledger ready (§7.11); a target-policy preparation in progress does not matter.
  const ref = request.presentation_ref.source;
  const selected = snapshot.presentation;
  const receipt = snapshot.ledger?.state === "ready" ? snapshot.ledger.receipt : null;
  const storage = await getStorageAdapter();
  if (selected === null || selected.sourceFingerprint !== binding.contentHash || selected.toolInputId !== ref.toolInputId || selected.planSha256 !== ref.planSha256
    || receipt === null || receipt.sourceFingerprint !== binding.contentHash || receipt.toolInputId !== ref.toolInputId || receipt.planSha256 !== ref.planSha256
    || receipt.url !== storage.publicUrl(videoSourceLedgerKeyFor(sourceKey))
    || receipt.table.url !== storage.publicUrl(videoSourceLedgerTableKeyFor(sourceKey))) throw new ValidationError(t("server.mini_tool.foreignSource"));
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
  const { layout, jobs, seconds } = runLayout(outputs, table, ledger, config, request.tool);
  const max = config.encoding.max_parallel_chunks;
  if (jobs > max) throw new AppError(400, t("server.mini_tool.runTooLong", { max }));
  return { ...common, tool: request.tool, binding, sourceKey, presentationRef: request.presentation_ref, ledgerReceipts: { source: receipt },
    versionIds: { source: selected.versionId }, layout, model: request.tool, ...containerEstimate(request.tool, config, seconds) };
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
    if (execution.tool === "video.remove-bg" || execution.retry === undefined) break;
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
    if (plan.execution.tool === "video.remove-bg" || plan.execution.tool !== request.tool) throw new NotFoundError(t("server.error.not_found"));
    const sameRun = await taskRepo.getMiniToolExecutionTask(request.run_id, tx);
    if (sameRun !== null) {
      replay(sameRun, request, userId, fingerprint);
      return { accepted: (await executionPlanFromTask(sameRun)).execution, inserted: false };
    }
    const record = recordFromPlan(plan);
    const selected = record.outputs.filter((output) => request.retry.outputIndexes.includes(output.outputIndex));
    if (record.status === "cancelled" || selected.length !== request.retry.outputIndexes.length
      || selected.length > getMiniToolsConfig().executions[request.tool].max_outputs
      || selected.some((output) => output.result?.status !== "failed" || output.late)) throw new ValidationError(t("server.mini_tool.foreignSource"));
    const outputs = plan.execution.outputs.filter((output) => request.retry.outputIndexes.includes(output.outputIndex));
    if (await taskRepo.hasActiveMiniToolExecutionNodes(request.project_id, request.space_id, outputs.map((output) => output.nodeId), tx)) throw new ConflictError(t("server.idempotency.mismatch"));
    const { requestFingerprint: _requestFingerprint, planFingerprint: _planFingerprint, ...frozen } = plan.execution;
    const chosen = new Set(request.retry.outputIndexes);
    const layout = { batches: frozen.layout.batches.map((batch) => batch.filter((index) => chosen.has(index))).filter((batch) => batch.length > 0),
      encodes: frozen.layout.encodes.filter((encode) => chosen.has(encode.outputIndex)) };
    // ponytail: a retry quotes the precheck floor; per-output work is not frozen, so the retried subset's planned work is not re-estimated.
    return claimPrepared({ ...frozen, taskId: request.run_id, outputs, layout, targetNodeIds: outputs.map((output) => output.nodeId), retry: request.retry,
      ...containerEstimate(request.tool) }, request, userId, fingerprint, tx);
  });
}
