// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The refund-step and subscription-fact request shapes (inner#1993 §3.3): a
 * settle step carries the settled amount and no other step does; a fact
 * carries the reference its tier ledger row points at.
 */

import { describe, expect, it } from "vitest";
import { refundStepRequestSchema, subscriptionFactRequestSchema } from "@core/commerce/contract.js";

const LOT = "6f0d4c1e-6a43-4f53-9f3e-1d2b3c4d5e6f";
const USER = "0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b";

describe("refundStepRequestSchema", () => {
  it("takes a settle step with the settled amount, told or not", () => {
    for (const tell of [null, { kind: "refund_completed" as const, amountCents: 500, currency: "usd" }]) {
      expect(refundStepRequestSchema.safeParse({ lotId: LOT, step: "settle", referenceId: "re_1", settled: { amountCents: 500, currency: "usd" }, tell }).success).toBe(true);
    }
  });

  it("refuses a settle step without the settled amount", () => {
    expect(refundStepRequestSchema.safeParse({ lotId: LOT, step: "settle", referenceId: "re_1", settled: null, tell: null }).success).toBe(false);
    expect(refundStepRequestSchema.safeParse({ lotId: LOT, step: "settle", referenceId: "re_1", tell: null }).success).toBe(false);
  });

  it("refuses a settled amount on any other step, and takes null there", () => {
    for (const step of ["mark_refunding", "send_back", "reject", "restore"] as const) {
      expect(refundStepRequestSchema.safeParse({ lotId: LOT, step, referenceId: "op_1", settled: { amountCents: 1, currency: "usd" }, tell: null }).success).toBe(false);
      expect(refundStepRequestSchema.safeParse({ lotId: LOT, step, referenceId: "op_1", settled: null, tell: null }).success).toBe(true);
    }
  });

  it("refuses a currency that is not three letters, and a negative amount", () => {
    for (const settled of [{ amountCents: 1, currency: "us" }, { amountCents: 1, currency: "usdx" }, { amountCents: -1, currency: "usd" }, { amountCents: 1.5, currency: "usd" }]) {
      expect(refundStepRequestSchema.safeParse({ lotId: LOT, step: "settle", referenceId: "re_1", settled, tell: null }).success).toBe(false);
    }
  });
});

describe("subscriptionFactRequestSchema", () => {
  const fact = {
    stripeSubscriptionId: "sub_1",
    tier: "pro",
    period: "month",
    status: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    hasPendingUpdate: false,
    pendingTier: null,
    pendingPeriod: null,
    observedAt: "2026-11-21T00:00:00.000Z",
    firstActiveAt: null,
  };

  it("takes the reference the tier ledger points at", () => {
    expect(subscriptionFactRequestSchema.safeParse({ userId: USER, fact, notices: [], started: null, referenceId: "evt_1" }).success).toBe(true);
  });

  it("refuses a fact without a reference, or with an empty or overlong one", () => {
    for (const referenceId of [undefined, "", "x".repeat(256)]) {
      expect(subscriptionFactRequestSchema.safeParse({ userId: USER, fact, notices: [], started: null, referenceId }).success).toBe(false);
    }
  });
});
