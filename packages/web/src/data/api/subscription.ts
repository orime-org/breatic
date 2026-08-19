// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The membership subscription endpoints (task #106).
 *
 * Four calls, and the front end does not choose between the first two by
 * itself: starting a subscription and changing an existing one are different
 * endpoints because they are different operations at Stripe, and which one
 * applies follows from the subscription state the panel was given.
 */

import { apiPost } from '@web/data/api/request';
import type { SubscribableMembershipTier } from '@breatic/shared';

/** Where Stripe's hosted checkout page is. */
export interface CheckoutStart {
  /** The page to send the browser to. */
  url: string;
}

/** What changing plans did. */
export interface PlanChange {
  /** Whether the new tier is in force, or waiting on an invoice. */
  status: 'applied' | 'pendingPayment';
  /** Where to pay the difference, when it was not charged. */
  payableInvoiceUrl: string | null;
}

/**
 * Starts paying for a membership, for an account that holds none.
 * @param tier - The tier being bought.
 * @param returnUrl - Where Stripe sends the browser back to, paid or not.
 * @returns Stripe's hosted checkout page.
 */
export async function startSubscriptionCheckout(
  tier: SubscribableMembershipTier,
  returnUrl: string,
): Promise<CheckoutStart> {
  return apiPost<CheckoutStart>('/account/subscription/checkout', {
    tier,
    return_url: returnUrl,
  });
}

/**
 * Moves an existing membership up a tier.
 * @param tier - The tier to move to.
 * @returns Whether the new tier is in force, and where to pay if not.
 */
export async function changeSubscriptionPlan(
  tier: SubscribableMembershipTier,
): Promise<PlanChange> {
  return apiPost<PlanChange>('/account/subscription/change', { tier });
}

/** Stops the membership renewing at the end of the paid period. */
export async function cancelSubscription(): Promise<void> {
  await apiPost('/account/subscription/cancel');
}

/** Takes back a scheduled cancellation. */
export async function resumeSubscription(): Promise<void> {
  await apiPost('/account/subscription/resume');
}
