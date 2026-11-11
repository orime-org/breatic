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

import { getWorkerConfig } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { settleChargeLogged } from "@worker/handlers/settle-charge.js";

/**
 * One round of the sweep.
 * @returns Once every listed request has been tried.
 */
export async function sweepCreditCharges(): Promise<void> {
  const { min_age_ms, batch_size } = getWorkerConfig().credit_charge_sweep;
  const requests = await creditLotService.listSweepableChargeRequests(min_age_ms, batch_size);
  for (const request of requests) {
    await settleChargeLogged(request.id, {
      kind: request.kind,
      referenceId: request.referenceId,
      userId: request.actorUserId,
      amount: request.amount,
      attempts: request.attempts,
    });
  }
}
