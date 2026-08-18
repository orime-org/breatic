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
 * A scheduled cancellation is cleared before any plan change. Leaving it set
 * means the upgrade is paid for and the plan still ends at the period boundary.
 */

import type Stripe from "stripe";
import {
  ConflictError,
  ValidationError,
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
 * Voids the unpaid subscription this account is about to replace.
 *
 * The one irreversible call on this path, and the one decided entirely from a
 * stored row — which this codebase says elsewhere can be out of date, because
 * only the webhook writes it and Stripe stops redelivering after three days.
 * Two ways that row is wrong, and they need opposite answers.
 *
 * The subscription is already gone at Stripe: `resource_missing`. The row is
 * describing something that no longer exists, the reason for cancelling it is
 * already satisfied, and refusing the checkout would leave the account unable
 * to subscribe at all — every attempt failing on a subscription that is not
 * there. So it proceeds.
 *
 * Anything else — Stripe unreachable, a timeout, a permissions failure — has
 * not established that the unpaid subscription is gone. Proceeding would risk
 * exactly what this call exists to prevent: two payable subscriptions, both
 * paid, and no rule but "the newest row" to say which membership counts. So it
 * throws, and the reader is told the checkout could not start.
 * @param subscriptionId - The unpaid subscription at Stripe.
 * @param userId - The account, for the log line.
 * @throws {Error} if Stripe failed for any reason other than the subscription
 *   already being gone.
 */
async function voidUnpaidSubscription(
  subscriptionId: string,
  userId: string,
): Promise<void> {
  try {
    await getStripeClient().subscriptions.cancel(subscriptionId);
  } catch (err) {
    if (!subscriptionGoneAtStripe(err)) throw err;
    logger.warn(
      { userId, subscriptionId },
      "subscription_unpaid_already_gone_at_stripe",
    );
  }
}

/**
 * Whether a Stripe error says the subscription no longer exists there.
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
          // Without the item id this ADDS a price instead of replacing it.
          id: record.stripeItemId ?? undefined,
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

  if (situation === "cancelling" && !pending) {
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
 * Skipped while the upgrade is only pending: clearing a cancellation the
 * reader actually asked for, on the strength of a change that has not
 * happened, would undo their decision for them.
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
