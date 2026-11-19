// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import type { UpstreamStep } from "@domain/task/upstreamStep.repo.js";
import type { MiniToolConsumptionRecord } from "@domain/mini-tool/consumption.types.js";

import { z } from "zod";
import { db, env, type DbTx } from "@breatic/core";
import { miniToolPlanJobRequestSchema } from "@breatic/shared";
import { canonicalMiniToolValue, hashMiniToolValue, miniToolConsumptionIdentitySchema } from "@breatic/shared/mini-tools";
import * as taskRepo from "@domain/task/task.repo.js";
import * as stepRepo from "@domain/task/upstreamStep.repo.js";
import { miniToolConsumptionRecordSchema, miniToolSettlementSchema } from "@domain/mini-tool/consumption.types.js";
import { completeResolvedMiniToolConsumptionSet, openMiniToolConsumptionForStepAttempt } from "@domain/mini-tool/consumption-producer.service.js";
import { miniToolStepStateSchema, type MiniToolStepState, type MiniToolStepJson, type MiniToolStepAttempt } from "@domain/mini-tool/upstream-step.types.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";
import * as pinRepo from "@domain/presentation/presentation-pin.repo.js";

export type { MiniToolStepJson, MiniToolStepAttempt } from "@domain/mini-tool/upstream-step.types.js";
/** A pure operation-owned result decoder; no provider or storage IO belongs here. */
export interface MiniToolStepResultParser {
  kind: "generate" | "container_job";
  parse: (value: unknown) => Record<string, MiniToolStepJson>;
}
/** Internal submit inputs; first policy and request facts win on recovery. */
export interface BeginMiniToolStepAttemptInput {
  taskId: string; stepId: string; attemptId: string; deadlineAt: number;
  requestBody: Record<string, MiniToolStepJson>; chargeTo: "user" | "platform";
}
/** Only the first preparation of a new attempt can authorize the caller's POST. */
export interface BeginMiniToolStepAttemptResult { step: UpstreamStep; attempt: MiniToolStepAttempt | null; shouldSubmit: boolean }
/** A receipt is tied to an existing immutable submit intent. */
export interface RecordMiniToolStepIdentityInput { taskId: string; stepId: string; attemptId: string; predictionId: string }
/** A conflicting receipt preserves the canonical identity and never assigns replacement fees. */
export interface RecordMiniToolStepIdentityResult { step: UpstreamStep; consumption: MiniToolConsumptionRecord | null; conflict: boolean }
/** A decoded terminal result remains independent from its consumption's fee state. */
export interface RecordMiniToolStepResultInput {
  taskId: string; stepId: string; identity: MiniToolConsumptionIdentity;
  outcome: "done" | "failed"; result: unknown; error?: Record<string, MiniToolStepJson>;
  /**
   * Presentation pins written with a newly stored preparation result (§7.15 prepared row, release points): the final prepared
   * output the run now keeps, outputs it no longer needs (a failed attempt's, chunks after their stitch), and intermediates
   * appended to the run's execution pin, or an analysis's analysis pin (§97 D21-1: a lip-sync step's derived objects;
   * execution design §10.3: a tracking analysis's clips and RLE).
   */
  presentation?: { prepared?: { toolInputId: string; preparedKey: string }; retire?: string[]; pin?: string[] };
}
/** Explicit attempt resolution can only describe that particular original request. */
export interface FailMiniToolStepInput {
  taskId: string; stepId: string; error: Record<string, MiniToolStepJson>;
  attempt?: { attemptId: string; proof: "not_sent" | "rejected" };
}

/**
 * Persist an owned request intent before the caller can submit it.
 * @param input - The owned scope and immutable request intent.
 * @returns The original or newly prepared intent and the caller submission gate.
 * @throws {Error} When persistence, ownership or the original submit fence fails.
 */
export async function beginMiniToolStepAttempt(input: BeginMiniToolStepAttemptInput): Promise<BeginMiniToolStepAttemptResult> {
  const request = beginSchema.parse(input);
  return db.transaction(async (tx) => {
    const { task, step, state } = await ownedStep(request.taskId, request.stepId, tx);
    if (step.kind !== "generate") throw new Error("Provider submit intent requires a generate step");
    const fingerprint = await hashMiniToolValue({ kind: step.kind, endpoint: step.endpoint, requestBody: request.requestBody });
    if (state.requestFingerprint !== null && state.requestFingerprint !== fingerprint) throw new Error("Planned submit body cannot replace its original request");
    const held = state.attempts.find((attempt) => attempt.attemptId === request.attemptId);
    if (held) return { step, attempt: held, shouldSubmit: false };
    if (step.predictionId !== null || step.status === "done" || step.status === "failed" || task.status !== "pending" && task.status !== "running" || closed(task)) {
      return { step, attempt: null, shouldSubmit: false };
    }
    const now = await taskRepo.miniToolSettlementDatabaseNow(task.id, tx);
    const deadlineAt = state.deadlineAt ?? request.deadlineAt;
    if (Date.parse(now) >= deadlineAt) return { step, attempt: null, shouldSubmit: false };
    if (state.requestBody === null) {
      state.deadlineAt = deadlineAt; state.requestBody = request.requestBody; state.requestFingerprint = fingerprint;
      state.chargeTo = request.chargeTo; state.creditMultiplier = env.CREDIT_MULTIPLIER;
    }
    const attempt: MiniToolStepAttempt = { attemptId: request.attemptId, preparedAt: now, requestFingerprint: fingerprint, resolution: { kind: "unresolved" } };
    state.attempts.push(attempt);
    await stepRepo.storeMiniToolStepExecution(task.id, step.id, state, {}, tx);
    if (task.result.settlement === undefined) {
      await taskRepo.storeMiniToolSettlement(task.id, miniToolSettlementSchema.parse({
        version: 0, state: "waiting", consumptionSetComplete: false, pendingConsumptionKeys: [],
        nextAttemptAt: now, leaseToken: null, leaseUntil: null, lastError: null,
      }), tx);
    }
    return { step: await reread(task.id, step.id, tx), attempt, shouldSubmit: true };
  });
}

/**
 * Save a matching prediction receipt and its pending expense in one transaction.
 * @param input - A receipt tied to the original durable intent.
 * @returns The canonical identity and preserved expense, or a recorded conflict.
 * @throws {Error} When no matching durable attempt authorizes this receipt.
 */
export async function recordMiniToolStepIdentity(input: RecordMiniToolStepIdentityInput): Promise<RecordMiniToolStepIdentityResult> {
  const request = identitySchema.parse(input);
  const answer = await db.transaction(async (tx): Promise<RecordMiniToolStepIdentityResult | Error> => {
    const { task, step, state } = await ownedStep(request.taskId, request.stepId, tx);
    if (step.kind !== "generate") throw new Error("Provider identity requires a generate step");
    const attempt = state.attempts.find((candidate) => candidate.attemptId === request.attemptId);
    if (!attempt || state.requestFingerprint === null || attempt.requestFingerprint !== state.requestFingerprint || state.requestBody === null) throw new Error("Provider identity has no matching persisted submit intent");
    const fingerprint = await hashMiniToolValue({ kind: step.kind, endpoint: step.endpoint, requestBody: state.requestBody });
    if (fingerprint !== state.requestFingerprint) throw new Error("Provider identity request fingerprint is inconsistent");
    const receipt = { kind: "identity" as const, predictionId: request.predictionId };
    if (attempt.resolution.kind !== "unresolved" && canonicalMiniToolValue(attempt.resolution) !== canonicalMiniToolValue(receipt)) {
      return recordIdentityConflict(task.id, step, state, request, tx);
    }
    if (step.predictionId !== null && step.predictionId !== request.predictionId) return recordIdentityConflict(task.id, step, state, request, tx);
    const consumption = step.output.miniToolConsumption === undefined ? null : miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    if (consumption !== null && (consumption.identity.kind !== "provider" || consumption.identity.predictionId !== request.predictionId)) throw new Error("Provider receipt differs from the stored expense");
    if (consumption === null && closed(task)) {
      const conflict = { kind: "closed_identity" as const, attemptId: request.attemptId, candidateId: request.predictionId };
      if (appendConflict(state, conflict)) await stepRepo.storeMiniToolStepExecution(task.id, step.id, state, {}, tx);
      return new Error("Provider receipt conflicts with the closed consumption set");
    }
    const changed = canonicalMiniToolValue(attempt.resolution) !== canonicalMiniToolValue(receipt);
    attempt.resolution = receipt;
    if (changed || step.predictionId === null) {
      await stepRepo.storeMiniToolStepExecution(task.id, step.id, state, {
        predictionId: request.predictionId,
        ...(step.status === "pending" ? { status: "submitted" as const } : {}),
      }, tx);
    }
    const stored = consumption ?? await openMiniToolConsumptionForStepAttempt(request, tx);
    // A late receipt may resolve an ended execution's or analysis's last attempt; the closer itself skips a running task.
    await completeResolvedMiniToolConsumptionSet(task.id, tx);
    return { step: await reread(task.id, step.id, tx), consumption: stored, conflict: false };
  });
  if (answer instanceof Error) throw answer;
  return answer;
}

/**
 * Save an operation-validated terminal result without rewriting fee or plan facts.
 * @param input - The original identity and operation result.
 * @param parser - A pure decoder for that operation and step kind.
 * @returns The current step with its original or newly saved operation result.
 * @throws {Error} When parsing, identity, ownership or persistence fails.
 */
export async function recordMiniToolStepResult(input: RecordMiniToolStepResultInput, parser: MiniToolStepResultParser): Promise<UpstreamStep> {
  const request = resultSchema.parse(input);
  const result = jsonObject.parse(parser.parse(request.result));
  if (request.outcome === "failed" && request.error === undefined) throw new Error("Failed execution result requires its original error");
  const answer = await db.transaction(async (tx): Promise<UpstreamStep | Error> => {
    const { task, step, state } = await ownedStep(request.taskId, request.stepId, tx);
    if (step.kind !== parser.kind) throw new Error("Result parser differs from its owning step kind");
    const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    if (canonicalMiniToolValue(consumption.identity) !== canonicalMiniToolValue(request.identity)) throw new Error("Execution result differs from its stored consumption identity");
    if (request.identity.kind === "provider") {
      if (step.kind !== "generate" || step.predictionId !== request.identity.predictionId) throw new Error("Execution result has no canonical provider identity");
    } else {
      const plan = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
      if (step.kind !== "container_job" || step.endpoint !== request.identity.containerClass || plan.containerClass !== request.identity.containerClass || plan.jobId !== request.identity.jobId) throw new Error("Execution result differs from its complete original plan");
    }
    const incoming = { outcome: request.outcome, result, error: request.error ?? null };
    if (state.result !== null) {
      if (canonicalMiniToolValue(state.result) === canonicalMiniToolValue(incoming)) return step;
      if (appendConflict(state, { kind: "result", result })) await stepRepo.storeMiniToolStepExecution(task.id, step.id, state, {}, tx);
      return new Error("Execution result conflicts with its first canonical result");
    }
    state.result = incoming;
    const terminal = step.status === "done" || step.status === "failed";
    if (request.outcome === "failed" && !terminal) state.error = request.error!;
    await stepRepo.storeMiniToolStepExecution(task.id, step.id, state, terminal ? {} : { status: request.outcome }, tx);
    const pins = request.presentation;
    if (pins?.prepared !== undefined) {
      await presentationPinService.acquire({ holderKind: "prepared", holderId: task.id, toolInputId: pins.prepared.toolInputId, preparedKey: pins.prepared.preparedKey, objectKeys: [pins.prepared.preparedKey] }, tx);
    }
    const holderKind = task.taskType === "mini_tool_analysis" ? "analysis" : "execution";
    if (pins?.retire !== undefined) await presentationPinService.retire({ holderKind, holderId: task.id }, pins.retire, tx);
    if (pins?.pin !== undefined) await pinRepo.appendPinObjects(holderKind, task.id, pins.pin, tx);
    return reread(task.id, step.id, tx);
  });
  if (answer instanceof Error) throw answer;
  return answer;
}

/**
 * Preserve the first failure and any explicit resolution of its own submit intent.
 * @param input - The failure and any specifically evidenced attempt resolution.
 * @returns The preserved terminal step or newly saved failure.
 * @throws {Error} When ownership, resolution proof or persistence fails.
 */
export async function failMiniToolStep(input: FailMiniToolStepInput): Promise<UpstreamStep> {
  const request = failureSchema.parse(input);
  return db.transaction(async (tx) => {
    const { task, step, state } = await ownedStep(request.taskId, request.stepId, tx);
    let changed = false;
    if (request.attempt !== undefined) {
      const attempt = state.attempts.find((candidate) => candidate.attemptId === request.attempt!.attemptId);
      if (!attempt) throw new Error("Failure resolution has no matching persisted attempt");
      const resolution = { kind: request.attempt.proof, error: request.error };
      if (attempt.resolution.kind === "unresolved") { attempt.resolution = resolution; changed = true; }
      else if (canonicalMiniToolValue(attempt.resolution) !== canonicalMiniToolValue(resolution)) throw new Error("Failure proof conflicts with the original attempt resolution");
    }
    const terminal = step.status === "done" || step.status === "failed";
    if (!terminal) { state.error = request.error; changed = true; }
    if (!changed) return step;
    await stepRepo.storeMiniToolStepExecution(task.id, step.id, state, terminal ? {} : { status: "failed" }, tx);
    // A proof that arrives after the task ended may resolve its last attempt, so its call set closes here.
    await completeResolvedMiniToolConsumptionSet(task.id, tx);
    return reread(task.id, step.id, tx);
  });
}


const scope = { taskId: z.uuid(), stepId: z.uuid() };
const jsonObject = z.record(z.string(), z.json());
const beginSchema = z.strictObject({ ...scope, attemptId: z.uuid(), deadlineAt: z.number().int().positive(), requestBody: jsonObject, chargeTo: z.enum(["user", "platform"]) });
const identitySchema = z.strictObject({ ...scope, attemptId: z.uuid(), predictionId: z.string().min(1) });
const resultSchema = z.strictObject({ ...scope, identity: miniToolConsumptionIdentitySchema, outcome: z.enum(["done", "failed"]), result: z.unknown(), error: jsonObject.optional(),
  presentation: z.strictObject({
    prepared: z.strictObject({ toolInputId: z.string().regex(/^[a-f0-9]{64}$/), preparedKey: z.string().min(1) }).optional(),
    retire: z.array(z.string().min(1)).optional(),
    pin: z.array(z.string().min(1)).optional(),
  }).optional() });
const failureSchema = z.strictObject({ ...scope, error: jsonObject, attempt: z.strictObject({ attemptId: z.uuid(), proof: z.enum(["not_sent", "rejected"]) }).optional() });

/**
 * Acquire the common immutable task lock and bind execution metadata to its original step.
 * @param taskId - The immutable owning task.
 * @param stepId - The immutable owned step.
 * @param tx - The result, identity or failure transaction.
 * @returns Current parent, step and validated execution facts.
 * @throws {Error} When ownership or persisted execution scope is inconsistent.
 */
async function ownedStep(taskId: string, stepId: string, tx: DbTx): Promise<{ task: taskRepo.LockedMiniToolConsumptionTask; step: UpstreamStep; state: MiniToolStepState }> {
  const task = await taskRepo.lockMiniToolConsumptionTask(taskId, tx);
  if (!task || task.source !== "mini_tool") throw new Error("Planned step has no owning mini-tool task");
  const step = await reread(taskId, stepId, tx);
  if (step.kind !== "generate" && step.kind !== "container_job") throw new Error("Unsupported planned step kind");
  const scope = { taskId, stepId, kind: step.kind, endpoint: step.endpoint, itemIndex: step.itemIndex };
  const plan = step.output.miniToolPlanJob === undefined ? null : miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
  const state = step.output.miniToolStep === undefined ? miniToolStepStateSchema.parse({
    schemaVersion: 1, scope, deadlineAt: plan?.deadlineAt ?? null, requestBody: null, requestFingerprint: null,
    chargeTo: null, creditMultiplier: null, attempts: [], result: null, error: null, conflicts: [],
  }) : miniToolStepStateSchema.parse(step.output.miniToolStep);
  if (canonicalMiniToolValue(state.scope) !== canonicalMiniToolValue(scope)) throw new Error("Planned execution scope differs from its original step");
  return { task, step, state };
}

/**
 * Re-read the owned step through the shared transaction after a narrow write.
 * @param taskId - The parent whose row lock is held.
 * @param stepId - Its original step.
 * @param tx - The transaction containing all related writes.
 * @returns The current owned step.
 * @throws {Error} When a step is missing or belongs elsewhere.
 */
async function reread(taskId: string, stepId: string, tx: DbTx): Promise<UpstreamStep> {
  const step = await stepRepo.getStepForConsumption(taskId, stepId, tx);
  if (!step) throw new Error("Planned step does not belong to its owning task");
  return step;
}

/**
 * Read the existing submission fence without guessing that absent costs mean zero.
 * @param task - Current facts read under the immutable task lock.
 * @returns Whether no new consumption identity may be opened.
 * @throws {z.ZodError} When an existing settlement period is malformed.
 */
function closed(task: taskRepo.LockedMiniToolConsumptionTask): boolean {
  const period = task.result.settlement === undefined ? null : miniToolSettlementSchema.parse(task.result.settlement);
  return task.billedAt !== null || period?.consumptionSetComplete === true || period?.state === "settled";
}

/**
 * Retain one canonicalized conflict for reconciliation without growing duplicate facts.
 * @param state - The operation-owned state in this transaction.
 * @param conflict - The observed identity or result conflict.
 * @returns Whether a new fact was appended.
 * @throws {TypeError} When a conflict cannot be represented as finite JSON.
 */
function appendConflict(state: MiniToolStepState, conflict: MiniToolStepState["conflicts"][number]): boolean {
  const identity = canonicalMiniToolValue(conflict);
  if (state.conflicts.some((held) => canonicalMiniToolValue(held) === identity)) return false;
  state.conflicts.push(conflict);
  return true;
}

/**
 * Preserve an incompatible receipt without changing the canonical ID or assigning fees.
 * @param taskId - The parent whose lock is held.
 * @param step - The original current step.
 * @param state - Validated execution and attempt facts.
 * @param receipt - The conflicting original-attempt receipt.
 * @param tx - The same task transaction.
 * @returns The preserved canonical step and expense with a conflict indication.
 * @throws {Error} When conflict persistence fails.
 */
async function recordIdentityConflict(taskId: string, step: UpstreamStep, state: MiniToolStepState, receipt: RecordMiniToolStepIdentityInput, tx: DbTx): Promise<RecordMiniToolStepIdentityResult> {
  const conflict = { kind: "identity" as const, attemptId: receipt.attemptId, canonicalId: step.predictionId, candidateId: receipt.predictionId };
  if (appendConflict(state, conflict)) await stepRepo.storeMiniToolStepExecution(taskId, step.id, state, {}, tx);
  return { step: await reread(taskId, step.id, tx), consumption: step.output.miniToolConsumption === undefined ? null : miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption), conflict: true };
}
