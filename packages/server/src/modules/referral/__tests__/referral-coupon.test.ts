// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = { coupons: { retrieve: vi.fn(), create: vi.fn() } };

vi.mock("@server/infra/stripe.js", () => ({ getStripeClient: () => stripe }));
vi.mock("@breatic/core", () => ({ getStripeCallTimeoutMs: () => 5000 }));

import { ensureFirstPeriodCoupon } from "../referral-coupon.js";

const CALL = { timeout: 5000, maxNetworkRetries: 0 };

/**
 * A Stripe error with the given code.
 * @param code - Stripe's error code.
 * @returns The error.
 */
function stripeError(code: string): Error {
  return Object.assign(new Error(code), { type: "StripeInvalidRequestError", code });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureFirstPeriodCoupon", () => {
  it("uses the coupon already at Stripe when it matches", async () => {
    stripe.coupons.retrieve.mockResolvedValue({ id: "referral-first-period-20", percent_off: 20, duration: "once", valid: true });
    await expect(ensureFirstPeriodCoupon(20)).resolves.toBe("referral-first-period-20");
    expect(stripe.coupons.retrieve).toHaveBeenCalledWith("referral-first-period-20", {}, CALL);
    expect(stripe.coupons.create).not.toHaveBeenCalled();
  });

  it("creates the coupon, named for customers, when Stripe has none", async () => {
    stripe.coupons.retrieve.mockRejectedValue(stripeError("resource_missing"));
    stripe.coupons.create.mockResolvedValue({ id: "referral-first-period-15", percent_off: 15, duration: "once", valid: true });
    await expect(ensureFirstPeriodCoupon(15)).resolves.toBe("referral-first-period-15");
    expect(stripe.coupons.create).toHaveBeenCalledWith(
      { id: "referral-first-period-15", name: "Referral: 15% off first period", percent_off: 15, duration: "once" },
      CALL,
    );
  });

  it("reads the coupon again when a concurrent checkout created it first", async () => {
    stripe.coupons.retrieve
      .mockRejectedValueOnce(stripeError("resource_missing"))
      .mockResolvedValueOnce({ id: "referral-first-period-20", percent_off: 20, duration: "once", valid: true });
    stripe.coupons.create.mockRejectedValue(stripeError("resource_already_exists"));
    await expect(ensureFirstPeriodCoupon(20)).resolves.toBe("referral-first-period-20");
    expect(stripe.coupons.retrieve).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a different percent", { percent_off: 25, duration: "once", valid: true }],
    ["a repeating duration", { percent_off: 20, duration: "forever", valid: true }],
    ["an invalid coupon", { percent_off: 20, duration: "once", valid: false }],
  ])("refuses %s rather than discounting wrongly", async (_label, coupon) => {
    stripe.coupons.retrieve.mockResolvedValue({ id: "referral-first-period-20", ...coupon });
    await expect(ensureFirstPeriodCoupon(20)).rejects.toThrow(/referral-first-period-20/);
    expect(stripe.coupons.create).not.toHaveBeenCalled();
  });

  it("ignores the coupon's name when checking it", async () => {
    stripe.coupons.retrieve.mockResolvedValue({ id: "referral-first-period-20", name: "renamed", percent_off: 20, duration: "once", valid: true });
    await expect(ensureFirstPeriodCoupon(20)).resolves.toBe("referral-first-period-20");
  });

  it("passes any other Stripe failure on", async () => {
    stripe.coupons.retrieve.mockRejectedValue(stripeError("api_error"));
    await expect(ensureFirstPeriodCoupon(20)).rejects.toThrow("api_error");
  });
});
