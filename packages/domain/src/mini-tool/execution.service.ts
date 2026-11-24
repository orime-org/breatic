// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConsentSnapshot, TaskEntity } from "@breatic/shared";
import { TaskStatus, miniToolPlanJobRequestSchema, t, videoPresentationWorkKeyFor } from "@breatic/shared";
import { z } from "zod";
import { ConflictError, NotFoundError, db, type DbTx } from "@breatic/core";
import { canonicalMiniToolValue, miniToolExecutionOutputSchema, miniToolExecutionRecordSchema, type MiniToolExecutionRecord, type MiniToolExecutionOutput } from "@breatic/shared/mini-tools";
import type { AcceptedMiniToolExecution } from "@domain/mini-tool/execution-admission.service.js";
import { executionPlanFromTask, readMiniToolExecutionPlan, type MiniToolExecutionPlan } from "@domain/mini-tool/execution-plan.service.js";
import { miniToolSettlementSchema } from "@domain/mini-tool/consumption.types.js";
import { completeMiniToolConsumptionSet, completeResolvedMiniToolConsumptionSet } from "@domain/mini-tool/consumption-producer.service.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import { miniToolStepStateSchema } from "@domain/mini-tool/upstream-step.types.js";
import * as assetRepo from "@domain/asset/asset.repo.js";
import * as uploadGrantRepo from "@domain/asset/upload-grant.repo.js";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import { synchronizeMiniToolDelivery } from "@domain/mini-tool/delivery-state.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";

/** Queue transport carries a discriminator and task identity, never a second frozen plan. */
export interface MiniToolExecutionJob {
  taskId: string; source: "mini_tool"; executionKind: "planned"; analyticsConsent?: ConsentSnapshot;
}
/** Original SQL parent, complete frozen plan and its current public projection. */
export interface MiniToolExecution {
  task: TaskEntity; execution: AcceptedMiniToolExecution; record: MiniToolExecutionRecord;
}
/** A complete indexed observation, with the original media CAS; the call set closes from the persisted steps under lock. */
export interface MiniToolExecutionCompletion {
  planFingerprint: string; expectedVersion: number; outputs: MiniToolExecutionRecord["outputs"];
  error: MiniToolExecutionRecord["error"];
}
/**
 * Enter the SQL-owned planned lane before any provider or transfer boundary.
 * @param taskId - The original accepted SQL task.
 * @param jobId - The queue identity picking up that task.
 * @returns Its original inputs and initialized public metadata.
 * @throws {Error} When original identity or atomic initialization fails.
 */
export async function startMiniToolExecution(taskId: string, jobId: string): Promise<MiniToolExecution> {
  const [id, queueId] = z.tuple([z.uuid(), z.string().min(1).max(255)]).parse([taskId, jobId]);
  return db.transaction(async (tx) => {
    const plan = await lockedPlan(id, tx);
    let record = recordFromPlan(plan);
    if (plan.task.status !== "pending" && plan.task.status !== "running") return { ...plan, record };
    await taskRepo.markRunning(id, queueId, new Date(), tx);
    record = miniToolExecutionRecordSchema.parse({ ...record, status: "running" });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx);
    return { task: await currentTask(id, tx), execution: plan.execution, record };
  });
}
/**
 * Commit the run's one terminal result under the original task lock (frames-split §7.19): every output registered and
 * delivered at once, or every output failed. Past the commit point only the completed commit is taken; an ended run
 * takes only the same result again.
 * @param taskId - The original accepted SQL task.
 * @param completion - The complete indexed observation; the call set closes from the persisted steps.
 * @returns The committed or replayed terminal state and original context.
 * @throws {ConflictError} When the mapping, the version or an ended run's result differs.
 * @throws {Error} When the run is cancelled, a failure comes past the commit point, a registration is not the canonical
 * winner, or persistence fails.
 */
export async function finishMiniToolExecution(taskId: string, completion: MiniToolExecutionCompletion): Promise<MiniToolExecution> {
  const id = z.uuid().parse(taskId);
  const incoming = z.strictObject({
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().nonnegative(),
    outputs: z.array(miniToolExecutionOutputSchema).min(1), error: z.record(z.string(), z.json()).nullable(),
  }).parse(completion);
  return db.transaction(async (tx) => {
    const plan = await lockedPlan(id, tx);
    const current = recordFromPlan(plan);
    if (incoming.planFingerprint !== plan.execution.planFingerprint || !sameMapping(incoming.outputs, plan.execution)) {
      throw new ConflictError(t("server.idempotency.mismatch"));
    }
    if (plan.task.status === "cancelled") throw new Error("Cancelled execution cannot begin another computation");
    if (plan.task.status !== "pending" && plan.task.status !== "running") {
      // An ended run takes its own result again and nothing else: no output is registered onto it late.
      if (canonicalMiniToolValue(current.outputs) !== canonicalMiniToolValue(incoming.outputs)) throw new ConflictError(t("server.idempotency.mismatch"));
      await completeResolvedMiniToolConsumptionSet(id, tx);
      const task = await currentTask(id, tx);
      return { task, execution: plan.execution, record: recordFromPlan({ ...plan, task }) };
    }
    if (incoming.expectedVersion !== current.resultVersion) throw new ConflictError(t("server.idempotency.mismatch"));
    const failed = incoming.error !== null;
    if (!incoming.outputs.every((output) => output.result?.status === (failed ? "failed" : "registered"))) {
      throw new Error("A run commits every output registered with no error, or every output failed with its error");
    }
    if (failed && current.commitPoint !== undefined) throw new Error("Past the commit point only the completed commit is taken");
    for (const output of incoming.outputs) if (output.result?.status === "registered") await requireRegistered(output, tx);
    const status = failed ? "failed" : "completed";
    const error = incoming.error;
    const { commitPoint: _commitPoint, ...active } = current;
    const record = miniToolExecutionRecordSchema.parse({ ...active, status, error, outputs: incoming.outputs, resultVersion: current.resultVersion + 1 });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx, {
      status, errorMessage: error === null ? null : typeof error.code === "string" ? error.code : "mini_tool_failed", finish: true,
    });
    await synchronizeMiniToolDelivery(plan.task, record, tx);
    await endRun(plan, tx);
    await completeResolvedMiniToolConsumptionSet(id, tx);
    const task = await currentTask(id, tx);
    return { task, execution: plan.execution, record: recordFromPlan({ ...plan, task }) };
  });
}
/** Whether this call wrote the run's commit point, found it written, or found the run ended (frames-split §7.19). */
export interface MiniToolExecutionCommitPoint { state: "committed" | "ended"; record: MiniToolExecutionRecord }
/**
 * Write the run's commit point under the execution record lock once every output is reported (frames-split §7.19): a
 * running record without one takes it now; a record that has one keeps it, so the same run goes on registering; any other
 * state answers ended and nothing is registered.
 * @param taskId - The original accepted SQL task.
 * @returns The answer and the record as it stands after this call.
 * @throws {Error} When the plan, the record or persistence is invalid.
 */
export async function markMiniToolExecutionCommitPoint(taskId: string): Promise<MiniToolExecutionCommitPoint> {
  const id = z.uuid().parse(taskId);
  return db.transaction(async (tx) => {
    const plan = await lockedPlan(id, tx);
    const current = recordFromPlan(plan);
    if (plan.task.status !== "running") return { state: "ended", record: current };
    if (current.commitPoint !== undefined) return { state: "committed", record: current };
    const record = miniToolExecutionRecordSchema.parse({ ...current, commitPoint: new Date().toISOString() });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx);
    return { state: "committed", record };
  });
}

/**
 * Read a run as it stands, starting nothing: what the failed-job cleanup and the sweep decide its end from
 * (frames-split §7.19).
 * @param taskId - The original accepted SQL task.
 * @returns Its parent, frozen plan and record.
 * @throws {Error} When the run has no owning task or its plan or record is invalid.
 */
export async function readMiniToolExecution(taskId: string): Promise<MiniToolExecution> {
  const plan = await readMiniToolExecutionPlan(z.uuid().parse(taskId));
  return { task: plan.task, execution: plan.execution, record: recordFromPlan(plan) };
}

/**
 * The planned runs the sweep looks at (frames-split §7.19): running ones, and pending ones that never waited for a
 * running slot and are older than the grace window.
 * @param limit - How many of each at most.
 * @param graceMs - The grace window.
 * @returns Their ids, which are also their job ids.
 * @throws {Error} When a read fails.
 */
export async function plannedRunsToSweep(limit: number, graceMs: number): Promise<{ running: string[]; pending: string[] }> {
  return taskRepo.listPlannedRunsToSweep(limit, graceMs);
}

/**
 * Require the original physical parent after a write in its caller's transaction.
 * @param id - The original task identity.
 * @param tx - The transaction holding its parent lock.
 * @returns The current physical parent.
 * @throws {Error} When the parent disappeared.
 */
async function currentTask(id: string, tx: DbTx): Promise<TaskEntity> {
  const task = await taskRepo.getMiniToolExecutionTask(id, tx);
  if (task === null) throw new Error("Planned execution parent disappeared");
  return task;
}

/**
 * Acquire the single computation/consumption lock before interpreting its frozen plan.
 * @param id - The original accepted task identity.
 * @param tx - The computation transaction acquiring its lock.
 * @returns The locked parent and complete verified plan.
 * @throws {NotFoundError} When the original parent is absent.
 * @throws {Error} When the complete frozen plan is invalid.
 */
async function lockedPlan(id: string, tx: DbTx): Promise<MiniToolExecutionPlan> {
  const task = await taskRepo.lockMiniToolExecutionTask(id, tx);
  if (task === null) throw new NotFoundError(t("server.error.not_found"));
  return executionPlanFromTask(task);
}

/**
 * Compare the complete ordered slot identity without interpreting client recipes again.
 * @param outputs - The proposed complete output mapping.
 * @param execution - The original accepted plan.
 * @returns Whether every ordered slot matches the original plan.
 * @throws {TypeError} When an internal mapping is not canonical JSON.
 */
function sameMapping(outputs: readonly MiniToolExecutionOutput[], execution: AcceptedMiniToolExecution): boolean {
  return canonicalMiniToolValue(outputs.map(({ outputIndex, nodeId, recipe }) => ({ outputIndex, nodeId, recipe }))) === canonicalMiniToolValue(execution.outputs);
}

/** A task row's status, which its run's record carries. */
const taskStatusSchema = z.enum(TaskStatus);

/**
 * Project only persisted task facts; the read path never queries provider steps.
 * @param plan - The verified physical parent and immutable execution.
 * @returns Its current project-readable computation and expense state.
 * @throws {Error} When a stored namespace conflicts with its immutable parent.
 */
export function recordFromPlan(plan: MiniToolExecutionPlan): MiniToolExecutionRecord {
  const { task, execution } = plan;
  const billingState = task.result?.settlement === undefined ? "idle" : miniToolSettlementSchema.parse(task.result.settlement).state;
  const stored = task.result?.miniToolExecution;
  const record = miniToolExecutionRecordSchema.parse(stored ?? {
    schemaVersion: 1, runId: task.id, status: task.status, planFingerprint: execution.planFingerprint, resultVersion: 0,
    sourceBindings: [execution.binding], outputs: execution.outputs.map((output) => ({ ...output, result: null })),
    usage: [], billingState, error: null,
  });
  if (record.runId !== task.id || record.planFingerprint !== execution.planFingerprint
    || canonicalMiniToolValue(record.sourceBindings) !== canonicalMiniToolValue([execution.binding]) || !sameMapping(record.outputs, execution)) {
    throw new Error("Public execution differs from its original SQL plan");
  }
  // The task row owns the status: the running-task gate starts a run and a queued cancel ends it on that row alone
  // (inner#1968 design 3.9).
  return { ...record, status: taskStatusSchema.parse(task.status), billingState };
}

/**
 * Compare public output metadata with its live canonical registration and cover.
 * @param output - The worker's complete registered slot observation.
 * @param tx - The commit's transaction, so the read uses its connection.
 * @throws {Error} When the original canonical row is missing or differs from the observation.
 */
async function requireRegistered(output: MiniToolExecutionOutput, tx: DbTx): Promise<void> {
  const media = output.result;
  if (media?.status !== "registered") throw new Error("Output has no canonical registration");
  const asset = await assetRepo.findById(media.assetId, tx);
  if (asset === null || asset.deletedAt !== null) throw new Error("Canonical output is unavailable");
  const cover = await assetRepo.findCoverOf(asset.id, tx);
  const actual = {
    status: "registered", assetId: asset.id, canonicalURL: asset.fileUrl, kind: asset.kind, mimeType: asset.mimeType,
    size: asset.sizeBytes, contentHash: asset.contentHash, width: asset.width, height: asset.height, duration: asset.durationSeconds,
    cover: cover === null ? null : {
      assetId: cover.id, canonicalURL: cover.fileUrl, kind: cover.kind, mimeType: cover.mimeType,
      size: cover.sizeBytes, contentHash: cover.contentHash, width: cover.width, height: cover.height,
    },
  };
  if (canonicalMiniToolValue(media) !== canonicalMiniToolValue(actual)) throw new Error("Output differs from its registered canonical winner");
}

/**
 * What every end of a run does in its terminal transaction (frames-split §7.19): its `execution` and `prepared` pins end,
 * the work object of every chunk still running is registered for reclaim, and every output grant it issued that nothing
 * consumed is voided.
 * @param plan - The locked run.
 * @param tx - The terminal write's transaction.
 * @throws {Error} When reading its steps, releasing a pin, registering a key or voiding a grant fails.
 */
async function endRun(plan: MiniToolExecutionPlan, tx: DbTx): Promise<void> {
  const id = plan.task.id;
  await presentationPinService.release({ holderKind: "execution", holderId: id }, tx);
  await presentationPinService.release({ holderKind: "prepared", holderId: id }, tx);
  // A chunk running at the end writes its work object later: its key is registered now, and the offline reclaim's
  // protection period outlasts the job's deadline, so the object is reclaimed once written.
  await presentationPinService.retire({ holderKind: "execution", holderId: id }, await runningChunkKeys(plan, tx), tx);
  await uploadGrantRepo.voidTaskGrants(id, "cancelled", tx);
}

/**
 * The work keys of the run's chunks that have no terminal report: a chunk's single output is its work object (§93 D5-10).
 * @param plan - The locked run.
 * @param tx - The terminal write's transaction.
 * @returns The keys.
 * @throws {Error} When the steps cannot be read or a stored step is invalid.
 */
async function runningChunkKeys(plan: MiniToolExecutionPlan, tx: DbTx): Promise<string[]> {
  return (await upstreamStepRepo.listSteps(plan.task.id, tx)).flatMap((step) => {
    if (step.output.miniToolPlanJob === undefined) return [];
    const request = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
    const state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
    const workKey = videoPresentationWorkKeyFor(plan.execution.sourceKey, request.jobId);
    return (state?.result ?? null) === null && request.outputs.some((output) => output.storageKey === workKey) ? [workKey] : [];
  });
}

/**
 * End a planned run whose task ended outside the worker, cancelled before it started or failed by a sweep (inner#1968
 * design 3.9), as its terminal state (frames-split §7.19): every output fails with the task's reason. A run past its
 * commit point only completes, so this refuses it and the caller's transaction rolls back.
 * @param id - The run, whose task row the caller's transaction just ended.
 * @param tx - That transaction.
 * @throws {Error} When the run is past its commit point, or the original plan, the record or the persistence is invalid.
 */
export async function endMiniToolExecutionOutsideRun(id: string, tx: DbTx): Promise<void> {
  const plan = await lockedPlan(id, tx);
  const current = recordFromPlan(plan);
  if (current.commitPoint !== undefined) throw new Error("A run past its commit point only completes");
  if (current.outputs.every((output) => output.result !== null)) return;
  const failure = { code: plan.task.errorMessage ?? "internal" };
  const record = miniToolExecutionRecordSchema.parse({
    ...current, resultVersion: current.resultVersion + 1, error: failure,
    outputs: current.outputs.map((output) => ({ ...output, result: { status: "failed", error: failure } })),
  });
  await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx);
  await endRun(plan, tx);
  if (plan.task.status !== "cancelled" && plan.task.result?.settlement === undefined) await completeMiniToolConsumptionSet(id, tx);
}

/**
 * Preserve the accepted execution and actual expenses when admission fails or loses its queue acknowledgement.
 * @param taskId - The original SQL-claimed execution task.
 * @param error - The admission failure observed by the existing start adapter.
 * @returns The preserved terminal or newly failed public record.
 * @throws {Error} When the original plan, failure record or atomic persistence is invalid.
 */
export async function failMiniToolExecutionAdmission(taskId: string, error: NonNullable<MiniToolExecutionRecord["error"]>): Promise<MiniToolExecutionRecord> {
  const id = z.uuid().parse(taskId);
  const failure = z.record(z.string(), z.json()).parse(error);
  return db.transaction(async (tx) => {
    const plan = await lockedPlan(id, tx);
    const current = recordFromPlan(plan);
    if (current.status !== "pending" && current.status !== "running") return current;
    if (current.commitPoint !== undefined) throw new Error("A run past its commit point only completes");
    const record = miniToolExecutionRecordSchema.parse({
      ...current, status: "failed", resultVersion: current.resultVersion + 1, error: failure,
      outputs: current.outputs.map((output) => ({ ...output, result: { status: "failed", error: failure } })),
    });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx, {
      status: "failed", errorMessage: typeof failure.code === "string" ? failure.code : "internal", finish: true,
    });
    await endRun(plan, tx);
    // Original intents register settlement under this same lock before paid IO.
    // An acknowledgement failure cannot release their hold or close their set.
    if (plan.task.result?.settlement === undefined) {
      await completeMiniToolConsumptionSet(id, tx);
      await creditHoldRepo.releaseHold(id, tx);
    }
    return recordFromPlan({ ...plan, task: await currentTask(id, tx) });
  });
}
