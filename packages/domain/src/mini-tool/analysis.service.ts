// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError, db, env, getMiniToolsConfig, getStorageAdapter, projectAuthService } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { ceilToCreditCent, extractPromptText, t, type ConsentSnapshot } from "@breatic/shared";
import { canonicalMiniToolValue, fingerprintMiniToolAnalysisInput, hashMiniToolValue, miniToolAnalysisInputSchema, miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema, miniToolSourceBindingSchema, projectMiniToolAnalysisInput, videoToolSourceRefSchema, type MiniToolAnalysisRequest, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolAnalysisResult, type MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import * as assetRepo from "@domain/asset/asset.repo.js";
import * as taskRepo from "@domain/task/task.repo.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { estimateModelCredits, getModelCatalog, MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import { completeMiniToolConsumptionSet } from "@domain/mini-tool/consumption-producer.service.js";

export { miniToolAnalysisRequestSchema, type MiniToolAnalysisRequest } from "@breatic/shared/mini-tools";

/** The immutable analysis dependencies stored inside tasks.params.analysis. */
export const miniToolFrozenAnalysisSchema = z.strictObject({
  schemaVersion: z.literal(1),
  analysisRunId: z.string().uuid(), projectId: z.string().uuid(), spaceId: z.string().uuid(),
  hostNodeId: z.string().uuid(), draftId: z.string().uuid(), revision: z.string().uuid(),
  kind: z.enum(["people", "scene_cuts", "tracked_mask"]), source: videoToolSourceRefSchema,
  binding: miniToolSourceBindingSchema, analysisInput: miniToolAnalysisInputSchema,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type MiniToolFrozenAnalysis = z.infer<typeof miniToolFrozenAnalysisSchema>;

/** Backend-only execution inputs; storage keys never enter the public DTO. */
export interface MiniToolAnalysisTaskParams extends Record<string, unknown> {
  analysis: MiniToolFrozenAnalysis;
  requestFingerprint: string;
  sourceKey: string;
  credits: number;
}

/** The tasks queue's analysis job, shared by server and worker only. */
export interface MiniToolAnalysisJob {
  taskId: string;
  userId: string;
  projectId: string;
  spaceId: string;
  hostNodeId: string;
  source: "mini_tool";
  sourceKey: string;
  params: MiniToolAnalysisTaskParams;
  analyticsConsent: ConsentSnapshot;
}

/** The accepted task a transport adapter starts on the ordinary task lane. */
export interface AcceptedMiniToolAnalysis {
  record: MiniToolAnalysisRecord;
  params: MiniToolAnalysisTaskParams;
}

/** A worker's terminal computation fact and knowledge of its actual upstream identities. */
export type MiniToolAnalysisCompletion =
  | { kind: "result"; result: unknown; consumptionSet: "complete" | "uncertain" }
  | { kind: "error"; error: unknown; consumptionSet: "complete" | "uncertain" };

/** Committed metadata and the original SQL-owned destination for subsequent notifications. */
export interface FinishedMiniToolAnalysis {
  record: MiniToolAnalysisRecord;
  context: { taskId: string; userId: string; projectId: string; spaceId: string; hostNodeId: string };
}

/** The accepted execution inputs and current outcome read from their original SQL owner. */
export interface MiniToolAnalysisExecution extends FinishedMiniToolAnalysis {
  params: MiniToolAnalysisTaskParams;
}

/**
 * Enter an accepted analysis using its original inputs and current computation state.
 * @param taskId - The immutable accepted analysis task.
 * @param jobId - The queue job picking up this original task.
 * @returns The current record, original parameters and notification destination.
 * @throws {Error} When the task, accepted identity or persistent transition is invalid.
 */
export async function startMiniToolAnalysisExecution(taskId: string, jobId: string): Promise<MiniToolAnalysisExecution> {
  void taskId; void jobId;
  throw new Error("Analysis execution entry awaits independent RED");
}

/**
 * Commit a computation outcome and its proven call-set closure under one task lock.
 * @param taskId - The original accepted analysis.
 * @param completion - The worker's observed outcome and upstream identity knowledge.
 * @returns Committed metadata and the immutable notification destination.
 * @throws {Error} When validation, ownership or either persistent transition fails.
 */
export async function finishMiniToolAnalysis(taskId: string, completion: MiniToolAnalysisCompletion): Promise<FinishedMiniToolAnalysis> {
  const outcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), result: miniToolAnalysisResultSchema, consumptionSet: z.enum(["complete", "uncertain"]) }),
    z.strictObject({ kind: z.literal("error"), error: z.record(z.string(), z.json()), consumptionSet: z.enum(["complete", "uncertain"]) }),
  ]).parse(completion);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolAnalysisTask(taskId, tx);
    if (task === null || task.source !== "mini_tool") throw new NotFoundError(t("server.error.not_found"));
    identityFromTask(task);
    const frozen = miniToolFrozenAnalysisSchema.parse(task.params.analysis);
    const record = outcome.kind === "result" ? await recordLockedAnalysis(task, outcome.result, tx) : await failLockedAnalysis(task, outcome.error, tx);
    if (outcome.consumptionSet === "complete") await completeMiniToolConsumptionSet(task.id, tx);
    return {
      record,
      context: { taskId: task.id, userId: task.userId, projectId: frozen.projectId, spaceId: frozen.spaceId, hostNodeId: frozen.hostNodeId },
    };
  });
}

/** The accepted identity shared by public records and typed detector results. */
type AnalysisIdentity = Omit<MiniToolAnalysisRecord, "status" | "result" | "error" | "usage" | "artifactUnavailable">;

/**
 * Require current project membership before admitting or reading any analysis.
 * @param projectId - The persisted or requested project.
 * @param userId - The authenticated caller.
 * @param write - Whether the request starts paid or compute work.
 * @returns Nothing.
 * @throws {NotFoundError} When the project is absent or hidden from this caller.
 * @throws {ForbiddenError} When a viewer tries to start work.
 */
async function assertAccess(projectId: string, userId: string, write: boolean): Promise<void> {
  const role = await projectAuthService.loadProjectRole(userId, projectId);
  if (role === null) throw new NotFoundError(t("server.error.not_found"));
  if (write && role === "viewer") throw new ForbiddenError(t("server.error.forbidden"));
}

/**
 * Resolve registered video truth, keeping legacy single-source sharing semantics.
 * @param source - The selected node's address.
 * @returns The physical binding and backend-only key.
 * @throws {ValidationError} When the address has no live measured video registration.
 */
export async function resolveSource(source: MiniToolAnalysisRequest["source"]): Promise<{ binding: MiniToolSourceBinding; sourceKey: string }> {
  const storage = await getStorageAdapter();
  const sourceKey = storage.keyFromUrl(source.canonicalURL);
  const asset = sourceKey === null ? null : await assetRepo.findLiveByStorageKey(sourceKey);
  if (sourceKey === null || asset === null || asset.kind !== "video") {
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  const binding = miniToolSourceBindingSchema.safeParse({
    assetId: asset.id, contentHash: asset.contentHash,
    canonicalURL: storage.publicUrl(asset.storageKey), kind: asset.kind,
    mediaInfo: { width: asset.width, height: asset.height, duration: asset.durationSeconds, mimeType: asset.mimeType },
  });
  if (!binding.success) throw new ValidationError(t("server.mini_tool.foreignSource"));
  return { binding: binding.data, sourceKey };
}

/**
 * Hold the same actual container prices and model pricing contract as execution.
 * @param kind - The analysis operation.
 * @param input - Its frozen public dependencies.
 * @returns User credits; auxiliary people detection is funded by the platform.
 * @throws {AppError} When a deployment does not serve or price the selected model.
 */
async function estimate(kind: MiniToolAnalysisKind, input: MiniToolAnalysisRecord["analysisInput"]): Promise<number> {
  if (kind === "people") return 0;
  const config = getMiniToolsConfig();
  const operation = config.analyses[kind];
  const size = config.classes[operation.container_class]!;
  const usd = containerCostUsd({ wallMs: operation.precheck_seconds * 1000, cpuUsec: null }, size, config.prices);
  let credits = creditsForUsd(usd, env.CREDIT_MULTIPLIER);
  if (input.kind === "tracked_mask") {
    const seconds = input.range.end - input.range.start;
    const entry = getModelCatalog().video.find((candidate) => candidate.name === input.profile.id);
    if (!entry?.pricing) throw new AppError(503, t("server.mini_tool.unavailable"));
    const limit = entry.params.video?.max_total_duration;
    if (limit !== undefined && seconds > limit) throw new ValidationError(t("server.mini_tool.foreignSource"));
    const model = await estimateModelCredits(input.profile.id, {
      params: { video: input.sourceURL, apply_mask: false }, prompt: input.trackingPrompt,
      durations: { video: [seconds] }, sources: ["video"],
    });
    if (!model) throw new AppError(503, t("server.mini_tool.unavailable"));
    credits += model.credits;
  }
  return Math.max(ceilToCreditCent(credits), MIN_TASK_CREDIT_COST);
}

/**
 * Read the immutable identity shared by every representation of this analysis.
 * @param task - A task read with its original full-precision acceptance instant.
 * @returns The original accepted identity.
 * @throws {NotFoundError} When the row is not an analysis.
 * @throws {Error} When persisted analysis identity is malformed or inconsistent.
 */
function identityFromTask(task: taskRepo.AnalysisTaskRow): AnalysisIdentity {
  if (task.taskType !== "mini_tool_analysis") throw new NotFoundError(t("server.error.not_found"));
  const frozen = miniToolFrozenAnalysisSchema.parse(task.params.analysis);
  if (task.id !== frozen.analysisRunId || task.projectId !== frozen.projectId || task.spaceId !== frozen.spaceId) {
    throw new Error("Analysis identity differs from its owning task");
  }
  return {
    schemaVersion: 1 as const, draftId: frozen.draftId, revision: frozen.revision,
    analysisRunId: task.id, acceptedAt: task.acceptedAt, kind: frozen.kind,
    binding: frozen.binding, analysisInput: frozen.analysisInput, inputFingerprint: frozen.inputFingerprint,
  };
}

/**
 * Find a changed frozen fact using the same canonical JSON comparison.
 * @param identity - Authoritative facts from the locked task.
 * @param candidate - A validated persisted record or incoming typed result.
 * @returns The first mismatching identity field, or null.
 * @throws {TypeError} When a value cannot be represented as canonical JSON.
 */
function mismatchedIdentity(identity: AnalysisIdentity, candidate: MiniToolAnalysisRecord | MiniToolAnalysisResult): keyof AnalysisIdentity | null {
  for (const field of Object.keys(identity) as (keyof AnalysisIdentity)[]) {
    if (canonicalMiniToolValue(candidate[field]) !== canonicalMiniToolValue(identity[field])) return field;
  }
  return null;
}

/**
 * Map one SQL task to the public record, checking its immutable SQL identity.
 * @param task - A task read with its original full-precision acceptance instant.
 * @returns The common acceptance/read/worker record.
 * @throws {NotFoundError} When the row is not an analysis.
 * @throws {Error} When persisted analysis identity is malformed or inconsistent.
 */
export function recordFromTask(task: taskRepo.AnalysisTaskRow): MiniToolAnalysisRecord {
  const identity = identityFromTask(task);
  const stored = task.result?.analysis === undefined ? null : miniToolAnalysisRecordSchema.parse(task.result.analysis);
  if (stored !== null) {
    const field = mismatchedIdentity(identity, stored);
    if (field !== null) throw new Error(`Persisted analysis ${field} differs from its accepted task`);
  }
  const status = task.status === "cancelled" ? "failed" : task.status;
  return miniToolAnalysisRecordSchema.parse({
    ...identity, status, result: stored?.result ?? null, usage: stored?.usage ?? [],
    artifactUnavailable: stored?.artifactUnavailable ?? false,
    error: status === "failed" ? stored?.error ?? { code: task.errorMessage ?? "analysis_failed" } : null,
  });
}

/**
 * Read a task through its persisted project's current membership.
 * @param id - The analysis run UUID.
 * @param userId - The authenticated caller.
 * @returns Its validated record, with missing source/artifacts marked unavailable.
 * @throws {NotFoundError} When no live analysis is visible to this caller.
 * @throws {Error} When stored identity violates the analysis contract.
 */
export async function get(id: string, userId: string): Promise<MiniToolAnalysisRecord> {
  const task = await taskRepo.getAnalysisTask(id);
  if (!task?.projectId || task.taskType !== "mini_tool_analysis") throw new NotFoundError(t("server.error.not_found"));
  await assertAccess(task.projectId, userId, false);
  const record = recordFromTask(task);
  const references = [record.binding, ...(record.result && "artifactRefs" in record.result ? record.result.artifactRefs : []),
    ...(record.result?.kind === "people" ? record.result.people.flatMap((person) => person.artifactRefs) : [])];
  const available = await Promise.all(references.map(async (reference) => {
    const asset = await assetRepo.findById(reference.assetId);
    return asset !== null && asset.deletedAt === null && asset.contentHash === reference.contentHash;
  }));
  return { ...record, artifactUnavailable: record.artifactUnavailable || available.includes(false) };
}

/**
 * Freeze a new run or replay the durable identity before any node row or hold.
 * @param body - Validated editable inputs.
 * @param userId - The authenticated editor.
 * @param start - The application's existing row/hold/queue adapter.
 * @returns The complete accepted record, using SQL time on every path.
 * @throws {ConflictError} When a run UUID belongs to another actor or body.
 * @throws {ValidationError} When a source, range or expected fingerprint is invalid.
 * @throws {Error} When infrastructure cannot persist or start the task.
 */
export async function accept(
  body: MiniToolAnalysisRequest,
  userId: string,
  start: (accepted: AcceptedMiniToolAnalysis) => Promise<"pending" | "failed">,
): Promise<MiniToolAnalysisRecord> {
  await assertAccess(body.projectId, userId, true);
  const requestFingerprint = await hashMiniToolValue(body);
  const previous = await taskRepo.getAnalysisTask(body.analysisRunId);
  if (previous !== null) return replay(previous, body, userId, requestFingerprint);
  const { binding, sourceKey } = await resolveSource(body.source);
  const profile = getMiniToolsConfig().analyses[body.kind].profile;
  const params = body.kind === "tracked_mask" ? { ...body.params, trackingPrompt: extractPromptText(body.params.trackingPrompt) } : body.params;
  const analysisInput = projectMiniToolAnalysisInput({ kind: body.kind, source: { canonicalURL: binding.canonicalURL }, profile, params });
  if (("range" in analysisInput && analysisInput.range.end > binding.mediaInfo.duration)
    || ("anchor" in analysisInput && analysisInput.anchor.pts > binding.mediaInfo.duration)) {
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  if (body.inputFingerprint !== undefined && body.inputFingerprint !== inputFingerprint) {
    throw new ValidationError(t("server.idempotency.mismatch"));
  }
  const analysis: MiniToolFrozenAnalysis = {
    schemaVersion: 1, analysisRunId: body.analysisRunId, projectId: body.projectId,
    spaceId: body.spaceId, hostNodeId: body.hostNodeId, draftId: body.draftId,
    revision: body.revision, kind: body.kind, source: body.source, binding, analysisInput, inputFingerprint,
  };
  const taskParams: MiniToolAnalysisTaskParams = { analysis, requestFingerprint, sourceKey, credits: await estimate(body.kind, analysisInput) };
  const inserted = await taskRepo.claimAnalysisTask({
    id: body.analysisRunId, userId, projectId: body.projectId, spaceId: body.spaceId,
    params: taskParams, ...(body.kind === "tracked_mask" ? { model: profile.id } : {}),
  });
  if (!inserted) {
    const winner = await taskRepo.getAnalysisTask(body.analysisRunId);
    if (winner === null) throw new ConflictError(t("server.idempotency.mismatch"));
    return replay(winner, body, userId, requestFingerprint);
  }
  try {
    const task = await taskRepo.getAnalysisTask(body.analysisRunId);
    if (task === null) throw new Error("Accepted analysis task disappeared");
    const record = recordFromTask(task);
    await taskRepo.storeAnalysisRecord(task.id, record);
    await start({ record, params: taskParams });
  } catch (error) {
    // Queue acknowledgement may fail after a worker has committed its result.
    // Decide under the same task lock before releasing a failed admission's hold.
    try {
      await failMiniToolAnalysisAdmission(body.analysisRunId, { code: "analysis_start_failed" });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Analysis admission and cleanup failed");
    }
    throw error;
  }
  // Once queued, a failed response read must not turn running work into a failure.
  const started = await taskRepo.getAnalysisTask(body.analysisRunId);
  if (started === null) throw new Error("Accepted analysis task disappeared");
  return recordFromTask(started);
}

/**
 * Return a run only to its original actor sending the same frozen request.
 * @param task - The durable winner for this UUID.
 * @param body - The proposed request.
 * @param userId - The authenticated actor.
 * @param fingerprint - Canonical fingerprint of the whole proposed request.
 * @returns The existing record without another task, hold or queue job.
 * @throws {ConflictError} When any immutable request identity differs.
 */
function replay(task: taskRepo.AnalysisTaskRow, body: MiniToolAnalysisRequest, userId: string, fingerprint: string): MiniToolAnalysisRecord {
  if (task.taskType !== "mini_tool_analysis" || task.projectId !== body.projectId || task.userId !== userId || task.params.requestFingerprint !== fingerprint) {
    throw new ConflictError(t("server.idempotency.mismatch"));
  }
  return recordFromTask(task);
}

/**
 * Persist a matching typed result under the original task identity.
 * @param taskId - The immutable accepted task.
 * @param result - The detector result to validate against frozen dependencies.
 * @returns The committed public analysis record.
 * @throws {Error} When validation, identity or persistence fails.
 */
export async function recordMiniToolAnalysis(taskId: string, result: unknown): Promise<MiniToolAnalysisRecord> {
  const incoming = miniToolAnalysisResultSchema.parse(result);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolAnalysisTask(taskId, tx);
    if (task === null) throw new NotFoundError(t("server.error.not_found"));
    return recordLockedAnalysis(task, incoming, tx);
  });
}

/**
 * Apply matching result metadata while the shared completion owner holds its task lock.
 * @param task - Current accepted facts under the parent lock.
 * @param incoming - The validated detector result.
 * @param tx - The transaction that owns the metadata transition.
 * @returns The committed or preserved analysis record.
 * @throws {Error} When identity, immutable result or persistence conflicts.
 */
async function recordLockedAnalysis(task: taskRepo.AnalysisTaskRow, incoming: MiniToolAnalysisResult, tx: DbTx): Promise<MiniToolAnalysisRecord> {
  const identity = identityFromTask(task);
  if (mismatchedIdentity(identity, incoming) !== null) throw new ConflictError(t("server.idempotency.mismatch"));
  const current = recordFromTask(task);
  if (current.result !== null) {
    if (canonicalMiniToolValue(current.result) !== canonicalMiniToolValue(incoming)) throw new ConflictError(t("server.idempotency.mismatch"));
    return current;
  }
  const status = task.status === "cancelled" ? "cancelled" : current.status === "failed" ? "failed" : "completed";
  const analysis = miniToolAnalysisRecordSchema.parse({
    ...current, status: status === "cancelled" ? "failed" : status, result: incoming,
    error: status === "completed" ? null : current.error,
  });
  const updated = await taskRepo.storeMiniToolAnalysisTransition(task.id, {
    analysis, status, errorMessage: status === "completed" ? null : task.errorMessage,
    finish: current.status === "pending" || current.status === "running",
  }, tx);
  return recordFromTask(updated);
}

/**
 * Persist an application failure while preserving any committed result.
 * @param taskId - The immutable accepted task.
 * @param error - A JSON error reported by the application entry.
 * @returns The committed public analysis record.
 * @throws {Error} When validation or persistence fails.
 */
export async function failMiniToolAnalysis(taskId: string, error: unknown): Promise<MiniToolAnalysisRecord> {
  const failure = z.record(z.string(), z.json()).parse(error);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolAnalysisTask(taskId, tx);
    if (task === null) throw new NotFoundError(t("server.error.not_found"));
    return failLockedAnalysis(task, failure, tx);
  });
}

/**
 * Settle an admission error against current metadata and expense ownership.
 * @param taskId - The original accepted run.
 * @param error - The application's JSON admission error.
 * @returns Its committed record, preserving ready results and pending costs.
 * @throws {Error} When validation, metadata or hold persistence fails.
 */
export async function failMiniToolAnalysisAdmission(taskId: string, error: unknown): Promise<MiniToolAnalysisRecord> {
  const failure = z.record(z.string(), z.json()).parse(error);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolAnalysisTask(taskId, tx);
    if (task === null) throw new NotFoundError(t("server.error.not_found"));
    const record = await failLockedAnalysis(task, failure, tx);
    // Execution registers settlement before submitting paid work under this lock.
    // Existing expense ownership survives admission/queue acknowledgement errors.
    if (record.status === "failed" && task.result?.settlement === undefined) {
      await creditHoldRepo.releaseHold(task.id, tx);
    }
    return record;
  });
}

/**
 * Apply the failure table only after acquiring the original task's row lock.
 * @param task - Current persisted facts read under that lock.
 * @param failure - Validated JSON application error.
 * @param tx - The transaction holding the task lock.
 * @returns The preserved terminal record or newly failed record.
 * @throws {Error} When persisted identity or the atomic update is invalid.
 */
async function failLockedAnalysis(task: taskRepo.AnalysisTaskRow, failure: Record<string, unknown>, tx: DbTx): Promise<MiniToolAnalysisRecord> {
  const current = recordFromTask(task);
  if (current.status === "completed" || current.status === "failed") return current;
  const analysis = miniToolAnalysisRecordSchema.parse({ ...current, status: "failed", error: failure });
  const updated = await taskRepo.storeMiniToolAnalysisTransition(task.id, {
    analysis, status: "failed", errorMessage: typeof failure.code === "string" ? failure.code : "mini_tool_analysis_failed", finish: true,
  }, tx);
  return recordFromTask(updated);
}
