// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { db } from "@breatic/core";
import { mirrorMiniToolExecutionConsumption } from "@domain/mini-tool/execution-usage.service.js";
import { canonicalMiniToolValue, miniToolConsumptionKey } from "@breatic/shared/mini-tools";
import { insertUsageRecord } from "@domain/credit/agentUsage.repo.js";
import { createUsageRecorder } from "@domain/credit/usage-recorder.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import {
  miniToolConsumptionRecordSchema, miniToolSettlementSchema, recordMiniToolConsumptionInputSchema,
  confirmMiniToolConsumptionInputSchema,
  type ConfirmMiniToolConsumptionInput, type MiniToolConsumptionRecord, type MiniToolSettlement, type RecordMiniToolConsumptionInput,
} from "@domain/mini-tool/consumption.types.js";

/**
 * Advance the recording period after a known consumption becomes recorded.
 * @param previous - The current period read while holding the task lock.
 * @param pendingConsumptionKeys - Outstanding pending and known facts from steps.
 * @param terminal - Whether computation already ended, independently of billing.
 * @param databaseNow - The fresh SQL clock instant for newly due settlement work.
 * @returns The next period; no funds are claimed here.
 * @throws {Error} When settlement metadata is invalid.
 */
function afterRecorded(
  previous: MiniToolSettlement, pendingConsumptionKeys: string[], terminal: boolean, databaseNow: string,
): MiniToolSettlement {
  const waiting = terminal || pendingConsumptionKeys.length > 0;
  return miniToolSettlementSchema.parse({
    ...previous, version: previous.version + 1, state: waiting ? "waiting" : "idle",
    pendingConsumptionKeys, nextAttemptAt: waiting ? databaseNow : null,
    leaseToken: null, leaseUntil: null, lastError: null,
  });
}

/**
 * Record one already-known consumption atomically with its persistent step and todo.
 *
 * The task PK is the only explicit lock: after it is acquired the current step
 * is re-read, so normal execution and lookup cannot both spend a stale known
 * state. Upstream queries and media operations do not run in this transaction.
 * @param input - The original task, step, upstream identity and optional lookup claim.
 * @returns The persistent consumption, unchanged for pending, replay or stale lookup.
 * @throws {Error} When identity is inconsistent, persistence fails or a lease expires mid-write.
 */
export async function recordMiniToolConsumption(input: RecordMiniToolConsumptionInput): Promise<MiniToolConsumptionRecord> {
  const request = recordMiniToolConsumptionInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolConsumptionTask(request.taskId, tx);
    if (!task || task.source !== "mini_tool") throw new Error("Mini-tool consumption has no owning task");
    const step = await upstreamStepRepo.getStepForConsumption(task.id, request.stepId, tx);
    if (!step) throw new Error("Mini-tool consumption step belongs to another task");
    const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    const key = await miniToolConsumptionKey({ taskId: task.id, stepId: step.id, identity: consumption.identity });
    if (key !== consumption.consumptionKey) throw new Error("Consumption key differs from its persistent identity");
    if (canonicalMiniToolValue(request.identity) !== canonicalMiniToolValue(consumption.identity)) {
      if (request.claim) return consumption;
      throw new Error("Consumption upstream identity cannot be replaced");
    }
    if (consumption.identity.kind === "provider" && (consumption.identity.stepId !== step.id || step.kind !== "generate")) {
      throw new Error("Consumption differs from its model step");
    }
    if (consumption.identity.kind === "container" && step.kind !== "container_job") {
      throw new Error("Container consumption requires its actual container step");
    }
    const settlement = miniToolSettlementSchema.parse(task.result.settlement);
    if (request.claim && !await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) return consumption;
    if (consumption.state !== "known") return consumption;
    if (settlement.state === "settled") return consumption;
    const { costUsd } = consumption;
    if (costUsd === null) throw new Error("Known consumption has no confirmed amount");
    const multiplier = consumption.chargeTo === "platform" ? 0 : consumption.creditMultiplier;
    const recorder = createUsageRecorder({
      operationKey: key, feature: "mini_tool", actorUserId: task.userId, projectId: task.projectId,
      multiplier,
      write: (row) => insertUsageRecord(row, tx),
      // A model step's cost no upstream could name is recorded at zero, as a canvas generation's is (cost-wait.ts);
      // the worker logs `cost_unavailable` where the step's run or lookup handed it over.
      onMissingCost: () => undefined,
    });
    if (consumption.identity.kind === "provider") {
      // One row per billed answer, its source as provider reported it (§11.4 recording row).
      const answered = [...consumption.costs!, ...consumption.waiting!.flatMap((held) => (held.cost === undefined ? [] : [held.cost]))];
      for (const cost of answered) recorder.recordModelCall({ source: "model", model: step.endpoint, upstream: consumption.servedBy ?? "unknown", cost });
    } else {
      recorder.recordServiceCall({ source: "container", service: `cloudflare-container:${step.endpoint}`, provider: "cloudflare", requests: 1, costUsd, costSource: "computed" });
    }
    // settle waits for the injected write; its rounded return belongs to the
    // ordinary single-operation charge path, not this parent's later aggregate.
    await recorder.settle();
    if (request.claim && !await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) {
      throw new Error("Mini-tool settlement lease expired before recording");
    }
    const recorded = miniToolConsumptionRecordSchema.parse({
      ...consumption, state: "recorded", credits: creditsForUsd(costUsd, multiplier),
    });
    await upstreamStepRepo.storeMiniToolConsumption(task.id, step.id, recorded, tx);
    const steps = await upstreamStepRepo.listSteps(task.id, tx);
    const pendingConsumptionKeys = steps.flatMap((current) => {
      if (current.output.miniToolConsumption === undefined) return [];
      const fact = miniToolConsumptionRecordSchema.parse(current.output.miniToolConsumption);
      return fact.state === "recorded" ? [] : [fact.consumptionKey];
    });
    const databaseNow = await taskRepo.miniToolSettlementDatabaseNow(task.id, tx);
    const terminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
    await taskRepo.storeMiniToolSettlement(task.id, afterRecorded(settlement, pendingConsumptionKeys, terminal, databaseNow), tx);
    await mirrorMiniToolExecutionConsumption(task, recorded, tx);
    return recorded;
  });
}

/**
 * Persist a confirmed original-identity expense before attempting its usage write.
 * @param input - The still-current lookup lease, original identity and actual cost.
 * @returns The persistent fact, unchanged for stale answers or already-confirmed costs.
 * @throws {Error} When validation, identity consistency or persistence fails.
 */
export async function confirmMiniToolConsumption(input: ConfirmMiniToolConsumptionInput): Promise<MiniToolConsumptionRecord> {
  const request = confirmMiniToolConsumptionInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolConsumptionTask(request.taskId, tx);
    if (!task || task.source !== "mini_tool") throw new Error("Mini-tool consumption has no owning task");
    const step = await upstreamStepRepo.getStepForConsumption(task.id, request.stepId, tx);
    if (!step) throw new Error("Mini-tool consumption step belongs to another task");
    const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    if (canonicalMiniToolValue(request.identity) !== canonicalMiniToolValue(consumption.identity)) return consumption;
    if (!await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) return consumption;
    if (consumption.state !== "pending" || task.billedAt !== null) return consumption;
    const key = await miniToolConsumptionKey({ taskId: task.id, stepId: step.id, identity: consumption.identity });
    if (key !== consumption.consumptionKey) throw new Error("Consumption key differs from its persistent identity");
    if (consumption.identity.kind !== "container" || step.kind !== "container_job") {
      throw new Error("Only a container job's cost is confirmed from its report");
    }
    const known = miniToolConsumptionRecordSchema.parse({
      ...consumption, state: "known", costUsd: request.costUsd, costSource: request.costSource, raw: request.raw,
    });
    await upstreamStepRepo.storeMiniToolConsumption(task.id, step.id, known, tx);
    await mirrorMiniToolExecutionConsumption(task, known, tx);
    if (!await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) {
      throw new Error("Mini-tool settlement lease expired before cost confirmation");
    }
    return known;
  });
}
