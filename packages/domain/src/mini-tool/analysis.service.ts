// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError, db, env, getMiniToolsConfig, getStorageAdapter, projectAuthService } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { ceilToCreditCent, t, videoPresentationVersionSchema, type ConsentSnapshot, type VideoPresentationVersion } from "@breatic/shared";
import { canonicalMiniToolValue, fingerprintMiniToolAnalysisInput, hashMiniToolValue, miniToolAnalysisInputSchema, miniToolChargeTo, miniToolPresentationRefSchema, miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema, miniToolSourceBindingSchema, projectMiniToolAnalysisInput, trackingClips, videoToolSourceRefSchema, type MiniToolAnalysisRequest, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolAnalysisResult, type MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import * as assetRepo from "@domain/asset/asset.repo.js";
import * as taskRepo from "@domain/task/task.repo.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { getModelCatalog, MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import { admitModelCall } from "@domain/mini-tool/model-call-admission.js";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import { completeResolvedMiniToolConsumptionSet } from "@domain/mini-tool/consumption-producer.service.js";
import { selectedToolInput } from "@domain/mini-tool/selected-tool-input.js";
import { assertOpaqueSource, eraseRangeGrid, trackingClipSeconds } from "@domain/mini-tool/tracking-range.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";

export { miniToolAnalysisRequestSchema, type MiniToolAnalysisRequest } from "@breatic/shared/mini-tools";

/** The immutable analysis dependencies stored inside tasks.params.analysis. */
export const miniToolFrozenAnalysisSchema = z.strictObject({
  schemaVersion: z.literal(1),
  analysisRunId: z.string().uuid(), projectId: z.string().uuid(), spaceId: z.string().uuid(),
  hostNodeId: z.string().uuid(), draftId: z.string().uuid(), revision: z.string().uuid(),
  kind: z.enum(["people", "scene_cuts", "tracked_mask"]), source: videoToolSourceRefSchema,
  binding: miniToolSourceBindingSchema, analysisInput: miniToolAnalysisInputSchema,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  // The selected tool input and its version (grid, tool source and source keyframe statistics), frozen as an execution
  // freezes them (frames-split §7.11).
  presentationRef: miniToolPresentationRefSchema,
  presentations: z.strictObject({ source: videoPresentationVersionSchema }),
  versionIds: z.strictObject({ source: z.string().regex(/^[a-f0-9]{64}$/) }),
  // Who pays, decided at admission from the platform-funded set and read by the runner (frames-split §5.5 configuration row).
  chargeTo: z.enum(["platform", "user"]),
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

/** A worker's terminal computation outcome. */
export type MiniToolAnalysisCompletion =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: unknown };

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
  const [id, queueId] = z.tuple([z.uuid(), z.string().min(1).max(255)]).parse([taskId, jobId]);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolAnalysisTask(id, tx);
    if (task === null || task.source !== "mini_tool") throw new NotFoundError(t("server.error.not_found"));
    const params = z.looseObject({
      analysis: miniToolFrozenAnalysisSchema, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      sourceKey: z.string().min(1), credits: z.number().nonnegative(),
    }).parse(task.params);
    let record = recordFromTask(task);
    if (task.status === "pending" || task.status === "running") {
      await taskRepo.markRunning(task.id, queueId, new Date(), tx);
      record = recordFromTask({ ...task, status: "running" });
    }
    const frozen = params.analysis;
    return {
      record, params,
      context: { taskId: task.id, userId: task.userId, projectId: frozen.projectId, spaceId: frozen.spaceId, hostNodeId: frozen.hostNodeId },
    };
  });
}

/**
 * Commit a computation outcome and its proven call-set closure under one task lock.
 * @param taskId - The original accepted analysis.
 * @param completion - The worker's observed outcome; the call set closes from the persisted steps.
 * @returns Committed metadata and the immutable notification destination.
 * @throws {Error} When validation, ownership or either persistent transition fails.
 */
export async function finishMiniToolAnalysis(taskId: string, completion: MiniToolAnalysisCompletion): Promise<FinishedMiniToolAnalysis> {
  const outcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), result: miniToolAnalysisResultSchema }),
    z.strictObject({ kind: z.literal("error"), error: z.record(z.string(), z.json()) }),
  ]).parse(completion);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolAnalysisTask(taskId, tx);
    if (task === null || task.source !== "mini_tool") throw new NotFoundError(t("server.error.not_found"));
    identityFromTask(task);
    const frozen = miniToolFrozenAnalysisSchema.parse(task.params.analysis);
    const record = outcome.kind === "result" ? await recordLockedAnalysis(task, outcome.result, tx) : await failLockedAnalysis(task, outcome.error, tx);
    await completeResolvedMiniToolConsumptionSet(task.id, tx);
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
 * A tracked mask is quoted per tracking clip (execution design §10.3 estimate): the tracker over each clip's encoded
 * length and each clip's standard-4 preparation at its precheck, beside the join at the analysis class's precheck.
 * @param kind - The analysis operation.
 * @param input - Its frozen public dependencies.
 * @param display - The selected version's display grid, which a tracked mask's clips are cut on.
 * @returns User credits; a platform-funded kind (people detection) quotes 0.
 * @throws {AppError} When a deployment does not serve or price the selected model.
 * @throws {ValidationError} When a clip is longer than the tracker takes.
 */
async function estimate(kind: MiniToolAnalysisKind, input: MiniToolAnalysisRecord["analysisInput"], display: VideoPresentationVersion["display"]): Promise<number> {
  if (miniToolChargeTo(kind) === "platform") return 0;
  const config = getMiniToolsConfig();
  const operation = config.analyses[kind];
  const size = config.classes[operation.container_class]!;
  const usd = containerCostUsd({ wallMs: operation.precheck_seconds * 1000, cpuUsec: null }, size, config.prices);
  let credits = creditsForUsd(usd, env.CREDIT_MULTIPLIER);
  if (input.kind === "tracked_mask") {
    const entry = getModelCatalog().video.find((candidate) => candidate.name === input.profile.id);
    if (!entry) throw new AppError(503, t("server.mini_tool.unavailable"));
    const first = input.range.start;
    const count = Math.min(input.range.end, display.frameCount) - first;
    const preparation = config.analyses.tracked_mask.preparation;
    const prepareUsd = containerCostUsd({ wallMs: preparation.precheck_seconds * 1000, cpuUsec: null }, config.classes[preparation.container_class]!, config.prices);
    for (const seconds of trackingClipSeconds(display, trackingClips({ start: first, end: first + count }, input.anchor.frameIndex))) {
      // Each clip is one SAM3 call, admitted and priced on the frozen route (inner#1306 §11.5).
      const model = await admitModelCall(input.profile.id, {
        params: { video: input.sourceURL, apply_mask: false }, prompt: input.trackingPrompt,
        durations: { video: [seconds] }, sources: ["video"],
      });
      credits += model + creditsForUsd(prepareUsd, env.CREDIT_MULTIPLIER);
    }
  }
  return Math.max(ceilToCreditCent(credits), MIN_TASK_CREDIT_COST);
}

/**
 * The object a run or an analysis keeps alive for its input (§7.15 execution and analysis rows): the edit file, when tools
 * read one.
 * @param version - The selected version.
 * @returns Its edit file's key, or none.
 * @throws {never} Never.
 */
export function toolSourceObjects(version: VideoPresentationVersion): string[] {
  return version.toolSource.edit === null ? [] : [version.toolSource.edit.storageKey];
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
    // Once billed, the analysis reads as what it was charged (canvas design §4 erase row: the tracking's actual use).
    ...identity, status, result: stored?.result ?? null, usage: task.billedCredits === null ? stored?.usage ?? [] : [{ credits: task.billedCredits }],
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
 * Resolve, check and price one analysis request as admission freezes it, writing nothing.
 * @param body - Validated editable inputs.
 * @returns The frozen facts and the credits the run holds.
 * @throws {ValidationError} When a source, range or expected fingerprint is invalid.
 * @throws {AppError} When the deployment does not offer or price the analysis.
 * @throws {Error} When ingest cannot be read.
 */
async function freeze(body: MiniToolAnalysisRequest): Promise<{
  binding: MiniToolFrozenAnalysis["binding"]; sourceKey: string; version: VideoPresentationVersion;
  profile: MiniToolAnalysisRecord["analysisInput"]["profile"]; analysisInput: MiniToolAnalysisRecord["analysisInput"]; inputFingerprint: string; credits: number;
}> {
  const { binding, sourceKey } = await resolveSource(body.source);
  const version = await selectedToolInput(body.presentationRef.source, binding, sourceKey, structuredClone(getMiniToolsConfig()));
  const { display } = version;
  const profile = getMiniToolsConfig().analyses[body.kind].profile;
  const analysisInput = projectMiniToolAnalysisInput({ kind: body.kind, source: { canonicalURL: binding.canonicalURL }, profile, params: body.params });
  // Ranges and anchors are grid frames of the selected version (frames-split §10.12 analysis-input.ts row).
  if (("range" in analysisInput && analysisInput.range.end > display.frameCount)
    || ("anchor" in analysisInput && analysisInput.anchor.frameIndex >= display.frameCount)) {
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  if (analysisInput.kind === "tracked_mask") {
    // Tracking serves an erase, so the selection is checked as the erase will be (execution design §10.2, §10.4).
    const erase = getMiniToolsConfig().executions["video.erase"];
    assertOpaqueSource(version);
    if (erase === undefined) throw new AppError(400, t("server.mini_tool.unavailable"));
    eraseRangeGrid(display, analysisInput.range, analysisInput.anchor, erase.model);
  }
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  if (body.inputFingerprint !== undefined && body.inputFingerprint !== inputFingerprint) {
    throw new ValidationError(t("server.idempotency.mismatch"));
  }
  return { binding, sourceKey, version, profile, analysisInput, inputFingerprint, credits: await estimate(body.kind, analysisInput, display) };
}

/**
 * Quote an analysis request with the admission's own checks and price, writing nothing (canvas design §4 erase row).
 * @param body - The request the press would send.
 * @param userId - The authenticated editor.
 * @returns The credits admission would hold.
 * @throws {NotFoundError} When the Project is not visible to the caller.
 * @throws {ForbiddenError} When a viewer asks.
 * @throws {ValidationError} When admission would refuse the request.
 */
export async function quote(body: MiniToolAnalysisRequest, userId: string): Promise<{ credits: number }> {
  await assertAccess(body.projectId, userId, true);
  return { credits: (await freeze(body)).credits };
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
  const frozen = await freeze(body);
  const { sourceKey, profile } = frozen;
  const analysis: MiniToolFrozenAnalysis = {
    schemaVersion: 1, analysisRunId: body.analysisRunId, projectId: body.projectId,
    spaceId: body.spaceId, hostNodeId: body.hostNodeId, draftId: body.draftId,
    revision: body.revision, kind: body.kind, source: body.source, binding: frozen.binding, analysisInput: frozen.analysisInput,
    inputFingerprint: frozen.inputFingerprint, presentationRef: body.presentationRef, presentations: { source: frozen.version }, versionIds: { source: frozen.version.versionId },
    chargeTo: miniToolChargeTo(body.kind),
  };
  const taskParams: MiniToolAnalysisTaskParams = { analysis, requestFingerprint, sourceKey, credits: frozen.credits };
  const toolInputId = body.presentationRef.source.toolInputId;
  const inserted = await db.transaction(async (tx) => {
    const claimed = await taskRepo.claimAnalysisTask({
      id: body.analysisRunId, userId, projectId: body.projectId, spaceId: body.spaceId,
      params: taskParams, ...(body.kind === "tracked_mask" ? { model: profile.id } : {}),
    }, tx);
    // The analysis keeps its input's edit file alive until it ends (§7.15 analysis row).
    if (claimed) await presentationPinService.acquire({ holderKind: "analysis", holderId: body.analysisRunId, toolInputId, objectKeys: toolSourceObjects(frozen.version) }, tx);
    return claimed;
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
  await presentationPinService.release({ holderKind: "analysis", holderId: task.id }, tx);
  return recordFromTask(updated);
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
  await presentationPinService.release({ holderKind: "analysis", holderId: task.id }, tx);
  return recordFromTask(updated);
}
