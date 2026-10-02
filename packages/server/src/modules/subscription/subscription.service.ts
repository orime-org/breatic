// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  AppError,
  ConflictError,
  LIVE_SUBSCRIPTION_STATUSES,
  NotFoundError,
  ValidationError,
  db,
  getStripeCallTimeoutMs,
  getSubscriptionPlan,
  listSubscriptions,
  logger,
  subscriptionClock,
  subscriptionSituation,
} from "@breatic/core";
import type {
  SituationReading,
  StoredSubscription,
  SubscriptionWrite,
} from "@breatic/core";
import type {
  BillingPeriod,
  SubscribableMembershipTier,
} from "@breatic/shared";
import {
  canMoveTo,
  holdsActionableSubscription,
  subscriptionActions,
  t,
} from "@breatic/shared";
import { getStripeClient } from "@server/infra/stripe.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { applySubscriptionWrite } from "@server/modules/subscription/apply-subscription.js";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";
import { sendMembershipEndedMail } from "@server/modules/subscription/settle-tier.js";

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
async function readSituation(
  userId: string,
): Promise<SituationReading<StoredSubscription>> {
  const rows = await listSubscriptions(userId);
  return subscriptionSituation(rows, subscriptionClock());
}

/**
 * Stores a subscription as Stripe described it in answer to one of the
 * panel's own actions, so the next read shows it without waiting for the
 * webhook (#307 A10).
 *
 * An answer that cannot be read against our price list is not written: the
 * webhook carries the same change and answers that disagreement in its own
 * way. The action itself already happened at Stripe, so the caller still
 * reports it.
 * @param input - What to store.
 * @param input.userId - The account.
 * @param input.subscription - Stripe's answer, with `latest_invoice` expanded.
 * @param input.observedAt - When Stripe was asked.
 * @param input.referenceId - Identifies the change in the tier ledger.
 * @throws {Error} if the database fails.
 */
async function storeAnswer(input: {
  userId: string;
  subscription: Stripe.Subscription;
  observedAt: Date;
  referenceId: string;
}): Promise<void> {
  const read = readStripeSubscription(input.subscription, input.userId, input.observedAt);
  if (!read.ok) {
    logger.error(
      {
        userId: input.userId,
        stripeSubscriptionId: input.subscription.id,
        reason: read.reason,
      },
      "subscription_action_answer_unreadable",
    );
    return;
  }
  await writeSnapshot(input.userId, read.write, input.referenceId);
}

/**
 * Stores one readable snapshot and sends the membership-ended email the change
 * may owe, after the commit.
 * @param userId - The account.
 * @param write - The snapshot.
 * @param referenceId - Identifies the change in the tier ledger.
 * @throws {Error} if the database fails.
 */
async function writeSnapshot(
  userId: string,
  write: SubscriptionWrite,
  referenceId: string,
): Promise<void> {
  const applied = await db.transaction((tx) =>
    applySubscriptionWrite({ userId, write, referenceId, tx }),
  );
  // After the commit: an email about a change that then rolled back cannot be
  // recalled.
  if (applied.endedFrom) await sendMembershipEndedMail(userId, applied.endedFrom);
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
 * The two addresses Stripe sends somebody back to, marked apart.
 *
 * Both land on the page they left, so without a mark the page cannot tell a
 * completed payment from somebody pressing Stripe's back link — and a page
 * that cannot tell them apart cannot report either one.
 *
 * The paid one also names the checkout, so the page can confirm that one
 * purchase straight away rather than wait for its webhook (#307). Stripe fills
 * `{CHECKOUT_SESSION_ID}` in on its way out, so the braces are appended after
 * the URL is built: passing them through `URL` would encode them and leave the
 * placeholder unfilled.
 * @param returnUrl - The page the purchase was started from.
 * @returns The two URLs, named as Stripe's own fields.
 */
function returnUrls(returnUrl: string): {
  success_url: string;
  cancel_url: string;
} {
  const paid = new URL(returnUrl);
  paid.searchParams.set("membership", "1");

  const left = new URL(returnUrl);
  left.searchParams.set("membership", "1");
  left.searchParams.set("cancelled", "1");

  return {
    success_url: `${paid.toString()}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: left.toString(),
  };
}

/**
 * Starts a checkout for an account that does not subscribe yet.
 *
 * Also the path back for somebody whose subscription ended: an ended
 * subscription cannot be updated or revived, so a returning customer gets a
 * new one alongside the old row.
 * @param input - Who, which offer, and where to send them afterwards.
 * @param input.userId - The account paying.
 * @param input.tier - The tier being bought.
 * @param input.period - How often it is to be billed.
 * @param input.returnUrl - The page to come back to, paid or not.
 * @returns Stripe's hosted checkout page.
 * @throws {ConflictError} if the account already holds a membership.
 */
export async function startCheckout(input: {
  userId: string;
  tier: SubscribableMembershipTier;
  period: BillingPeriod;
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
    // be paid: two charges for one membership, of which the reading can only
    // honour one.
    await voidUnpaidSubscription(record.stripeSubscriptionId, input.userId);
  }

  const customerId = await ensureCustomer(input.userId);
  const session = await getStripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [
      {
        price: getSubscriptionPlan(input.tier, input.period).stripePriceId,
        quantity: 1,
      },
    ],
    // Reaches the subscription object, which is what events carry. Top-level
    // metadata and `client_reference_id` stop at the Session.
    subscription_data: { metadata: { userId: input.userId } },
    client_reference_id: input.userId,
    ...returnUrls(input.returnUrl),
  });

  if (!session.url) {
    throw new Error(`Stripe returned a checkout session with no URL`);
  }
  return { url: session.url };
}


/**
 * Stores what one membership checkout came to, when the buyer comes back.
 *
 * Stripe sends the buyer home as soon as the payment is submitted, which is
 * often before the webhook that records it. Asking about this one Checkout
 * Session lets the page show the tier that was bought straight away; the
 * webhook still arrives and finds the same snapshot, or an older one that the
 * stored `observedAt` keeps from winning.
 * @param userId - The account the buyer is signed in as.
 * @param sessionId - The Checkout Session the return address named.
 * @throws {NotFoundError} if the session is not a membership checkout of this
 *   account's, or Stripe has no such session.
 * @throws {AppError} `503` if the session holds no subscription yet, or holds
 *   one whose price this deployment cannot confirm.
 * @throws {Error} if Stripe failed for any other reason.
 */
export async function confirmCheckout(
  userId: string,
  sessionId: string,
): Promise<void> {
  // Stamped before the call: the moment that decides which of two writers
  // holds the newer view is when each of them asked.
  const observedAt = new Date();
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripeClient().checkout.sessions.retrieve(
      sessionId,
      { expand: ["subscription.latest_invoice"] },
      { timeout: getStripeCallTimeoutMs(), maxNetworkRetries: 0 },
    );
  } catch (err) {
    if (subscriptionGoneAtStripe(err)) {
      throw new NotFoundError(t("server.membership.checkout_not_found"));
    }
    throw err;
  }

  if (session.mode !== "subscription" || session.client_reference_id !== userId) {
    throw new NotFoundError(t("server.membership.checkout_not_found"));
  }

  const subscription = session.subscription;
  if (!subscription || typeof subscription === "string") {
    throw new AppError(503, t("server.membership.checkout_unconfirmed"));
  }

  const read = readStripeSubscription(subscription, userId, observedAt);
  if (!read.ok) {
    logger.error(
      { userId, sessionId, stripeSubscriptionId: subscription.id, reason: read.reason },
      "subscription_checkout_unreadable",
    );
    throw new AppError(503, t("server.membership.checkout_unconfirmed"));
  }

  await writeSnapshot(userId, read.write, `checkout:${sessionId}`);
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
 * acting on the stored row. That row is a snapshot from whichever wrote it
 * last, the webhook or the panel's reconciliation, and one of the ways it goes
 * out of date is the one that matters most here: the reader paid. The panel hands an account in this state a
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
      timeout: getStripeCallTimeoutMs(),
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
 * Moves an account that already subscribes onto another offer.
 *
 * Replaces the price on the existing item rather than starting a second
 * subscription, and collects the difference before the change takes effect.
 * @param input - Who and which offer.
 * @param input.userId - The account.
 * @param input.tier - The tier to move to.
 * @param input.period - The period to be billed over from now on.
 * @returns Whether the new tier is in force, and where to pay if not.
 * @throws {ConflictError} if nothing is live, the same tier and period are
 *   already held, or payment is overdue.
 * @throws {ValidationError} if the target is a lower tier or a shorter period
 *   than the one held.
 */
export async function changePlan(input: {
  userId: string;
  tier: SubscribableMembershipTier;
  period: BillingPeriod;
}): Promise<PlanChange> {
  const { situation, record } = await readSituation(input.userId);
  if (!record || !holdsActionableSubscription(situation)) {
    throw new ConflictError(t("server.membership.no_subscription"));
  }
  if (record.tier === input.tier && record.period === input.period) {
    throw new ConflictError(t("server.membership.same_tier"));
  }
  // The same rule the panel draws with, so an entrance exists exactly where
  // this accepts. Nothing refused here has a button: the cells that cannot be
  // reached are left blank rather than explained, and whatever arrives here
  // called the endpoint directly.
  if (
    !canMoveTo(
      // A stored subscription was sold, so its tier is one of the two on the
      // price list; the column's wider type is what every tier column carries.
      { tier: record.tier as SubscribableMembershipTier, period: record.period },
      { tier: input.tier, period: input.period },
    )
  ) {
    throw new ValidationError(t("server.membership.change_not_offered"));
  }
  if (subscriptionActions(situation, record.cancelAtPeriodEnd).move === "withheld") {
    // The paid tier is held while Stripe retries, but selling more during that
    // window would bill a card that is already failing. The panel reads the
    // same answer and draws no entrance, so nobody arrives here by clicking.
    throw new ConflictError(t("server.membership.payment_overdue"));
  }

  const changedAt = new Date();
  const updated = await getStripeClient().subscriptions.update(
    record.stripeSubscriptionId,
    {
      items: [
        {
          id: itemToReplace(record),
          price: getSubscriptionPlan(input.tier, input.period).stripePriceId,
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

  const read = readStripeSubscription(updated, input.userId, changedAt);
  if (!read.ok) {
    // Stripe took the change and what came back does not agree with our price
    // list. Reporting "applied" here is the one answer that cannot be taken
    // back: the reader is told their plan changed while the row still holds
    // the old one, and nothing later contradicts it.
    throw new AppError(500, t("server.membership.change_unconfirmed"));
  }
  const pending = read.write.hasPendingUpdate;
  await writeSnapshot(
    input.userId,
    read.write,
    `action:change:${record.stripeSubscriptionId}`,
  );

  if (situation === "cancelling") {
    const withdrawnAt = new Date();
    const withdrawn = await withdrawCancellation(
      record.stripeSubscriptionId,
      input.userId,
    );
    if (withdrawn) {
      await storeAnswer({
        userId: input.userId,
        subscription: withdrawn,
        observedAt: withdrawnAt,
        referenceId: `action:withdraw:${record.stripeSubscriptionId}`,
      });
    }
  }

  return {
    status: pending ? "pendingPayment" : "applied",
    payableInvoiceUrl: read.write.payableInvoiceUrl,
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
 * @returns The subscription as Stripe now describes it, or null when the call
 *   failed.
 */
async function withdrawCancellation(
  subscriptionId: string,
  userId: string,
): Promise<Stripe.Subscription | null> {
  try {
    return await getStripeClient().subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
      expand: ["latest_invoice"],
    });
  } catch (err) {
    // Not rethrown: the upgrade the caller asked for did happen, and
    // answering with an error would tell them it did not.
    logger.error(
      { err, userId, subscriptionId },
      "subscription_cancellation_withdrawal_failed",
    );
    return null;
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
  const askedAt = new Date();
  const updated = await getStripeClient().subscriptions.update(
    record.stripeSubscriptionId,
    { cancel_at_period_end: true, expand: ["latest_invoice"] },
  );
  await storeAnswer({
    userId,
    subscription: updated,
    observedAt: askedAt,
    referenceId: `action:cancel:${record.stripeSubscriptionId}`,
  });
  return updated;
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
  const askedAt = new Date();
  const updated = await getStripeClient().subscriptions.update(
    record.stripeSubscriptionId,
    { cancel_at_period_end: false, expand: ["latest_invoice"] },
  );
  await storeAnswer({
    userId,
    subscription: updated,
    observedAt: askedAt,
    referenceId: `action:resume:${record.stripeSubscriptionId}`,
  });
  return updated;
}
