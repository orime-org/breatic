// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sends an account's pending referral binding before anything that depends
 * on it (inner#1993 §8.4): a membership checkout reads the binding for its
 * first-period discount, and a later binding must meet the first one already
 * decided.
 */

import { commerceOutboxRepo, db, logger } from "@breatic/core";
import { billingUnavailable } from "@server/modules/commerce/commerce-client.js";
import { deliverRow } from "@server/modules/commerce/commerce-relay.js";

/**
 * Deliver the account's unsent referral binding now, if it has one.
 * @param userId - The account.
 * @returns Once the binding is decided, given up or there was none.
 * @throws {UnavailableError} When the billing service cannot take it yet; the row stays for the relay.
 */
export async function flushReferralBinding(userId: string): Promise<void> {
  const outcome = await db.transaction(async (tx) => {
    const row = await commerceOutboxRepo.lockUnsentReferralBinding(userId, tx);
    return row === null ? null : deliverRow(row, tx);
  });
  if (outcome === null || outcome.error === undefined) return;
  if (outcome.deadLettered === true) {
    logger.error({ err: outcome.error, userId, outboxId: outcome.id }, "commerce_outbox_dead_lettered");
    return;
  }
  throw billingUnavailable();
}
