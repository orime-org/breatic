// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { db, type DbTx } from "@breatic/core";
import { mirrorMiniToolExecutionConsumption } from "@domain/mini-tool/execution-usage.service.js";
import { canonicalMiniToolValue, miniToolConsumptionKey } from "@breatic/shared/mini-tools";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import { miniToolStepStateSchema, hasUnresolvedMiniToolStepAttempts } from "@domain/mini-tool/upstream-step.types.js";
import { isUnresolvedModelStep } from "@domain/mini-tool/consumption-due.js";
import {
  miniToolConsumptionRecordSchema, miniToolSettlementSchema, openMiniToolConsumptionInputSchema,
  type MiniToolConsumptionRecord, type MiniToolSettlement, type OpenMiniToolConsumptionInput,
} from "@domain/mini-tool/consumption.types.js";

/**
 * Read an existing period or the initial unopened call set while holding its task lock.
 * @param result - Current parent result, including unrelated computation output.
 * @returns The persisted period, or an empty period before the first call.
 * @throws {z.ZodError} When existing settlement metadata is malformed.
 */
function currentPeriod(result: Record<string, unknown>): MiniToolSettlement {
  return miniToolSettlementSchema.parse(result.settlement ?? {
    version: 0, state: "idle", pendingConsumptionKeys: [], nextAttemptAt: null,
    leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: false,
  });
}

/**
 * Rebuild due work from committed steps instead of accepting caller-supplied keys.
 * @param taskId - The parent whose immutable row lock is held.
 * @param tx - The same transaction as the producer write.
 * @returns Pending and known keys in persistent step order.
 * @throws {Error} When a read or a persisted consumption is invalid.
 */
async function pendingKeys(taskId: string, tx: DbTx): Promise<string[]> {
  const steps = await upstreamStepRepo.listSteps(taskId, tx);
  return steps.flatMap((step) => {
    if (step.output.miniToolConsumption === undefined) return [];
    const fact = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    return fact.state === "recorded" ? [] : [fact.consumptionKey];
  });
}

/**
 * Persist one frozen upstream identity and its unresolved expense before submission.
 *
 * A pending identity is not evidence of a charge: lookup must still obtain an
 * actual bill or measured usage. Replays return the first policy and price.
 * The task PK lock serializes producers, recorders and the final billing fence;
 * this transaction performs no provider, storage or container IO.
 * @param input - The owned step, actual identity and initial internal price policy.
 * @param transaction - An outer transaction that also freezes the execution request.
 * @returns Its original consumption, unchanged on same-identity replay.
 * @throws {Error} When ownership, identity, the submission fence or persistence fails.
 */
export async function openMiniToolConsumption(input: OpenMiniToolConsumptionInput, transaction?: DbTx): Promise<MiniToolConsumptionRecord> {
  const request = openMiniToolConsumptionInputSchema.parse(input);
  return transaction === undefined
    ? db.transaction((tx) => produceConsumption(request, tx))
    : produceConsumption(request, transaction);
}

/**
 * Apply the common producer transition after its caller has established call authority.
 * @param request - The original consumption identity and first price policy.
 * @param tx - The shared identity, expense and task-period transaction.
 * @returns The original or newly pending expense without estimating a missing amount.
 * @throws {Error} When ownership, immutable identity or the submission fence fails.
 */
async function produceConsumption(request: OpenMiniToolConsumptionInput, tx: DbTx): Promise<MiniToolConsumptionRecord> {
  const task = await taskRepo.lockMiniToolConsumptionTask(request.taskId, tx);
  if (!task || task.source !== "mini_tool") throw new Error("Mini-tool consumption has no owning task");
  const step = await upstreamStepRepo.getStepForConsumption(task.id, request.stepId, tx);
  if (!step) throw new Error("Mini-tool consumption step belongs to another task");
  const key = await miniToolConsumptionKey({ taskId: task.id, stepId: step.id, identity: request.identity });
  if (step.output.miniToolConsumption !== undefined) {
    const held = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    if (held.consumptionKey !== key || canonicalMiniToolValue(held.identity) !== canonicalMiniToolValue(request.identity)) {
      throw new Error("Consumption upstream identity cannot be replaced");
    }
    return held;
  }
  const previous = currentPeriod(task.result);
  if (task.billedAt !== null || (task.status !== "pending" && task.status !== "running") ||
    previous.consumptionSetComplete === true || previous.state === "settled") {
    throw new Error("Mini-tool consumption set no longer accepts new calls");
  }
  // A model step's consumption is opened by its end (model-step.service.ts), never before its call.
  if (request.identity.kind !== "container" || step.kind !== "container_job" || step.endpoint !== request.identity.containerClass) {
    throw new Error("Container consumption requires its actual owning class step");
  }
  const fact = miniToolConsumptionRecordSchema.parse({
    schemaVersion: 1, consumptionKey: key, identity: request.identity, state: "pending",
    chargeTo: request.chargeTo, creditMultiplier: request.creditMultiplier, containerPricing: request.containerPricing,
    costUsd: null, costSource: null, raw: null, credits: null,
  });
  await upstreamStepRepo.storeMiniToolConsumption(task.id, step.id, fact, tx);
  await taskRepo.storeMiniToolSettlement(task.id, miniToolSettlementSchema.parse({
    ...previous, version: previous.version + 1, state: "waiting", consumptionSetComplete: false,
    pendingConsumptionKeys: await pendingKeys(task.id, tx), nextAttemptAt: await taskRepo.miniToolSettlementDatabaseNow(task.id, tx),
    leaseToken: null, leaseUntil: null, lastError: null,
  }), tx);
  await mirrorMiniToolExecutionConsumption(task, fact, tx);
  return fact;
}

/**
 * Close a terminal computation's call set without guessing its unresolved costs.
 * @param taskId - The immutable parent after computation has ended.
 * @param transaction - The transaction committing the computation's terminal outcome.
 * @returns The committed period, unchanged for an already closed set.
 * @throws {Error} When the parent is absent, still computing or cannot be persisted.
 */
export async function completeMiniToolConsumptionSet(taskId: string, transaction?: DbTx): Promise<MiniToolSettlement> {
  const id = z.string().uuid().parse(taskId);
  /**
   * Close the call set while sharing its computation owner's parent lock.
   * @param tx - The transaction holding or acquiring the original task lock.
   * @returns The preserved or newly closed settlement period.
   * @throws {Error} When ownership, terminal state or persistence is invalid.
   */
  const execute = async (tx: DbTx): Promise<MiniToolSettlement> => {
    const task = await taskRepo.lockMiniToolConsumptionTask(id, tx);
    if (!task || task.source !== "mini_tool") throw new Error("Mini-tool consumption has no owning task");
    const previous = currentPeriod(task.result);
    if (previous.consumptionSetComplete === true) return previous;
    if (task.status !== "completed" && task.status !== "failed") {
      throw new Error("Mini-tool computation must end before closing its call set");
    }
    const steps = await upstreamStepRepo.listSteps(id, tx);
    for (const step of steps) {
      if (isUnresolvedModelStep(step) || step.output.miniToolStep !== undefined && hasUnresolvedMiniToolStepAttempts(miniToolStepStateSchema.parse(step.output.miniToolStep))) {
        throw new Error("Mini-tool submit attempts are still unresolved");
      }
    }
    // A terminal notification adds no identity and cannot revoke an in-flight
    // lookup. Its existing lease will accept the answer or expire normally.
    const next = miniToolSettlementSchema.parse(previous.state === "checking"
      ? { ...previous, consumptionSetComplete: true }
      : {
        ...previous, version: previous.version + 1, state: "waiting", consumptionSetComplete: true,
        pendingConsumptionKeys: await pendingKeys(id, tx), nextAttemptAt: await taskRepo.miniToolSettlementDatabaseNow(id, tx),
        leaseToken: null, leaseUntil: null, lastError: null,
      });
    await taskRepo.storeMiniToolSettlement(id, next, tx);
    return next;
  };
  return transaction === undefined ? db.transaction(execute) : execute(transaction);
}

/**
 * Close an ended computation's call set once every submit attempt it persisted is resolved, whatever its tool or lane
 * (execution design §6.12). Every billable call stores its identity before IO (a provider call's submit intent, a
 * container job's consumption), and an ended task opens no new identity, so the persisted steps are the whole call set.
 * @param taskId - The mini-tool task, an execution or an analysis.
 * @param tx - The transaction committing its terminal outcome or a late receipt.
 * @returns Nothing; the set stays open while the task runs or any attempt is unresolved.
 * @throws {Error} When the task is absent or closure persistence fails.
 */
export async function completeResolvedMiniToolConsumptionSet(taskId: string, tx: DbTx): Promise<void> {
  const task = await taskRepo.lockMiniToolConsumptionTask(taskId, tx);
  if (!task || (task.status !== "completed" && task.status !== "failed")) return;
  const steps = await upstreamStepRepo.listSteps(taskId, tx);
  if (steps.some((step) => isUnresolvedModelStep(step) || step.output.miniToolStep !== undefined
    && hasUnresolvedMiniToolStepAttempts(miniToolStepStateSchema.parse(step.output.miniToolStep)))) return;
  await completeMiniToolConsumptionSet(taskId, tx);
}
