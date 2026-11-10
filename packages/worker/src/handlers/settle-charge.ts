// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Settle a charge request and log what on-call needs from it (inner#1617).
 * Every worker path that settles a recorded request by id goes through here:
 * a completed task, a Timeline execution and the sweep. A looked-up model call
 * settles through `chargeOnce` and logs on its own.
 */

import { logger } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { parseCreditDecimal } from "@breatic/shared";

/** What every line about a stuck charge carries: who is charged, how much, and what the delivery was. */
export type SettleLogContext = { userId: string; amount: number | string } & Record<string, unknown>;

/**
 * Settle a request; never throws. A settlement that fails is already counted
 * on the request by the credit engine and stays pending for the sweep.
 * @param requestId - The request.
 * @param context - Who and what the charge is for, logged with every line.
 */
export async function settleChargeLogged(requestId: string, context: SettleLogContext): Promise<void> {
  try {
    const outcome = await creditLotService.settleCharge(requestId);
    if (outcome === null) return;
    if (parseCreditDecimal(outcome.shortfall) > 0n) {
      // The studio's pool ran out, or its credits were reassigned while the
      // work ran. The result is already delivered, so what is left uncharged
      // goes to reconciliation.
      logger.error(
        { ...context, requestId, studioId: outcome.studioId, charged: outcome.charged, shortfall: outcome.shortfall },
        "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
      );
    }
    if (outcome.signalFailure) {
      logger.error({ ...context, err: outcome.signalFailure, requestId }, "credits_signal_failed");
    }
  } catch (err) {
    logger.error({ ...context, err, requestId }, "credit_charge_settle_failed");
  }
}
