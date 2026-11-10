// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Settle charge requests left pending (inner#1617): a settlement that failed,
 * or a process that died between recording a delivery and settling its charge.
 *
 * One round takes the requests left alone longest, settles them one at a time
 * and goes on past any that fails; a failure is counted on the row, which moves
 * it to the back of the next round.
 */

import { getWorkerConfig, logger } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { parseCreditDecimal } from "@breatic/shared";

/**
 * One round of the sweep.
 * @returns Once every listed request has been tried.
 */
export async function sweepCreditCharges(): Promise<void> {
  const { min_age_ms, batch_size } = getWorkerConfig().credit_charge_sweep;
  const requestIds = await creditLotService.listSweepableChargeRequests(min_age_ms, batch_size);
  for (const requestId of requestIds) {
    try {
      const outcome = await creditLotService.settleCharge(requestId);
      if (outcome === null) continue;
      if (parseCreditDecimal(outcome.shortfall) > 0n) {
        logger.error(
          { requestId, studioId: outcome.studioId, charged: outcome.charged, shortfall: outcome.shortfall },
          "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
        );
      }
      if (outcome.signalFailure) {
        logger.error({ err: outcome.signalFailure, requestId }, "credits_signal_failed");
      }
    } catch (err) {
      await creditLotService.recordSettleFailure(requestId, err).catch((recordErr: unknown) =>
        logger.error({ err: recordErr, requestId }, "credit_charge_failure_record_failed"),
      );
      logger.error({ err, requestId }, "credit_charge_settle_failed");
    }
  }
}
