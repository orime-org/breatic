// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError, env, getMiniToolsConfig, getStorageAdapter, projectAuthService } from "@breatic/core";
import { ceilToCreditCent, extractPromptText, t, type ConsentSnapshot } from "@breatic/shared";
import { canonicalMiniToolValue, fingerprintMiniToolAnalysisInput, hashMiniToolValue, miniToolAnalysisInputSchema, miniToolAnalysisRecordSchema, miniToolSourceBindingSchema, projectMiniToolAnalysisInput, videoToolSourceRefSchema, type MiniToolAnalysisRequest, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import * as assetRepo from "@domain/asset/asset.repo.js";
import * as taskRepo from "@domain/task/task.repo.js";
import { containerCostUsd } from "@domain/credit/container-cost.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import { estimateModelCredits, getModelCatalog, MIN_TASK_CREDIT_COST } from "@domain/model-catalog/model-catalog.js";
import { releaseHold } from "@domain/credit/creditHold.service.js";

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
 * Map one SQL task to the public record, checking its immutable SQL identity.
 * @param task - A task read with its original full-precision acceptance instant.
 * @returns The common acceptance/read/worker record.
 * @throws {NotFoundError} When the row is not an analysis.
 * @throws {Error} When persisted analysis identity is malformed or inconsistent.
 */
export function recordFromTask(task: taskRepo.AnalysisTaskRow): MiniToolAnalysisRecord {
  if (task.taskType !== "mini_tool_analysis") throw new NotFoundError(t("server.error.not_found"));
  const frozen = miniToolFrozenAnalysisSchema.parse(task.params.analysis);
  if (task.id !== frozen.analysisRunId || task.projectId !== frozen.projectId || task.spaceId !== frozen.spaceId) {
    throw new Error("Analysis identity differs from its owning task");
  }
  const identity = {
    schemaVersion: 1 as const, draftId: frozen.draftId, revision: frozen.revision,
    analysisRunId: task.id, acceptedAt: task.acceptedAt, kind: frozen.kind,
    binding: frozen.binding, analysisInput: frozen.analysisInput, inputFingerprint: frozen.inputFingerprint,
  };
  const stored = task.result?.analysis === undefined ? null : miniToolAnalysisRecordSchema.parse(task.result.analysis);
  if (stored !== null) {
    for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
      if (canonicalMiniToolValue(stored[field]) !== canonicalMiniToolValue(identity[field])) {
        throw new Error(`Persisted analysis ${field} differs from its accepted task`);
      }
    }
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
    // A durable claim must not replay silent pending after admission failed.
    // startRowedRun settles rows it opened; before it runs there are no rows.
    const cleanup = await Promise.allSettled([
      taskRepo.updateTaskStatus(body.analysisRunId, "failed", { error: "analysis_start_failed" }),
      releaseHold(body.analysisRunId),
    ]);
    const errors = cleanup.flatMap((item) => item.status === "rejected" ? [item.reason as unknown] : []);
    if (errors.length > 0) throw new AggregateError([error, ...errors], "Analysis admission and cleanup failed");
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
