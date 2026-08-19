// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The four things a person can do to their membership (task #106, §7, §6.5.3).
 *
 * Which one applies is decided by the situation their stored subscription puts
 * them in, not by what they clicked: the panel shows one button per tier, and
 * whether that means "start a subscription" or "change the one you have"
 * depends on state only this side can read.
 *
 * Two parameters carry most of the weight, and both are easy to leave out:
 *
 *   - `items[0].id` on an update. Without it Stripe ADDS the price rather than
 *     replacing it, and the account holds two memberships.
 *   - `payment_behavior: "pending_if_incomplete"`. Without it the default is to
 *     change the subscription first and collect afterwards, so a failed card
 *     leaves somebody on a tier they have not paid for.
 *
 * A scheduled cancellation is cleared AFTER the plan change, never before.
 * Neither order can be atomic, so the one to take is the one whose failure the
 * reader can see and undo: the upgrade is in force and the end date is still
 * showing beside a resume button. The other order fails silently in the
 * direction of charging somebody who asked to stop.
 */

import type Stripe from "stripe";
import {
  ConflictError,
  LIVE_SUBSCRIPTION_STATUSES,
  ValidationError,
  getStripeReadTimeoutMs,
  getSubscriptionPlan,
  listSubscriptions,
  logger,
  subscriptionSituation,
} from "@breatic/core";
import type {
  StoredSubscription,
  SubscriptionSituation,
} from "@breatic/core";
import type { SubscribableMembershipTier } from "@breatic/shared";
import {
  COMPARABLE_MEMBERSHIP_TIERS,
  holdsActionableSubscription,
  subscriptionActions,
  t,
} from "@breatic/shared";
import { getStripeClient } from "@server/infra/stripe.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";

/** Where a checkout ends up, and whether it needs paying. */
export interface CheckoutStart {
  /** Stripe's hosted checkout page. */
  readonly url: string;
}

/** What changing plans did. */
export interface PlanChange {
  /** Whether the new tier is in force, or waiting on an invoice. */
  readonly status: "applied" | "pendingPayment";
  /** Where to pay the difference, when it was not charged. */
  readonly payableInvoiceUrl: string | null;
}

/**
 * Reads which situation an account's stored subscriptions put it in.
 * @param userId - The account.
 * @returns The situation and the live row, if any.
 */
async function readSituation(userId: string): Promise<{
  situation: SubscriptionSituation;
  record: StoredSubscription | null;
}> {
  const rows = await listSubscriptions(userId);
  return subscriptionSituation(rows);
}

/**
 * Makes sure the account has a Stripe customer, and returns it.
 *
 * Called before the first Checkout Session exists, because subscription events
 * carry no identifier of ours: the customer on the event is what names the
 * account. The idempotency key is the account id, so two clicks at once cannot
 * produce two customers.
 * @param userId - The account.
 * @returns Its Stripe customer id.
 * @throws {Error} if the account is gone.
 */
async function ensureCustomer(userId: string): Promise<string> {
  const existing = await userRepo.getStripeCustomerId(userId);
  if (existing) return existing;

  const user = await userRepo.getUserById(userId);
  if (!user) throw new Error(`No live account ${userId}`);

  const customer = await getStripeClient().customers.create(
    { email: user.email, metadata: { userId } },
    { idempotencyKey: `customer:${userId}` },
  );
  await userRepo.setStripeCustomerId(userId, customer.id);
  return customer.id;
}

/**
 * Starts a checkout for an account that does not subscribe yet.
 *
 * Also the path back for somebody whose subscription ended: an ended
 * subscription cannot be updated or revived, so a returning customer gets a
 * new one alongside the old row.
 * @param input - Who, which tier, and where to send them afterwards.
 * @param input.userId - The account paying.
 * @param input.tier - The tier being bought.
 * @param input.returnUrl - The page to come back to, paid or not.
 * @returns Stripe's hosted checkout page.
 * @throws {ConflictError} if the account already holds a membership.
 */
export async function startCheckout(input: {
  userId: string;
  tier: SubscribableMembershipTier;
  returnUrl: string;
}): Promise<CheckoutStart> {
  const { situation, record } = await readSituation(input.userId);
  if (holdsActionableSubscription(situation)) {
    throw new ConflictError(t("server.membership.already_subscribed"));
  }

  if (situation === "firstPaymentUnsettled" && record) {
    // Stripe refuses to update a subscription whose first invoice has not
    // settled, so this account can only start over — but the unpaid one is
    // still there and its payment page still works. Leaving it would let both
    // be paid, and then which membership counts is decided by an arbitrary
    // "most recent row wins" rather than by what anybody bought.
    await voidUnpaidSubscription(record.stripeSubscriptionId, input.userId);
  }

  const customerId = await ensureCustomer(input.userId);
  const session = await getStripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [
      { price: getSubscriptionPlan(input.tier).stripePriceId, quantity: 1 },
    ],
    // Reaches the subscription object, which is what events carry. Top-level
    // metadata and `client_reference_id` stop at the Session.
    subscription_data: { metadata: { userId: input.userId } },
    client_reference_id: input.userId,
    success_url: input.returnUrl,
    cancel_url: input.returnUrl,
  });

  if (!session.url) {
    throw new Error(`Stripe returned a checkout session with no URL`);
  }
  return { url: session.url };
}

/**
 * Whether one tier sits above another on the price list.
 * @param tier - The tier being moved to.
 * @param than - The tier currently held.
 * @returns Whether the move is upwards.
 */
function isHigherThan(tier: string, than: string): boolean {
  return (
    COMPARABLE_MEMBERSHIP_TIERS.indexOf(tier as never) >
    COMPARABLE_MEMBERSHIP_TIERS.indexOf(than as never)
  );
}

/**
 * The subscription item whose price an upgrade replaces.
 *
 * Never `undefined`. Stripe reads an item with no id as a NEW item, so the
 * account ends up holding both prices and being billed for both — $51 a month
 * where $39 was intended, while we record only the tier we meant to sell. That
 * is the exact outcome acceptance item 9 forbids, produced by an argument that
 * looks like "leave it out if we do not have it".
 *
 * We always have it in practice: `readStripeSubscription` reads it off the
 * subscription Stripe returns, and both writers store it. So a null here means
 * a row written by something else, or a subscription Stripe returned without
 * items — neither of which this function can repair, and both of which are
 * cheaper to hear about than to bill somebody for.
 * @param record - The account's live subscription.
 * @returns The Stripe subscription item id.
 * @throws {Error} if the stored row carries no item id.
 */
function itemToReplace(record: StoredSubscription): string {
  if (!record.stripeItemId) {
    throw new Error(
      `Subscription ${record.stripeSubscriptionId} has no stored item id; ` +
        `changing its price would add a second one instead of replacing it`,
    );
  }
  return record.stripeItemId;
}

/**
 * Voids the unpaid subscription this account is about to replace.
 *
 * The one irreversible call on this path, so it asks Stripe first rather than
 * acting on the stored row. That row can be out of date — only the webhook
 * writes it — and one of the ways it goes out of date is the one that matters
 * most here: the reader paid. The panel hands an account in this state a
 * payment link that opens in a NEW tab, so the tab they came from keeps
 * showing the old state and never refetches on focus; paying there and coming
 * back to press a tier button is a path we laid out ourselves. Cancelling on
 * the strength of the stale row would then cancel a subscription that was
 * just paid for, and Stripe's cancel refunds nothing.
 *
 * What Stripe says decides, and only a subscription that is BOTH live and
 * past its first invoice stops the checkout:
 *
 * Live and settled (`active`, `past_due`) — they paid. Nothing is cancelled
 * and nothing is sold: they already hold the membership they came to buy.
 *
 * Live and unsettled (`incomplete`) — the case this branch exists for. It is
 * cancelled, and the checkout goes ahead.
 *
 * Already over (`canceled`, `unpaid`, `incomplete_expired`) — measured, not
 * assumed: `retrieve` answers 200 with the terminal status rather than
 * `resource_missing`, which only comes back from `cancel` or from an id that
 * never existed. There is nothing left to void, so the checkout goes ahead.
 * Treating these as "you already have a membership" told somebody with no
 * membership at all that they could not buy one.
 * @param subscriptionId - The unpaid subscription at Stripe.
 * @param userId - The account, for the log line.
 * @throws {ConflictError} if Stripe says that subscription is live and paid.
 * @throws {Error} if Stripe failed for any reason other than it being gone.
 */
async function voidUnpaidSubscription(
  subscriptionId: string,
  userId: string,
): Promise<void> {
  let fresh: Stripe.Subscription;
  try {
    fresh = await getStripeClient().subscriptions.retrieve(subscriptionId, {
      timeout: getStripeReadTimeoutMs(),
      maxNetworkRetries: 0,
    });
  } catch (err) {
    if (!subscriptionGoneAtStripe(err)) throw err;
    // No such subscription. Nothing to void, so nothing stands in the way.
    logger.warn(
      { userId, subscriptionId },
      "subscription_unpaid_already_gone_at_stripe",
    );
    return;
  }

  if (!LIVE_SUBSCRIPTION_STATUSES.includes(fresh.status as never)) return;

  if (fresh.status !== "incomplete") {
    logger.info(
      { userId, subscriptionId, status: fresh.status },
      "subscription_unpaid_settled_before_checkout",
    );
    throw new ConflictError(t("server.membership.already_subscribed"));
  }

  try {
    await getStripeClient().subscriptions.cancel(subscriptionId);
  } catch (err) {
    // An `incomplete` subscription expires by itself within a day, and this
    // call is one network round trip after the read above. Landing exactly on
    // that boundary means the thing being voided is already gone, which is
    // what this call wanted.
    if (!subscriptionGoneAtStripe(err)) throw err;
    logger.warn(
      { userId, subscriptionId },
      "subscription_unpaid_expired_before_cancel",
    );
  }
}

/**
 * Whether a Stripe error says the subscription no longer exists there.
 *
 * Comes back from `cancel` on a subscription that has already ended, and from
 * either call on an id Stripe never had. NOT from `retrieve` on a subscription
 * that ended — that answers 200 with the terminal status.
 * @param err - Whatever the SDK threw.
 * @returns Whether this is Stripe's "that object is gone" answer.
 */
function subscriptionGoneAtStripe(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "resource_missing"
  );
}

/**
 * Moves an account that already subscribes onto a higher tier.
 *
 * Replaces the price on the existing item rather than starting a second
 * subscription, and collects the difference before the change takes effect.
 * @param input - Who and which tier.
 * @param input.userId - The account.
 * @param input.tier - The tier to move to.
 * @returns Whether the new tier is in force, and where to pay if not.
 * @throws {ConflictError} if nothing is live, the tier is already held, or
 *   payment is overdue.
 * @throws {ValidationError} if the target tier is lower than the one held.
 */
export async function changePlan(input: {
  userId: string;
  tier: SubscribableMembershipTier;
}): Promise<PlanChange> {
  const { situation, record } = await readSituation(input.userId);
  if (!record || !holdsActionableSubscription(situation)) {
    throw new ConflictError(t("server.membership.no_subscription"));
  }
  if (record.tier === input.tier) {
    throw new ConflictError(t("server.membership.same_tier"));
  }
  if (!isHigherThan(input.tier, record.tier)) {
    // No entrance offers this — the panel leaves the lower rows blank — so
    // anything arriving here called the endpoint directly.
    throw new ValidationError(t("server.membership.downgrade_not_offered"));
  }
  if (subscriptionActions(situation, record.cancelAtPeriodEnd).upgrade === "withheld") {
    // The paid tier is held while Stripe retries, but selling more during that
    // window would bill a card that is already failing. The panel reads the
    // same answer and draws no entrance, so nobody arrives here by clicking.
    throw new ConflictError(t("server.membership.payment_overdue"));
  }

  const updated = await getStripeClient().subscriptions.update(
    record.stripeSubscriptionId,
    {
      items: [
        {
          id: itemToReplace(record),
          price: getSubscriptionPlan(input.tier).stripePriceId,
        },
      ],
      // `cancel_at_period_end` must NOT travel with this call. A pending
      // update accepts only the attributes on Stripe's own list — expand,
      // payment_behavior, proration_behavior, proration_date,
      // billing_cycle_anchor, items, trial_end, trial_from_plan, metadata,
      // discounts, coupon, promotion_code, add_invoice_items — and this is
      // not one of them. Sending it does not add a harmless field: Stripe
      // rejects the whole request with a 400, so every upgrade fails.
      // (docs.stripe.com/billing/pending-updates-reference, "Supported
      // attributes for pending updates".)
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice"],
    },
  );

  const read = readStripeSubscription(updated, input.userId);
  const pending = read?.hasPendingUpdate ?? false;

  if (situation === "cancelling") {
    await withdrawCancellation(record.stripeSubscriptionId, input.userId);
  }

  return {
    status: pending ? "pendingPayment" : "applied",
    payableInvoiceUrl: read?.payableInvoiceUrl ?? null,
  };
}

/**
 * Takes the scheduled cancellation off a subscription that was just upgraded.
 *
 * A second call, and deliberately AFTER the plan change rather than before.
 * Before it, a failure here would leave the cancellation already withdrawn
 * while the upgrade never happened: the account keeps renewing, nobody asked
 * for that, and nothing says so. After it, a failure leaves the upgrade in
 * force and the cancellation still scheduled — which the panel already draws
 * as an end date beside a "resume" button, so the reader can see it and undo
 * it themselves. Neither ordering can be atomic, so the one whose failure is
 * visible and reversible is the one to take.
 *
 * Done whether or not the upgrade settled immediately. Pressing an upgrade
 * button is itself the statement "I am not leaving" — it is the only thing
 * that button says, and the panel offers it in this state on purpose (design
 * section 13, S3). Skipping it while the difference is still unpaid looked
 * careful and was not: the reader then pays the invoice, the upgrade applies,
 * and the scheduled ending is still there, so the plan they just paid more to
 * keep ends at the period boundary anyway.
 * @param subscriptionId - The subscription at Stripe.
 * @param userId - The account, for the log line if this fails.
 */
async function withdrawCancellation(
  subscriptionId: string,
  userId: string,
): Promise<void> {
  try {
    await getStripeClient().subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });
  } catch (err) {
    // Not rethrown: the upgrade the caller asked for did happen, and
    // answering with an error would tell them it did not.
    logger.error(
      { err, userId, subscriptionId },
      "subscription_cancellation_withdrawal_failed",
    );
  }
}

/**
 * Schedules an account's membership to end when its paid period runs out.
 *
 * Not an immediate stop and not a refund: the ratified rule is that paid time
 * is used up. Stripe ends the subscription itself at the boundary, and the
 * event that follows is what moves the tier.
 * @param userId - The account.
 * @returns The subscription as Stripe now describes it.
 * @throws {ConflictError} if the account holds nothing that can be cancelled.
 */
export async function cancel(userId: string): Promise<Stripe.Subscription> {
  const { situation, record } = await readSituation(userId);
  if (!record || !subscriptionActions(situation, record.cancelAtPeriodEnd).cancel) {
    throw new ConflictError(t("server.membership.no_subscription"));
  }
  return getStripeClient().subscriptions.update(record.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
}

/**
 * Takes back a scheduled cancellation.
 *
 * The way out of the state a cancellation puts an account in: without it,
 * somebody who changed their mind would have to wait for the plan to end and
 * subscribe again.
 * @param userId - The account.
 * @returns The subscription as Stripe now describes it.
 * @throws {ConflictError} if nothing is scheduled to end.
 */
export async function resume(userId: string): Promise<Stripe.Subscription> {
  const { situation, record } = await readSituation(userId);
  // Asks whether an ending is scheduled, not whether the situation is called
  // `cancelling`. An account that is both behind on payment and scheduled to
  // end reads as `retrying` — the situation can only name one thing — and
  // withdrawing the cancellation is exactly what it should still be able to
  // do. The panel draws the button from this same answer.
  if (!record || !subscriptionActions(situation, record.cancelAtPeriodEnd).resume) {
    throw new ConflictError(t("server.membership.not_cancelling"));
  }
  return getStripeClient().subscriptions.update(record.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });
}
