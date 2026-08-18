// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What to do when Stripe tells us a subscription changed (task #106, §8).
 *
 * Three decisions shape this file.
 *
 * **The event payload is not read for state.** Stripe redelivers and can
 * deliver out of order, and the payload is a snapshot from whenever the event
 * was made. So an event is treated as a nudge: we ask Stripe what the
 * subscription looks like NOW and write that. A late event then asks the same
 * question as the newer one and cannot put an old status back.
 *
 * **Idempotency is the event id's primary key, not a comparison of tiers.**
 * `changeMembershipTier` converges on the last call and cannot tell a
 * redelivery from a new event; the insert into `stripe_webhook_events` can,
 * and it shares the transaction with everything the event does.
 *
 * **The account row is locked before Stripe is asked.** Two events for one
 * account would otherwise each fetch the current state and the one that
 * commits last might be holding the older answer.
 */

import type Stripe from "stripe";
import {
  db,
  listSubscriptions,
  lockAccountRow,
  subscriptionSituation,
  tierForSituation,
  upsertSubscription,
} from "@breatic/core";
import type { DbTx, StoredSubscription } from "@breatic/core";
import type { MembershipTier } from "@breatic/shared";
import { getStripeClient } from "@server/infra/stripe.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";
import { claimWebhookEvent } from "@server/modules/subscription/webhook-events.repo.js";
import {
  settleTier,
  sendMembershipEndedMail,
} from "@server/modules/subscription/settle-tier.js";

/** What handling one event came to. */
export type SubscriptionEventOutcome =
  | { status: "ignored"; reason: string }
  | { status: "replay"; userId: string }
  | { status: "applied"; userId: string; tier: MembershipTier };

/**
 * The event types that say something about a subscription's state.
 *
 * `checkout.session.completed` is deliberately absent: it says the checkout
 * flow finished, which is not the same as the subscription being paid for —
 * at that moment it may still be `incomplete`.
 */
const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
]);

/**
 * Thrown to abandon the transaction when the subscription sells a price this
 * deployment does not know.
 *
 * Rolling back matters: it leaves the event unmarked, so an operator who adds
 * the price to the config can redeliver it from the Stripe dashboard. Marking
 * it handled would drop that subscription for good.
 */
class UnknownPriceError extends Error {}

/**
 * Reads which account a subscription belongs to.
 *
 * Two lines, checked in this order. The metadata is ours, written onto the
 * subscription at checkout precisely because subscription events carry nothing
 * else of ours. The customer is the join we maintain, and is what covers a
 * subscription created outside our checkout.
 * @param subscription - The subscription named by the event.
 * @returns The account id, or null when nothing here claims it.
 */
async function resolveUserId(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const fromMetadata = subscription.metadata?.["userId"];
  if (fromMetadata) return fromMetadata;

  const customer = subscription.customer;
  const customerId = typeof customer === "string" ? customer : customer?.id;
  if (!customerId) return null;
  return userRepo.findUserIdByStripeCustomerId(customerId);
}

/**
 * Writes what Stripe currently says, and settles the tier that follows.
 * @param event - The event that prompted this.
 * @param userId - The account it belongs to.
 * @param tx - The transaction it all shares.
 * @returns The tier now in force, and whether an email is owed.
 * @throws {UnknownPriceError} if the subscription sells a price we do not know.
 */
async function applyCurrentState(
  event: Stripe.Event,
  userId: string,
  tx: DbTx,
): Promise<{ tier: MembershipTier; endedFrom: MembershipTier | null }> {
  const named = event.data.object as Stripe.Subscription;
  const before = (await listSubscriptions(userId, tx)).find(
    (row) => row.stripeSubscriptionId === named.id,
  );

  const fresh = await getStripeClient().subscriptions.retrieve(named.id, {
    expand: ["latest_invoice"],
  });
  const write = readStripeSubscription(fresh, userId);
  if (!write) throw new UnknownPriceError(named.id);
  await upsertSubscription(write, tx);

  await notifyIfUpgradeLapsed(event, userId, before, tx);

  const reading = subscriptionSituation(await listSubscriptions(userId, tx));
  const tier = tierForSituation(reading.situation, reading.record);
  const settled = await settleTier({
    userId,
    toTier: tier,
    reason: tier === "base" ? "subscription_ended" : "subscription_activated",
    referenceId: event.id,
    tx,
  });
  return { tier, endedFrom: settled.endedFrom };
}

/**
 * Tells the account when a priced upgrade was discarded unpaid.
 *
 * Which tier it was for can only come from the row as it stood BEFORE this
 * write: by the time Stripe reports the expiry, the pending update is gone
 * from the subscription.
 * @param event - The event being handled.
 * @param userId - The account.
 * @param before - The stored row before this event was applied.
 * @param tx - The shared transaction.
 */
async function notifyIfUpgradeLapsed(
  event: Stripe.Event,
  userId: string,
  before: StoredSubscription | undefined,
  tx: DbTx,
): Promise<void> {
  if (event.type !== "customer.subscription.pending_update_expired") return;
  if (!before?.pendingTier) return;
  await notificationService.createMembershipUpgradeIncomplete({
    userId,
    payload: { toTier: before.pendingTier },
    tx,
  });
}

/**
 * Handles one Stripe subscription event.
 *
 * Answers rather than throws for everything that is simply not ours to act on,
 * so the route can return 200: an event Stripe keeps redelivering because we
 * answered 500 is worse than one we deliberately skipped.
 * @param event - The verified Stripe event.
 * @returns What handling it came to, for the route to log.
 * @throws {Error} if the database or Stripe fails, which must reach the route
 *   so that Stripe redelivers.
 */
export async function handleSubscriptionEvent(
  event: Stripe.Event,
): Promise<SubscriptionEventOutcome> {
  if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
    return { status: "ignored", reason: "not a subscription event" };
  }

  const subscription = event.data.object as Stripe.Subscription;
  const userId = await resolveUserId(subscription);
  if (!userId) {
    return { status: "ignored", reason: "no account claims this customer" };
  }

  let outcome: SubscriptionEventOutcome = {
    status: "replay",
    userId,
  };
  let endedFrom: MembershipTier | null = null;

  try {
    await db.transaction(async (tx) => {
      if (!(await claimWebhookEvent(event.id, event.type, tx))) return;
      // Before asking Stripe, not after: the answer must not be older than the
      // moment this handler took its turn.
      await lockAccountRow(userId, tx);
      const applied = await applyCurrentState(event, userId, tx);
      endedFrom = applied.endedFrom;
      outcome = { status: "applied", userId, tier: applied.tier };
    });
  } catch (err) {
    if (!(err instanceof UnknownPriceError)) throw err;
    return {
      status: "ignored",
      reason: `subscription ${err.message} sells a price this deployment does not know`,
    };
  }

  // After the commit, never inside it: an email about a change that then rolls
  // back cannot be recalled, and a send failure must not fail the webhook.
  if (endedFrom) await sendMembershipEndedMail(userId, endedFrom);

  return outcome;
}
