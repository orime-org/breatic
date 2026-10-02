// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Stores one subscription as Stripe described it, and settles the tier that
 * follows (#307 §5.4).
 *
 * Every path that learns something from Stripe ends here: the webhook, the
 * checkout return, the panel's own cancel / resume / plan change, and the
 * re-check before selling a second subscription. Only the part inside the
 * transaction is shared. Opening the transaction, claiming a webhook event,
 * the bell notice and the email after commit stay with each caller, because
 * each owes them to a different party.
 */

import {
  listSubscriptions,
  lockAccountRow,
  subscriptionClock,
  subscriptionSituation,
  tierForSituation,
  upsertSubscription,
} from "@breatic/core";
import type { DbTx, SubscriptionWrite } from "@breatic/core";
import type { MembershipTier } from "@breatic/shared";
import { settleTier } from "@server/modules/subscription/settle-tier.js";

/** What storing a subscription did to the account. */
export interface AppliedSubscription {
  /** The tier now in force. */
  readonly tier: MembershipTier;
  /** The paid tier that ended, when this ended one and an email is owed. */
  readonly endedFrom: MembershipTier | null;
}

/**
 * Stores one subscription snapshot and settles the account's tier.
 *
 * The account's row is locked first, so two writers for one account apply in
 * turn; which snapshot wins is decided by its `observedAt`, not by who holds
 * the lock (`upsertSubscription`).
 * @param input - What to store, and where.
 * @param input.userId - The account the subscription belongs to.
 * @param input.write - The snapshot, already read from Stripe.
 * @param input.referenceId - Identifies this change in the tier ledger.
 * @param input.tx - The caller's transaction.
 * @returns The tier now in force, and whether an email is owed.
 * @throws {Error} if the account does not exist or a write fails.
 */
export async function applySubscriptionWrite(input: {
  userId: string;
  write: SubscriptionWrite;
  referenceId: string;
  tx: DbTx;
}): Promise<AppliedSubscription> {
  const { userId, write, referenceId, tx } = input;
  await lockAccountRow(userId, tx);
  await upsertSubscription(write, tx);

  const reading = subscriptionSituation(
    await listSubscriptions(userId, tx),
    subscriptionClock(),
  );
  const tier = tierForSituation(reading.situation, reading.record);
  const settled = await settleTier({ userId, toTier: tier, referenceId, tx });
  return { tier, endedFrom: settled.endedFrom };
}
