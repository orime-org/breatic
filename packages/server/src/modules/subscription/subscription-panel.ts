// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the membership panel is told about an account's subscription
 * (task #106 §11, #307).
 *
 * Read from our own rows only. Stripe tells us about every change by webhook,
 * and redelivers a failed one for three days; the rows those webhooks write
 * are what this answers from. A row still marked live but past its deadline
 * reads as ended here exactly as it does for the ceilings, so the panel's
 * subscription lines and its tier never disagree.
 */

import {
  listSubscriptions,
  subscriptionClock,
  subscriptionSituation,
} from "@breatic/core";
import type { SubscriptionSummary } from "@breatic/shared";

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
  // No subscription, so no period: `base` is what an account falls back to
  // rather than something anybody is billed for.
  period: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  payableInvoiceUrl: null,
};

/**
 * Reads what the panel shows about an account's subscription.
 *
 * Whether this deployment sells subscriptions at all is not asked here: the
 * caller assembling the panel answers that, because it also decides whether to
 * quote prices. This function always describes a subscription — "this account
 * has none" is a subscription state, not silence.
 * @param userId - The account.
 * @returns What its subscription is doing.
 * @throws {Error} if the database fails.
 */
export async function readStoredSubscriptionSummary(
  userId: string,
): Promise<SubscriptionSummary> {
  const { situation, record } = subscriptionSituation(
    await listSubscriptions(userId),
    subscriptionClock(),
  );
  if (!record) return EMPTY_SUMMARY;

  return {
    state: situation,
    tier: record.tier,
    period: record.period,
    currentPeriodEnd: record.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    payableInvoiceUrl: record.payableInvoiceUrl,
  };
}
