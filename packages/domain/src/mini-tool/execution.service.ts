// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConsentSnapshot, TaskEntity } from "@breatic/shared";
import { TaskStatus, t } from "@breatic/shared";
import { z } from "zod";
import { ConflictError, NotFoundError, db, projectAuthService, type DbTx } from "@breatic/core";
import { canonicalMiniToolValue, miniToolExecutionOutputSchema, plannedFailureRetryable, miniToolExecutionRecordSchema, type MiniToolExecutionRecord, type MiniToolExecutionOutput } from "@breatic/shared/mini-tools";
import type { AcceptedMiniToolExecution } from "@domain/mini-tool/execution-admission.service.js";
import { executionPlanFromTask, type MiniToolExecutionPlan } from "@domain/mini-tool/execution-plan.service.js";
import { miniToolSettlementSchema } from "@domain/mini-tool/consumption.types.js";
import { miniToolStepStateSchema } from "@domain/mini-tool/upstream-step.types.js";
import { completeMiniToolConsumptionSet, completeResolvedMiniToolConsumptionSet } from "@domain/mini-tool/consumption-producer.service.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import * as assetRepo from "@domain/asset/asset.repo.js";
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
 * Commit a complete indexed result under the original task lock.
 * @param taskId - The original accepted SQL task.
 * @param completion - The complete indexed observation; the call set closes from the persisted steps.
 * @returns The committed or preserved terminal state and original context.
 * @throws {Error} When original mapping, registration, media CAS or persistence fails.
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
    const outputs: MiniToolExecutionOutput[] = [];
    for (const [index, output] of incoming.outputs.entries()) {
      const held = current.outputs[index]!;
      if (held.result?.status === "registered") {
        if (canonicalMiniToolValue(held.result) !== canonicalMiniToolValue(output.result)) throw new ConflictError(t("server.idempotency.mismatch"));
        outputs.push(held);
      } else if (output.result?.status === "registered") {
        await requireRegistered(output, tx);
        if (plan.task.status === "failed") await requireLateReceipt(id, output, tx);
        outputs.push({ ...output, late: plan.task.status === "failed" });
      } else {
        outputs.push(plan.task.status === "failed" ? held : { ...output, late: false });
      }
    }
    const changed = canonicalMiniToolValue(current.outputs) !== canonicalMiniToolValue(outputs);
    // A repeated terminal commit changes nothing; a running execution whose outputs progress commits already hold still ends here.
    if (current.resultVersion > 0 && !changed && plan.task.status !== "pending" && plan.task.status !== "running") {
      await completeResolvedMiniToolConsumptionSet(id, tx);
      return { task: await currentTask(id, tx), execution: plan.execution, record: recordFromPlan({ ...plan, task: await currentTask(id, tx) }) };
    }
    if (incoming.expectedVersion !== current.resultVersion) throw new ConflictError(t("server.idempotency.mismatch"));
    const failed = plan.task.status === "failed" || outputs.some((output) => output.result?.status === "failed");
    const status = failed ? "failed" : "completed";
    const error = plan.task.status === "failed" ? current.error : failed ? incoming.error ?? { code: "mini_tool_failed" } : null;
    const record = miniToolExecutionRecordSchema.parse({ ...current, status, error, outputs, resultVersion: current.resultVersion + 1 });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx, {
      status, errorMessage: error === null ? null : typeof error.code === "string" ? error.code : "mini_tool_failed",
      finish: plan.task.status === "pending" || plan.task.status === "running",
    });
    await synchronizeMiniToolDelivery(plan.task, record, tx);
    await releaseUnretryablePins(id, plan.execution.tool, record, tx);
    await completeResolvedMiniToolConsumptionSet(id, tx);
    const task = await currentTask(id, tx);
    return { task, execution: plan.execution, record: recordFromPlan({ ...plan, task }) };
  });
}
/** A non-terminal observation: the complete indexed mapping with `result: null` for outputs still pending (§93 D5-11). */
export interface MiniToolExecutionProgress {
  planFingerprint: string; expectedVersion: number; outputs: MiniToolExecutionRecord["outputs"];
}
/**
 * Commit newly registered outputs of a running execution without ending it (design §7.11, registered with a non-terminal commit): the
 * same resultVersion arbitration as the terminal commit, a committed result is never rewritten, a registration is checked
 * like the terminal one's and failures wait for the terminal commit. Each newly registered output gets its pending
 * delivery slot in the same transaction, so the worker can deliver it before the run ends (§10.8).
 * @param taskId - The original accepted SQL task.
 * @param progress - The complete indexed mapping and the version it was read at.
 * @returns The current state and original context, unchanged when nothing new is registered.
 * @throws {ConflictError} When the mapping, a committed result or the version differs.
 * @throws {Error} When the run has ended, a registration is not the canonical winner, or persistence fails.
 */
export async function commitMiniToolExecutionProgress(taskId: string, progress: MiniToolExecutionProgress): Promise<MiniToolExecution> {
  const id = z.uuid().parse(taskId);
  const incoming = z.strictObject({
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().nonnegative(), outputs: z.array(miniToolExecutionOutputSchema).min(1),
  }).parse(progress);
  return db.transaction(async (tx) => {
    const plan = await lockedPlan(id, tx);
    const current = recordFromPlan(plan);
    if (incoming.planFingerprint !== plan.execution.planFingerprint || !sameMapping(incoming.outputs, plan.execution)) {
      throw new ConflictError(t("server.idempotency.mismatch"));
    }
    if (plan.task.status !== "pending" && plan.task.status !== "running") throw new Error("An ended execution takes no progress commit");
    const outputs: MiniToolExecutionOutput[] = [];
    for (const [index, output] of incoming.outputs.entries()) {
      const held = current.outputs[index]!;
      if (held.result?.status === "registered") {
        if (output.result !== null && canonicalMiniToolValue(held.result) !== canonicalMiniToolValue(output.result)) throw new ConflictError(t("server.idempotency.mismatch"));
        outputs.push(held);
      } else if (output.result?.status === "registered") {
        await requireRegistered(output, tx);
        outputs.push({ ...output, late: false });
      } else {
        outputs.push(held);
      }
    }
    if (canonicalMiniToolValue(current.outputs) === canonicalMiniToolValue(outputs)) return { task: plan.task, execution: plan.execution, record: current };
    if (incoming.expectedVersion !== current.resultVersion) throw new ConflictError(t("server.idempotency.mismatch"));
    const record = miniToolExecutionRecordSchema.parse({ ...current, outputs, resultVersion: current.resultVersion + 1 });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx);
    await synchronizeMiniToolDelivery(plan.task, record, tx);
    const task = await currentTask(id, tx);
    return { task, execution: plan.execution, record: recordFromPlan({ ...plan, task }) };
  });
}

/**
 * Read only original tasks and current project membership for a collaborator.
 * @param projectId - The Project in the route path.
 * @param runId - The immutable execution run.
 * @param userId - The currently authenticated collaborator.
 * @returns Current computation, registered outputs, whether a retry took each output over (frames-split §7.15) and public
 * actual expenses.
 * @throws {NotFoundError} When the task or project is hidden from this collaborator.
 * @throws {Error} When persisted planning or public metadata is inconsistent.
 */
export async function getMiniToolExecution(projectId: string, runId: string, userId: string): Promise<MiniToolExecutionRecord> {
  const task = await taskRepo.getMiniToolExecutionTask(runId);
  if (task === null || task.deletedAt !== null || task.projectId !== projectId || task.source !== "mini_tool"
    || task.params.miniToolExecution === undefined || await projectAuthService.loadProjectRole(userId, projectId) === null) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const record = recordFromPlan(await executionPlanFromTask(task));
  const taken = new Set(await taskRepo.listMiniToolRetriedOutputIndexes(task.id));
  return { ...record, outputs: record.outputs.map((output) => taken.has(output.outputIndex) ? { ...output, takenOver: true } : output) };
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
    sourceBindings: [execution.binding], outputs: execution.outputs.map((output) => ({ ...output, result: null, late: false })),
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
 * Verify a late observation against its original returned step and durable asset receipt.
 * @param taskId - The original accepted run.
 * @param output - The proposed late registered slot.
 * @param tx - The transaction holding the original parent lock.
 * @throws {Error} When no original returned step owns this registered slot.
 */
async function requireLateReceipt(taskId: string, output: MiniToolExecutionOutput, tx: DbTx): Promise<void> {
  const steps = await upstreamStepRepo.listSteps(taskId, tx);
  const owned = steps.some((step) => step.itemIndex === output.outputIndex && step.output.miniToolStep !== undefined
    && miniToolStepStateSchema.parse(step.output.miniToolStep).result?.outcome === "done"
    && output.result?.status === "registered" && step.output[`miniToolAsset:${output.outputIndex}`] === output.result.assetId);
  if (!owned) throw new Error("Late canonical output has no original returned receipt");
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
 * End a run's pins at a terminal write when nothing can retry it (frames-split §7.15 end of retryability): no output is
 * failed (it completed, or a failed run's failed outputs were all registered late), or its tool has no retry.
 * @param id - The run.
 * @param tool - Its frozen tool.
 * @param record - The terminal record just stored.
 * @param tx - The terminal write's transaction.
 * @throws {Error} When releasing a pin fails.
 */
async function releaseUnretryablePins(id: string, tool: string, record: MiniToolExecutionRecord, tx: DbTx): Promise<void> {
  const failed = record.outputs.flatMap((output) => output.result?.status === "failed" ? [output.result.error] : []);
  if (failed.length > 0 && plannedFailureRetryable(tool)) return;
  await presentationPinService.release({ holderKind: "execution", holderId: id }, tx);
}

/**
 * End a planned run whose task ended outside the worker, cancelled before it started or failed by the stale-waiter sweep
 * (inner#1968 design 3.9), as its terminal state (frames-split §7.15): every output it never wrote fails with the task's
 * reason. A cancelled run cannot be retried, so its pins end; a failed one keeps them while its tool can retry it.
 * @param id - The run, whose task row the caller's transaction just ended.
 * @param tx - That transaction.
 * @throws {Error} When the original plan, the record or the atomic persistence is invalid.
 */
export async function endMiniToolExecutionOutsideRun(id: string, tx: DbTx): Promise<void> {
  const plan = await lockedPlan(id, tx);
  const current = recordFromPlan(plan);
  if (current.outputs.every((output) => output.result !== null)) return;
  const failure = { code: plan.task.errorMessage ?? "internal" };
  const record = miniToolExecutionRecordSchema.parse({
    ...current, resultVersion: current.resultVersion + 1, error: failure,
    outputs: current.outputs.map((output) => output.result === null ? { ...output, result: { status: "failed", error: failure }, late: false } : output),
  });
  await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx);
  if (plan.task.status === "cancelled") {
    await presentationPinService.release({ holderKind: "execution", holderId: id }, tx);
    return;
  }
  await releaseUnretryablePins(id, plan.execution.tool, record, tx);
  if (plan.task.result?.settlement === undefined) await completeMiniToolConsumptionSet(id, tx);
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
    const record = miniToolExecutionRecordSchema.parse({
      ...current, status: "failed", resultVersion: current.resultVersion + 1, error: failure,
      outputs: current.outputs.map((output) => ({ ...output, result: { status: "failed", error: failure }, late: false })),
    });
    await taskRepo.storeMiniToolExecutionRecord(id, { ...record }, tx, {
      status: "failed", errorMessage: typeof failure.code === "string" ? failure.code : "internal", finish: true,
    });
    await releaseUnretryablePins(id, plan.execution.tool, record, tx);
    // Original intents register settlement under this same lock before paid IO.
    // An acknowledgement failure cannot release their hold or close their set.
    if (plan.task.result?.settlement === undefined) {
      await completeMiniToolConsumptionSet(id, tx);
      await creditHoldRepo.releaseHold(id, tx);
    }
    return recordFromPlan({ ...plan, task: await currentTask(id, tx) });
  });
}
