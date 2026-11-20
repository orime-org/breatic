// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import type { UpstreamStep } from "@domain/task/upstreamStep.repo.js";

import { z } from "zod";
import { db, type DbTx } from "@breatic/core";
import { miniToolPlanJobRequestSchema } from "@breatic/shared";
import { canonicalMiniToolValue, miniToolConsumptionIdentitySchema } from "@breatic/shared/mini-tools";
import * as taskRepo from "@domain/task/task.repo.js";
import * as stepRepo from "@domain/task/upstreamStep.repo.js";
import { miniToolConsumptionRecordSchema } from "@domain/mini-tool/consumption.types.js";
import { miniToolStepStateSchema, type MiniToolStepState, type MiniToolStepJson } from "@domain/mini-tool/upstream-step.types.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";
import * as pinRepo from "@domain/presentation/presentation-pin.repo.js";

export type { MiniToolStepJson } from "@domain/mini-tool/upstream-step.types.js";
/** A pure operation-owned result decoder; no provider or storage IO belongs here. */
export interface MiniToolStepResultParser {
  kind: "generate" | "container_job";
  parse: (value: unknown) => Record<string, MiniToolStepJson>;
}
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
      if (step.kind !== "generate" || request.identity.stepId !== step.id) throw new Error("Execution result differs from its model step");
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


const scope = { taskId: z.uuid(), stepId: z.uuid() };
const jsonObject = z.record(z.string(), z.json());
const resultSchema = z.strictObject({ ...scope, identity: miniToolConsumptionIdentitySchema, outcome: z.enum(["done", "failed"]), result: z.unknown(), error: jsonObject.optional(),
  presentation: z.strictObject({
    prepared: z.strictObject({ toolInputId: z.string().regex(/^[a-f0-9]{64}$/), preparedKey: z.string().min(1) }).optional(),
    retire: z.array(z.string().min(1)).optional(),
    pin: z.array(z.string().min(1)).optional(),
  }).optional() });

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
