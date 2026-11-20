// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stores one subscription as the billing service read it from Stripe, and
 * settles the tier that follows (#307 §5.4).
 *
 * The billing service's subscription-facts delivery is its caller; opening
 * the transaction, the bell notices, and the email and report after commit
 * stay with that caller.
 */

import {
  listSubscriptions,
  lockAccountRow,
  subscriptionClock,
  subscriptionSituation,
  tierForSituation,
  recordFirstActive,
  upsertSubscription,
} from "@breatic/core";
import type { DbTx, SubscriptionWrite } from "@breatic/core";
import type { MembershipTier } from "@breatic/shared";
import { settleTier } from "@server/modules/account/settle-tier.js";

/** What storing a subscription did to the account. */
export interface AppliedSubscription {
  /** The tier now in force. */
  readonly tier: MembershipTier;
  /** The paid tier that ended, when this ended one and an email is owed. */
  readonly endedFrom: MembershipTier | null;
  /** This write was the subscription's first activation; a start is reported after commit. */
  readonly started: boolean;
}

/**
 * Stores one subscription snapshot and settles the account's tier.
 *
 * The account's row is locked first, so two writers for one account apply in
 * turn; which snapshot wins is decided by its `observedAt`, not by who holds
 * the lock (`upsertSubscription`).
 * @param input - What to store, and where.
 * @param input.userId - The account the subscription belongs to.
 * @param input.write - The snapshot the billing service read from Stripe.
 * @param input.referenceId - Identifies this change in the tier ledger.
 * @param input.firstActiveAt - When the subscription was first paid for, or null while it never was.
 * @param input.tx - The caller's transaction.
 * @returns The tier now in force, whether an email is owed, and whether this
 *   write was the subscription's first activation.
 * @throws {Error} if the account does not exist or a write fails.
 */
export async function applySubscriptionWrite(input: {
  userId: string;
  write: SubscriptionWrite;
  referenceId: string;
  firstActiveAt: Date | null;
  tx: DbTx;
}): Promise<AppliedSubscription> {
  const { userId, write, referenceId, tx } = input;
  await lockAccountRow(userId, tx);
  await upsertSubscription(tx, write);
  const started = await recordFirstActive(write.stripeSubscriptionId, input.firstActiveAt, tx);

  const reading = subscriptionSituation(
    await listSubscriptions(tx, userId),
    subscriptionClock(),
  );
  const tier = tierForSituation(reading.situation, reading.record);
  const settled = await settleTier({ userId, toTier: tier, referenceId, tx });
  return { tier, endedFrom: settled.endedFrom, started };
}
