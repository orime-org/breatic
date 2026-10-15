// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a refund that Stripe reports as succeeded may be booked (inner#1410
 * §5.4, the three settle conditions).
 *
 * `canSettle` reads every refund of the payment, judged in the design's
 * order: a refund still in flight means wait; then the succeeded sum must
 * reach the paid amount (`partial_refund`); then every succeeded refund made
 * outside the product must be one the operator confirmed
 * (`unexpected_external_refund`). Booking credits off the buyer while money
 * is still in flight, or while less than they paid went back, is what this
 * rule exists to prevent; the two properties at the end pin exactly that.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { canSettle } from "@server/modules/credit-refund/settle-rule.js";
import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";

const OP = "11111111-1111-4111-8111-111111111111";

/** One refund copy; `operationId` null marks a refund made outside the product. */
function refund(
  stripeRefundId: string,
  status: StripeRefundStatus,
  amountCents: number,
  own: boolean,
): RefundCopy {
  return {
    stripeRefundId,
    amountCents,
    status,
    pendingReason: status === "pending" ? "processing" : null,
    operationId: own ? OP : null,
    everSucceeded: status === "succeeded",
    resolvedByOperationId: null,
    failureReason: null,
  };
}

describe("canSettle", () => {
  it("settles one own refund that covers the paid amount, reporting the succeeded sum", () => {
    expect(
      canSettle({
        refunds: [refund("re_own", "succeeded", 1000, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "settle", succeededCents: 1000 });
  });

  it("settles when an own refund and a confirmed external refund together cover the paid amount", () => {
    expect(
      canSettle({
        refunds: [refund("re_ext", "succeeded", 300, false), refund("re_own", "succeeded", 700, true)],
        paidCents: 1000,
        confirmedRefundIds: ["re_ext"],
      }),
    ).toEqual({ outcome: "settle", succeededCents: 1000 });
  });

  it("settles when the succeeded sum is more than the paid amount", () => {
    expect(
      canSettle({
        refunds: [refund("re_own", "succeeded", 1200, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "settle", succeededCents: 1200 });
  });

  it("does not count failed or canceled refunds towards the succeeded sum", () => {
    const failedOnce = { ...refund("re_old", "failed", 1000, true), everSucceeded: true };
    expect(
      canSettle({
        refunds: [failedOnce, refund("re_cx", "canceled", 1000, true), refund("re_own", "succeeded", 400, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "attention", reason: "partial_refund" });
  });

  it.each<StripeRefundStatus>(["pending", "requires_action"])(
    "waits while another refund is %s, even though the paid amount is already covered",
    (status) => {
      expect(
        canSettle({
          refunds: [refund("re_own", "succeeded", 1000, true), refund("re_other", status, 50, true)],
          paidCents: 1000,
          confirmedRefundIds: [],
        }),
      ).toEqual({ outcome: "wait" });
    },
  );

  it("asks for attention as partial_refund when the succeeded sum is below the paid amount", () => {
    expect(
      canSettle({
        refunds: [refund("re_own", "succeeded", 999, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "attention", reason: "partial_refund" });
  });

  it("asks for attention as unexpected_external_refund for a succeeded external refund nobody confirmed", () => {
    expect(
      canSettle({
        refunds: [refund("re_ext", "succeeded", 300, false), refund("re_own", "succeeded", 700, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "attention", reason: "unexpected_external_refund" });
  });

  it("ignores an unconfirmed external refund that did not succeed", () => {
    expect(
      canSettle({
        refunds: [refund("re_ext", "failed", 300, false), refund("re_own", "succeeded", 1000, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "settle", succeededCents: 1000 });
  });

  it("does not ask own refunds to be confirmed", () => {
    expect(
      canSettle({
        refunds: [refund("re_a", "succeeded", 500, true), refund("re_b", "succeeded", 500, true)],
        paidCents: 1000,
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "settle", succeededCents: 1000 });
  });

  describe("judgement order", () => {
    it("waiting comes before partial_refund", () => {
      expect(
        canSettle({
          refunds: [refund("re_own", "pending", 1000, true)],
          paidCents: 1000,
          confirmedRefundIds: [],
        }),
      ).toEqual({ outcome: "wait" });
    });

    it("waiting comes before unexpected_external_refund", () => {
      expect(
        canSettle({
          refunds: [refund("re_ext", "succeeded", 1000, false), refund("re_p", "requires_action", 1, true)],
          paidCents: 1000,
          confirmedRefundIds: [],
        }),
      ).toEqual({ outcome: "wait" });
    });

    it("partial_refund comes before unexpected_external_refund", () => {
      expect(
        canSettle({
          refunds: [refund("re_ext", "succeeded", 300, false)],
          paidCents: 1000,
          confirmedRefundIds: [],
        }),
      ).toEqual({ outcome: "attention", reason: "partial_refund" });
    });
  });

  describe("properties", () => {
    const statusArb = fc.constantFrom<StripeRefundStatus>(
      "pending",
      "requires_action",
      "succeeded",
      "failed",
      "canceled",
    );
    const refundsArb = fc
      .array(
        fc.record({
          status: statusArb,
          amountCents: fc.integer({ min: 1, max: 5000 }),
          own: fc.boolean(),
        }),
        { maxLength: 6 },
      )
      .map((rows) => rows.map((r, i) => refund(`re_${i}`, r.status, r.amountCents, r.own)));
    const inputArb = fc
      .tuple(refundsArb, fc.integer({ min: 1, max: 10000 }))
      .chain(([refunds, paidCents]) =>
        fc
          .subarray(refunds.map((r) => r.stripeRefundId))
          .map((confirmedRefundIds) => ({ refunds, paidCents, confirmedRefundIds })),
      );

    it("never settles while any refund is pending or requires_action", () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const inFlight = input.refunds.some(
            (r) => r.status === "pending" || r.status === "requires_action",
          );
          if (inFlight) expect(canSettle(input)).toEqual({ outcome: "wait" });
        }),
      );
    });

    it("never settles when the succeeded sum is below the paid amount", () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const succeeded = input.refunds
            .filter((r) => r.status === "succeeded")
            .reduce((sum, r) => sum + r.amountCents, 0);
          const verdict = canSettle(input);
          if (succeeded < input.paidCents) expect(verdict.outcome).not.toBe("settle");
          if (verdict.outcome === "settle") expect(verdict.succeededCents).toBe(succeeded);
        }),
      );
    });

    it("settles exactly when all three conditions hold", () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const noneInFlight = input.refunds.every(
            (r) => r.status !== "pending" && r.status !== "requires_action",
          );
          const succeeded = input.refunds
            .filter((r) => r.status === "succeeded")
            .reduce((sum, r) => sum + r.amountCents, 0);
          const externalsConfirmed = input.refunds
            .filter((r) => r.status === "succeeded" && r.operationId === null)
            .every((r) => input.confirmedRefundIds.includes(r.stripeRefundId));
          const expected = noneInFlight && succeeded >= input.paidCents && externalsConfirmed;
          expect(canSettle(input).outcome === "settle").toBe(expected);
        }),
      );
    });
  });
});
