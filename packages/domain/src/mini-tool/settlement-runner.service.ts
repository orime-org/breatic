// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { miniToolPlanJobRequestSchema } from "@breatic/shared";
import type { MiniToolSettlementWake } from "@breatic/core";
import { miniToolConsumptionLookupSchema, type DueMiniToolSettlement, type MiniToolConsumptionLookup, type MiniToolConsumptionLookupInput } from "@domain/mini-tool/consumption.types.js";
import { settleMiniToolCharge, type MiniToolChargeResult } from "@domain/mini-tool/settlement.service.js";
import { claimMiniToolSettlement, deferMiniToolSettlement } from "@domain/mini-tool/settlement-lookup.service.js";
import { confirmMiniToolConsumption, recordMiniToolConsumption } from "@domain/mini-tool/consumption.service.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";

/** A committed cycle's current wake, independent charge result and application diagnostic. */
export interface MiniToolSettlementRunResult {
  nextWake: DueMiniToolSettlement | null;
  charge: MiniToolChargeResult | null;
  failure?: unknown;
}

/** One external read outside any SQL transaction, supplied by the worker application. */
export type MiniToolSettlementLookup = (input: MiniToolConsumptionLookupInput) => Promise<MiniToolConsumptionLookup>;
/** Queue delivery carries only the original task and current SQL cycle. */
export type { MiniToolSettlementWake } from "@breatic/core";

/**
 * Resume one durable expense or final charge under its own committed SQL lease.
 * @param input - The wake's immutable task and settlement version.
 * @param lookup - Original-identity lookup, with no ability to submit media work.
 * @returns The next current waiting identity and any independently committed charge.
 * @throws {Error} When validation or persistence prevents durable recovery.
 */
export async function runMiniToolSettlement(input: MiniToolSettlementWake, lookup: MiniToolSettlementLookup): Promise<MiniToolSettlementRunResult> {
  const owned = await claimMiniToolSettlement(input);
  let charge: MiniToolChargeResult | null = null;
  let failed = false;
  let failure: unknown;
  if (owned !== null) {
    try {
      const next = owned.nextConsumption;
      if (next === null) {
        charge = await settleMiniToolCharge(input.taskId);
        if (charge.state === "pending") await deferMiniToolSettlement({ taskId: input.taskId, claim: owned.claim, lastError: "parent-consumption-incomplete" });
      } else {
        const scope = { taskId: input.taskId, stepId: next.stepId, identity: next.consumption.identity, claim: owned.claim };
        let canRecord = next.consumption.state === "known";
        if (next.consumption.state === "pending") {
          const request: MiniToolConsumptionLookupInput = { consumption: next.consumption };
          if (next.consumption.identity.kind === "container") {
            const step = (await upstreamStepRepo.listSteps(input.taskId)).find((candidate) => candidate.id === next.stepId);
            request.plan = miniToolPlanJobRequestSchema.parse(step?.output.miniToolPlanJob);
          }
          // claimMiniToolSettlement committed its own short transaction before this external read.
          const answer = miniToolConsumptionLookupSchema.parse(await lookup(request));
          if (answer.state === "pending") {
            await deferMiniToolSettlement({ taskId: input.taskId, claim: owned.claim, lastError: answer.reason });
          } else {
            await confirmMiniToolConsumption({ ...scope, costUsd: answer.costUsd, costSource: answer.costSource, raw: answer.raw });
            canRecord = true;
          }
        }
        if (canRecord) await recordMiniToolConsumption(scope);
      }
    } catch (err) {
      failed = true; failure = err;
      try {
        await deferMiniToolSettlement({ taskId: input.taskId, claim: owned.claim, lastError: err instanceof Error ? err.message : String(err) });
      } catch (deferError) {
        throw new AggregateError([err, deferError], "Mini-tool expense recovery could not persist its retry");
      }
    }
  }
  return { charge, nextWake: await taskRepo.waitingMiniToolSettlement(input.taskId), ...(failed ? { failure } : {}) };
}
