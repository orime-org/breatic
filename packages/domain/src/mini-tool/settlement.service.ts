// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { db, publishCreditsChanged } from "@breatic/core";
import { toChargeCredits } from "@domain/credit/credit-math.js";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import { requestCharge, settleCharge, type ChargeOutcome } from "@domain/credit/creditLot.service.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as upstreamStepRepo from "@domain/task/upstreamStep.repo.js";
import { miniToolConsumptionRecordSchema, miniToolSettlementSchema } from "@domain/mini-tool/consumption.types.js";

/** Whether a parent's complete expense has committed to its credit ledger. */
export type MiniToolChargeResult =
  | { state: "pending" }
  | { state: "settled"; credits: number; first: boolean; chargeOutcome?: ChargeOutcome; chargeFailure?: unknown; signalFailure?: unknown };

/** A committed outcome and the Project whose readers may now refresh it. */
interface ChargeDecision { result: MiniToolChargeResult; projectId: string | null; requestId: string | null }

/**
 * Settles only a terminal parent whose actual consumption set is complete.
 * @param taskId - The immutable task identity; callers cannot supply a replacement amount.
 * The charge is recorded as a request in the transaction that claims the billing guard and
 * settled after the commit; a settlement that fails stays pending for the credit-charge sweep.
 * @returns The fixed committed amount, or pending while computation or actual costs are incomplete.
 * @throws {Error} When persistent facts are inconsistent or any financial write fails.
 */
export async function settleMiniToolCharge(taskId: string): Promise<MiniToolChargeResult> {
  const decision = await db.transaction(async (tx): Promise<ChargeDecision> => {
    const task = await taskRepo.lockMiniToolConsumptionTask(taskId, tx);
    if (!task || task.source !== "mini_tool") throw new Error("Mini-tool charge has no owning task");
    if (task.billedAt !== null) {
      if (task.billedCredits === null || !Number.isFinite(task.billedCredits) || task.billedCredits < 0) {
        throw new Error("Claimed mini-tool charge has no fixed valid amount");
      }
      return { result: { state: "settled", credits: task.billedCredits, first: false }, projectId: task.projectId, requestId: null };
    }
    const settlement = miniToolSettlementSchema.parse(task.result.settlement);
    if ((task.status !== "completed" && task.status !== "failed") || settlement.consumptionSetComplete !== true) {
      return { result: { state: "pending" }, projectId: task.projectId, requestId: null };
    }
    const steps = await upstreamStepRepo.listSteps(taskId, tx);
    const consumptions = steps.flatMap((step) => step.output.miniToolConsumption === undefined
      ? [] : [miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption)]);
    if (consumptions.some((consumption) => consumption.state !== "recorded")) {
      return { result: { state: "pending" }, projectId: task.projectId, requestId: null };
    }
    // Usage rows have a fixed SQL scale; the frozen step amounts retain the
    // original expense precision until this one parent-level cent rounding.
    const credits = toChargeCredits(consumptions.reduce((total, consumption) => total + consumption.credits!, 0));
    const claimed = await taskRepo.claimMiniToolCharge(taskId, credits, tx);
    if (!claimed) throw new Error("Mini-tool billing guard changed while its task lock was held");
    let requestId: string | null = null;
    if (credits > 0) {
      requestId = await requestCharge({
        kind: "task", projectId: task.projectId, actorUserId: task.userId, amount: credits,
        referenceId: taskId, releaseHold: taskId, description: "Video mini-tool",
        model: task.model ?? undefined,
        provider: "cloudflare",
      }, tx);
      if (requestId === null) throw new Error("Mini-tool charge request already exists for a task whose billing guard was open");
    } else {
      await creditHoldRepo.releaseHold(taskId, tx);
    }
    await taskRepo.storeMiniToolSettlement(taskId, {
      ...settlement, version: settlement.version + 1, state: "settled",
      pendingConsumptionKeys: [], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null,
    }, tx);
    return { result: { state: "settled", credits, first: true }, projectId: task.projectId, requestId };
  });
  if (decision.result.state !== "settled" || !decision.result.first) return decision.result;
  if (decision.requestId !== null) {
    // settleCharge tells the Project's users itself once the charge commits.
    try {
      const chargeOutcome = await settleCharge(decision.requestId);
      return chargeOutcome === null ? decision.result : { ...decision.result, chargeOutcome };
    } catch (chargeFailure) {
      return { ...decision.result, chargeFailure };
    }
  }
  if (decision.projectId === null) return decision.result;
  try {
    await publishCreditsChanged(decision.projectId);
    return decision.result;
  } catch (signalFailure) {
    return { ...decision.result, signalFailure };
  }
}
