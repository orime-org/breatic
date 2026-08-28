// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * **Stripe is asked BEFORE the account row is locked.** The other order —
 * lock, then fetch — holds one row and one database connection for however
 * long Stripe takes, and the row it holds is the one every tier change needs.
 * Which of two concurrent writers wins is settled instead by the moment each
 * one asked (`observed_at`, migration 0058), so the later view wins whichever
 * commits first.
 */

import type Stripe from "stripe";
import {
  db,
  findSubscribableTierByPriceId,
  getStripeCallTimeoutMs,
  listSubscriptions,
  lockAccountRow,
  subscriptionSituation,
  tierForSituation,
  upsertSubscription,
} from "@breatic/core";
import type { DbTx, SubscriptionWrite } from "@breatic/core";
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

/**
 * What handling one event came to.
 *
 * `notMine` and `noop` are different answers to different questions, and
 * collapsing them is what sent every subscription checkout to the credit-pack
 * handler: that one looks for a `payments` row, a subscription checkout never
 * writes one, and the webhook answered 404 to a payment that had succeeded.
 * `notMine` means "keep looking"; the other four all mean "this was mine,
 * answer 200".
 *
 * `acknowledged` and `noop` are likewise not the same answer. Every
 * successful membership checkout produces exactly one `acknowledged` — it is
 * the most common thing this handler says, and nothing is wrong when it does.
 * A `noop` is the opposite: somebody paid and we could not tell whose account
 * it was, or for what. Sharing one status between them is what put the normal
 * path in the warning log.
 */
export type SubscriptionEventOutcome =
  | { status: "notMine" }
  | { status: "acknowledged"; reason: string }
  | { status: "noop"; reason: string }
  | { status: "replay"; userId: string }
  | { status: "applied"; userId: string; tier: MembershipTier };

/**
 * The event types that say something about a subscription's state.
 *
 * `checkout.session.completed` is absent here but still claimed below when its
 * session is a subscription one: it says the checkout flow finished, which is
 * not the same as the subscription being paid for — at that moment it may
 * still be `incomplete` — so there is nothing to do with it, and the state
 * arrives through `customer.subscription.*` instead.
 */
const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
]);

/**
 * The Checkout Session events both legs receive.
 *
 * Every one of these arrives for a membership checkout and for a credit-pack
 * checkout alike, and nothing but the session's `mode` separates them. A
 * membership event that falls through to the credit leg looks up a `payments`
 * row that was never written: the failure branch answers the webhook 404, and
 * Stripe redelivers a 404 for three days.
 */
const SHARED_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

/**
 * Whether an event belongs to the membership leg at all.
 *
 * Two questions, in order. Some types are this leg's alone. The rest are the
 * shared Checkout Session ones, where the session's `mode` decides.
 * @param event - The verified Stripe event.
 * @returns Whether this leg is the one that should answer for it.
 */
function claimsEvent(event: Stripe.Event): boolean {
  if (SUBSCRIPTION_EVENT_TYPES.has(event.type)) return true;
  if (!SHARED_SESSION_EVENT_TYPES.has(event.type)) return false;
  // Narrowed by the check above: on all four of those types the SDK types the
  // object as a Checkout Session.
  const session = event.data.object as Stripe.Checkout.Session;
  return session.mode === "subscription";
}

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

  const customerId = customerIdOf(subscription);
  if (!customerId) return null;
  return userRepo.findUserIdByStripeCustomerId(customerId);
}

/**
 * Reads the Stripe customer a subscription names, expanded or not.
 * @param subscription - The subscription.
 * @returns Its customer id, or null when none is named.
 */
function customerIdOf(subscription: Stripe.Subscription): string | null {
  const customer = subscription.customer;
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * Writes what Stripe currently says, and settles the tier that follows.
 * @param event - The event that prompted this.
 * @param userId - The account it belongs to.
 * @param write - What Stripe said, already fetched outside the transaction.
 * @param tx - The transaction it all shares.
 * @returns The tier now in force, and whether an email is owed.
 */
async function applyCurrentState(
  event: Stripe.Event,
  userId: string,
  write: SubscriptionWrite,
  tx: DbTx,
): Promise<{ tier: MembershipTier; endedFrom: MembershipTier | null }> {
  await upsertSubscription(write, tx);
  await notifyIfUpgradeLapsed(event, userId, tx);

  const reading = subscriptionSituation(await listSubscriptions(userId, tx));
  const tier = tierForSituation(reading.situation, reading.record);
  const settled = await settleTier({
    userId,
    toTier: tier,
    referenceId: event.id,
    tx,
  });
  return { tier, endedFrom: settled.endedFrom };
}

/**
 * Tells the account when a priced upgrade was discarded unpaid.
 *
 * Which tier it was for comes from the EVENT, not from the stored row. The
 * event is Stripe's own record of the update that lapsed and carries the items
 * it would have applied; the stored row is a shared piece of state that the
 * reconciliation or a sibling event may already have cleared, and reading it
 * would make the notice vanish exactly when something else got there first.
 * @param event - The event being handled.
 * @param userId - The account.
 * @param tx - The shared transaction.
 */
async function notifyIfUpgradeLapsed(
  event: Stripe.Event,
  userId: string,
  tx: DbTx,
): Promise<void> {
  if (event.type !== "customer.subscription.pending_update_expired") return;

  // Narrowed by the check above: on this event type the SDK already types the
  // object as a subscription.
  const priceId = priceIdOfPendingUpdate(event.data.object);
  const toTier = priceId ? findSubscribableTierByPriceId(priceId) : null;
  if (!toTier) return;

  await notificationService.createMembershipUpgradeIncomplete({
    userId,
    payload: { toTier },
    tx,
  });
}

/**
 * Reads which price a lapsed pending update would have applied.
 * @param subscription - The subscription as the event carried it.
 * @returns That price id, or null when the event carries no pending update.
 */
function priceIdOfPendingUpdate(
  subscription: Stripe.Subscription,
): string | null {
  const item = subscription.pending_update?.subscription_items?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
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
  if (!claimsEvent(event)) return { status: "notMine" };

  if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
    // One of the shared Checkout Session events, on a subscription session:
    // it finished, its delayed payment landed or failed, or it was abandoned.
    // Claimed so the credit-pack handler never sees it, and answered with
    // nothing to do — what the subscription becomes arrives separately as
    // `customer.subscription.*`, and an abandoned checkout leaves none.
    return {
      status: "acknowledged",
      reason: "a subscription checkout event; its state arrives separately",
    };
  }

  const subscription = event.data.object as Stripe.Subscription;
  const userId = await resolveUserId(subscription);
  if (!userId) {
    return {
      status: "noop",
      reason: `no account claims Stripe customer ${customerIdOf(subscription) ?? "(none named)"}`,
    };
  }

  // Asked BEFORE the transaction opens. Holding the account's row across a
  // network call would keep one database connection and one row — the row
  // every tier change needs — for as long as Stripe takes to answer, which its
  // SDK allows to be minutes. Which of two concurrent writers wins is settled
  // by the snapshot each one is holding, not by who is holding the lock.
  const observedAt = new Date();
  const fresh = await getStripeClient().subscriptions.retrieve(
    subscription.id,
    { expand: ["latest_invoice"] },
    // Bounded and not retried, the same as the panel's reconciliation. The
    // SDK's default is 80 seconds twice retried, and this handler has to
    // answer before Stripe decides the delivery failed — after which it is
    // holding a request nobody is waiting for while a redelivery is already
    // queued. The SDK's own two retries fire about half a second and a second
    // after the timeout, which does nothing for a Stripe that is genuinely
    // slow; Stripe's three days of redelivery is the recovery that works.
    {
      timeout: getStripeCallTimeoutMs(),
      maxNetworkRetries: 0,
    },
  );
  const write = readStripeSubscription(fresh, userId, observedAt);
  if (!write) {
    return {
      status: "noop",
      reason: `subscription ${subscription.id} sells a price this deployment does not know`,
    };
  }

  let outcome: SubscriptionEventOutcome = {
    status: "replay",
    userId,
  };
  let endedFrom: MembershipTier | null = null;

  await db.transaction(async (tx) => {
    if (!(await claimWebhookEvent(event.id, event.type, tx))) return;
    await lockAccountRow(userId, tx);
    const applied = await applyCurrentState(event, userId, write, tx);
    endedFrom = applied.endedFrom;
    outcome = { status: "applied", userId, tier: applied.tier };
  });

  // After the commit, never inside it: an email about a change that then rolls
  // back cannot be recalled, and a send failure must not fail the webhook.
  if (endedFrom) await sendMembershipEndedMail(userId, endedFrom);

  return outcome;
}
