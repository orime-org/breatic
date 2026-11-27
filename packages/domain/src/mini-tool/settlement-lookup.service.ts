// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, getMiniToolsConfig, miniToolSettlementWakeSchema, miniToolSettlementDiscoverySchema } from "@breatic/core";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import {
  miniToolConsumptionRecordSchema, miniToolSettlementClaimSchema, miniToolSettlementSchema,
  type MiniToolConsumptionRecord, type MiniToolSettlementClaim,
  type DueMiniToolSettlementPage,
} from "@domain/mini-tool/consumption.types.js";
import { nextSettlementDue } from "@domain/mini-tool/consumption-due.js";

const claimInputSchema = miniToolSettlementWakeSchema;
const deferInputSchema = z.strictObject({ taskId: z.string().uuid(), claim: miniToolSettlementClaimSchema, lastError: z.string() });
const discoveryInputSchema = miniToolSettlementDiscoverySchema.extend({
  limit: z.number().int().positive().refine((limit) => Number.isSafeInteger(limit + 1)),
});

/**
 * Find durable periods missed by queue delivery, process restarts or expired leases.
 * @param input - A page size and the preceding unchanged SQL cursor.
 * @returns Due identities without claiming, querying upstream or modifying computation.
 * @throws {Error} When input validation or the database read fails.
 */
export async function listDueMiniToolSettlements(input: z.infer<typeof discoveryInputSchema>): Promise<DueMiniToolSettlementPage> {
  const request = discoveryInputSchema.parse(input);
  return taskRepo.listDueMiniToolSettlements(request.limit, request.cursor);
}

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
    // The first unrecorded item, in step order.
    let nextConsumption: ClaimedMiniToolSettlement["nextConsumption"] = null;
    for (const step of steps) {
      if (step.output.miniToolConsumption === undefined) continue;
      const consumption = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
      if (consumption.state === "recorded") continue;
      nextConsumption = { stepId: step.id, consumption };
      break;
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
    // Every unrecorded consumption retries after the configured delay.
    const due = nextSettlementDue(await upstreamStepRepo.listSteps(task.id, tx), Date.parse(clock.retryAt)).at;
    await taskRepo.storeMiniToolSettlement(task.id, {
      ...previous, version: previous.version + 1, state: "waiting", nextAttemptAt: due === null ? clock.retryAt : new Date(due).toISOString(),
      leaseToken: null, leaseUntil: null, lastError: request.lastError,
    }, tx);
    return true;
  });
}
