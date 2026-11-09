// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type Stripe from "stripe";
import { getStripeCallTimeoutMs } from "@breatic/core";
import { getStripeClient } from "@server/infra/stripe.js";

/**
 * Whether a Stripe call failed with the given error code.
 * @param err - What the call threw.
 * @param code - Stripe's error code.
 * @returns True when it is that Stripe error.
 */
function isStripeCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * The Stripe coupon for a referred account's first billing period.
 *
 * One coupon per percent, with a fixed id, read on every checkout rather than
 * cached: a coupon deleted or edited at Stripe is noticed on the next one. A
 * missing coupon is created; one whose terms differ is refused, so nobody is
 * discounted by a coupon the promoter terms do not describe.
 * @param percent - The configured discount.
 * @returns The coupon id to put on the Checkout Session.
 * @throws {Error} if the coupon at Stripe does not match, or Stripe fails.
 */
export async function ensureFirstPeriodCoupon(percent: number): Promise<string> {
  const id = `referral-first-period-${percent}`;
  const call = { timeout: getStripeCallTimeoutMs(), maxNetworkRetries: 0 };
  const stripe = getStripeClient();
  let coupon: Stripe.Coupon;
  try {
    coupon = await stripe.coupons.retrieve(id, {}, call);
  } catch (err) {
    if (!isStripeCode(err, "resource_missing")) throw err;
    try {
      coupon = await stripe.coupons.create(
        { id, name: `Referral: ${percent}% off first period`, percent_off: percent, duration: "once" },
        call,
      );
    } catch (createErr) {
      if (!isStripeCode(createErr, "resource_already_exists")) throw createErr;
      coupon = await stripe.coupons.retrieve(id, {}, call);
    }
  }
  if (coupon.percent_off !== percent || coupon.duration !== "once" || !coupon.valid) {
    throw new Error(`Stripe coupon ${id} does not match the referral terms; delete it at Stripe to have it recreated`);
  }
  return id;
}
