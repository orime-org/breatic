// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the membership panel is told, and the reconciliation that runs while
 * telling it (task #106, §10.2, §11).
 *
 * The tier is stored on the account and only the webhook writes it, while
 * Stripe stops redelivering an event after three days. So a lost event leaves
 * the account permanently wrong, in one of two directions, and each direction
 * needs a different place to be caught:
 *
 *   - Getting a paid tier for free is caught where ceilings are read
 *     (`membership.repo.ts`), because somebody in that state has no reason to
 *     come here.
 *   - Being wrongly downgraded is caught here, because the first thing that
 *     person does is open this panel.
 *
 * The subscription rows are rewritten too, not just the tier. Fixing only the
 * tier would leave "on PRO, with no live subscription stored", and the next
 * upgrade would be judged as having no subscription — opening a SECOND one at
 * Stripe, which is the thing acceptance item 9 forbids.
 */

import type Stripe from "stripe";
import {
  db,
  getStripeCallTimeoutMs,
  logger,
  listSubscriptions,
  lockAccountRow,
  subscriptionSituation,
  tierForSituation,
  upsertSubscription,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { MembershipTier, SubscriptionSummary } from "@breatic/shared";
import { getStripeClient } from "@server/infra/stripe.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";
import {
  settleTier,
  sendMembershipEndedMail,
} from "@server/modules/subscription/settle-tier.js";

/**
 * How many of an account's subscriptions to ask Stripe about.
 *
 * Stripe returns them newest first, and what this repair needs to see is the
 * current state: whatever is live now, plus enough recent history to notice
 * one that just ended. Three covers that without paging.
 *
 * It is not a claim that an account has at most one live subscription — it can
 * have two (`subscription-state.ts` chooses between them), and this window
 * would show both. An account with more subscriptions than this in its recent
 * history keeps the older stored rows it already has; they are ended ones, and
 * an ended subscription does not change again.
 */
const RECONCILE_LIMIT = 3;

/**
 * Brings the stored subscriptions and the tier back in step with Stripe.
 * @param userId - The account.
 * @param customerId - Its Stripe customer.
 * @returns The tier that ended, when the correction ended one.
 */
async function reconcile(
  userId: string,
  customerId: string,
): Promise<MembershipTier | null> {
  // Stamped before the call, not after: the moment that decides which of two
  // writers is holding the newer view is when each of them ASKED.
  const observedAt = new Date();
  const listed = await getStripeClient().subscriptions.list(
    {
      customer: customerId,
      status: "all",
      limit: RECONCILE_LIMIT,
      expand: ["data.latest_invoice"],
    },
    // Bounded, and not retried. The caller's catch already degrades to stored
    // data when this fails, but it only catches a call that FAILS — a Stripe
    // that answers slowly rather than not at all would sit on the SDK's own
    // 80-second default, twice retried, and hold this request handler and the
    // reader behind it for around four minutes. Retrying here would multiply
    // the wait to repair something that repairs itself the next time the
    // panel opens.
    {
      timeout: getStripeCallTimeoutMs(),
      maxNetworkRetries: 0,
    },
  );

  let endedFrom: MembershipTier | null = null;
  // The lock is taken only now, after Stripe has answered, and covers nothing
  // but local writes. The webhook does the same, and the two are kept in order
  // by `observedAt` rather than by which of them holds the lock.
  await db.transaction(async (tx) => {
    await lockAccountRow(userId, tx);
    await writeAll(listed.data, userId, tx, observedAt);
    const reading = subscriptionSituation(await listSubscriptions(userId, tx));
    const settled = await settleTier({
      userId,
      toTier: tierForSituation(reading.situation, reading.record),
      referenceId: `reconcile:${customerId}`,
      tx,
    });
    endedFrom = settled.endedFrom;
  });
  return endedFrom;
}

/**
 * Stores every subscription Stripe reported for the account.
 *
 * One this deployment cannot price is skipped rather than guessed at: writing
 * it under some tier would hand out ceilings nobody bought, and the stored row
 * we already have stays as it was.
 * @param subscriptions - What Stripe reported.
 * @param userId - The account.
 * @param tx - The shared transaction.
 * @param observedAt - When Stripe was asked.
 */
async function writeAll(
  subscriptions: readonly Stripe.Subscription[],
  userId: string,
  tx: DbTx,
  observedAt: Date,
): Promise<void> {
  const writes = subscriptions
    .map((subscription) =>
      readStripeSubscription(subscription, userId, observedAt),
    )
    .filter((write): write is NonNullable<typeof write> => write !== null);

  // Order does not matter: each row is keyed by its own Stripe id, and which
  // one governs the account is decided when they are read. This used to write
  // ended ones first, to get past a unique index that refused a second live
  // row — an index that could only ever refuse the write, and is gone (0059).
  for (const write of writes) {
    await upsertSubscription(write, tx);
  }
}

/**
 * Reads what the panel shows about an account's subscription.
 *
 * Reconciles with Stripe on the way, so opening the panel is also how a lost
 * event gets repaired.
 * Whether this deployment sells subscriptions at all is not asked here: the
 * caller assembling the panel answers that, because it also decides whether to
 * quote prices. This function only ever speaks about subscriptions, and always
 * describes one — "this account has none" is a subscription state, not silence.
 * @param userId - The account.
 * @returns What its subscription is doing.
 * @throws {Error} if the database fails. A Stripe failure is caught and
 *   logged instead: the panel falls back to the stored view, which is what it
 *   showed before this reconciliation existed.
 */
export async function readSubscriptionSummary(
  userId: string,
): Promise<SubscriptionSummary> {
  const customerId = await userRepo.getStripeCustomerId(userId);
  // Never paid us, so there is nothing at Stripe to reconcile against — but
  // the account is still in the state the offers exist for, and answering
  // "nothing" here is what would take the offers away from precisely the
  // people they are for.
  if (!customerId) return { ...EMPTY_SUMMARY };

  // Reconciling is an enhancement: it repairs a lost event. The tier, the
  // allowances and the comparison table beside it are local facts that have
  // nothing to do with Stripe, so a Stripe outage must not take the whole
  // panel down with it. What the reader then sees is our stored view, which
  // is the same thing they saw before this reconciliation existed.
  let endedFrom: MembershipTier | null = null;
  try {
    endedFrom = await reconcile(userId, customerId);
  } catch (err) {
    logger.error({ err, userId }, "subscription_reconcile_failed");
  }
  // After the transaction: an email about a change that then rolled back
  // cannot be recalled.
  if (endedFrom) await sendMembershipEndedMail(userId, endedFrom);

  const { situation, record } = subscriptionSituation(
    await listSubscriptions(userId),
  );
  if (!record) return { ...EMPTY_SUMMARY };

  return {
    state: situation,
    tier: record.tier,
    currentPeriodEnd: record.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    payableInvoiceUrl: record.payableInvoiceUrl,
  };
}

/**
 * What an account with no live subscription is told.
 *
 * Not null. Null belongs to one meaning only — "this deployment sells no
 * subscriptions" — and the panel answers it by hiding every control. An
 * account that has never bought one, or whose subscription ended, is in the
 * state the offers exist for and must still see them.
 */
const EMPTY_SUMMARY: SubscriptionSummary = {
  state: "none",
  tier: "base",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  payableInvoiceUrl: null,
};
