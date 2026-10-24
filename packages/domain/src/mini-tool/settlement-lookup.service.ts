// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, getMiniToolsConfig } from "@breatic/core";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import {
  miniToolConsumptionRecordSchema, miniToolSettlementClaimSchema, miniToolSettlementSchema,
  type MiniToolConsumptionRecord, type MiniToolSettlementClaim,
} from "@domain/mini-tool/consumption.types.js";

const claimInputSchema = z.strictObject({ taskId: z.string().uuid(), settlementVersion: z.number().int().nonnegative() });
const deferInputSchema = z.strictObject({ taskId: z.string().uuid(), claim: miniToolSettlementClaimSchema, lastError: z.string() });

/** Committed lookup ownership and one original expense, never a replacement quote. */
export interface ClaimedMiniToolSettlement {
  taskId: string;
  claim: MiniToolSettlementClaim;
  leaseUntil: string;
  parent: { status: string; consumptionSetComplete: boolean };
  nextConsumption: { stepId: string; consumption: MiniToolConsumptionRecord } | null;
}

/**
 * Claim one due SQL cycle before any upstream query occurs.
 * @param input - The immutable task and the wake message's original version.
 * @returns Committed ownership, or null for an ignored wake or recovered expired cycle.
 * @throws {Error} When validated persistence or a database operation fails.
 */
export async function claimMiniToolSettlement(input: z.infer<typeof claimInputSchema>): Promise<ClaimedMiniToolSettlement | null> {
  const request = claimInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolConsumptionTask(request.taskId, tx);
    if (!task || task.source !== "mini_tool" || task.billedAt !== null) return null;
    const parsed = miniToolSettlementSchema.safeParse(task.result.settlement);
    if (!parsed.success) return null;
    const previous = parsed.data;
    if (previous.version !== request.settlementVersion || previous.state === "idle" || previous.state === "settled") return null;
    const clock = await taskRepo.miniToolSettlementClock(task.id, getMiniToolsConfig().settlement, tx);
    if (previous.state === "checking") {
      if (!clock.leaseExpired) return null;
      await taskRepo.storeMiniToolSettlement(task.id, {
        ...previous, version: previous.version + 1, state: "waiting", nextAttemptAt: clock.now,
        leaseToken: null, leaseUntil: null, lastError: "lease-expired",
      }, tx);
      return null;
    }
    if (!clock.waitingDue) return null;
    const steps = await upstreamStepRepo.listSteps(task.id, tx);
    let nextConsumption: ClaimedMiniToolSettlement["nextConsumption"] = null;
    for (const step of steps) {
      if (step.output.miniToolConsumption === undefined) continue;
      const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
      if (consumption.state !== "recorded") {
        nextConsumption = { stepId: step.id, consumption };
        break;
      }
    }
    const leaseToken = randomUUID();
    await taskRepo.storeMiniToolSettlement(task.id, {
      ...previous, state: "checking", leaseToken, leaseUntil: clock.leaseUntil,
    }, tx);
    return {
      taskId: task.id, claim: { version: previous.version, leaseToken }, leaseUntil: clock.leaseUntil,
      parent: { status: task.status, consumptionSetComplete: previous.consumptionSetComplete === true }, nextConsumption,
    };
  });
}

/**
 * Persist a new retry cycle when the current lookup still lacks a cost or failed.
 * @param input - The original lease and a diagnostic for its pending result.
 * @returns Whether this still-current owner committed the retry.
 * @throws {Error} When validation or persistence fails.
 */
export async function deferMiniToolSettlement(input: z.infer<typeof deferInputSchema>): Promise<boolean> {
  const request = deferInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const task = await taskRepo.lockMiniToolConsumptionTask(request.taskId, tx);
    if (!task || task.source !== "mini_tool" || task.billedAt !== null) return false;
    if (!await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) return false;
    const previous = miniToolSettlementSchema.parse(task.result.settlement);
    const clock = await taskRepo.miniToolSettlementClock(task.id, getMiniToolsConfig().settlement, tx);
    await taskRepo.storeMiniToolSettlement(task.id, {
      ...previous, version: previous.version + 1, state: "waiting", nextAttemptAt: clock.retryAt,
      leaseToken: null, leaseUntil: null, lastError: request.lastError,
    }, tx);
    return true;
  });
}
