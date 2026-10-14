// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The preview's v9 fields (inner#1410 §4.5, §5.1, §5.3), over a real socket
 * against real Postgres and Redis and the stateful fake Stripe:
 *
 * - `refunds[].pendingReason`: Stripe's `pending_reason` while pending
 *   (`processing`, `insufficient_funds`, `charge_pending`; any other value
 *   is read as `processing`), null otherwise; the copy stores the same;
 * - `disputed`: the charge's `latest_charge.disputed`, read with
 *   `paymentIntents.retrieve(pi, { expand: ["latest_charge"] })`; a failed
 *   read is 503 `stripe_unavailable`, the copies of the list read kept;
 * - `refundFailure`: whether the lot is in the view
 *   `credit_lot_refund_failures`;
 * - `restoreCredits`: whether restore-credits holds now —
 *   `{ outcome: "allowed" }`, or `{ outcome: "blocked", code, reason? }`
 *   with the same code the endpoint would answer;
 * - `action` is null on a `refunded` lot (no create operation is judged).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { fakeStripe, stripeError, type FakeRefundInput } from "./fake-stripe-refunds.js";
import { call, freshKey, mailsSettled, paths, useInternalApp } from "./internal-api-harness.js";
import {
  PAID_CENTS,
  copiesOf,
  pendingReasonsOf,
  reId,
  refundObject,
  refundedThenFailed,
  seedOperation,
  seedRefundLot,
  type LotState,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useInternalApp("internal-api-refund-preview-test");

/**
 * A lot in `state` whose payment Stripe knows, with these refunds on it.
 * @param state - Where the lot stands.
 * @param refunds - What Stripe holds for the payment.
 * @returns The lot.
 */
async function lotOnStripe(state: LotState, refunds: FakeRefundInput[] = []): Promise<SeededLot> {
  const lot = await seedRefundLot(suite.sql, state);
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS, refunds);
  return lot;
}

/**
 * The preview of a lot.
 * @param lot - The lot.
 * @returns The answer.
 */
function preview(lot: SeededLot) {
  return call(suite.baseUrl, paths.preview(lot.lotId));
}

describe("preview: refunds[].pendingReason (v9 §5.1)", () => {
  it("gives each pending refund Stripe's reason and every other refund null, and the copies store the same", async () => {
    const short = reId("short");
    const charge = reId("charge");
    const plain = reId("plain");
    const done = reId("done");
    const lot = await lotOnStripe("refund_pending", [
      refundObject(short, "pending", 300, undefined, "insufficient_funds"),
      refundObject(charge, "pending", 200, undefined, "charge_pending"),
      refundObject(plain, "pending", 100, undefined, "processing"),
      refundObject(done, "succeeded", 50),
    ]);

    const res = await preview(lot);

    expect(res.status).toBe(200);
    const byId = new Map((res.json.refunds as { stripeRefundId: string; pendingReason: unknown }[]).map((r) => [r.stripeRefundId, r.pendingReason]));
    expect(Object.fromEntries(byId)).toEqual({
      [short]: "insufficient_funds",
      [charge]: "charge_pending",
      [plain]: "processing",
      [done]: null,
    });
    expect(await pendingReasonsOf(suite.sql, lot.lotId)).toEqual({
      [short]: "insufficient_funds",
      [charge]: "charge_pending",
      [plain]: "processing",
      [done]: null,
    });
    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "blocked", code: "stripe_blocks", reason: "refund_in_progress" });
  });

  it("a pending_reason outside Stripe's documented three is read and stored as processing (decision 5)", async () => {
    const odd = reId("odd");
    // Stripe's raw answer, not the product's normalized refund shape.
    const raw: FakeRefundInput = { ...refundObject(odd, "pending", 300), pending_reason: "some_future_reason" };
    const lot = await lotOnStripe("refund_pending", [raw]);

    const res = await preview(lot);

    expect(res.status).toBe(200);
    expect(res.json.refunds).toEqual([expect.objectContaining({ stripeRefundId: odd, pendingReason: "processing" })]);
    expect((await pendingReasonsOf(suite.sql, lot.lotId))[odd]).toBe("processing");
  });
});

describe("preview: disputed (v9 §4.5, §5.3)", () => {
  it("reads the charge once with latest_charge expanded; false when the charge has no dispute", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await preview(lot);

    expect(res.status).toBe(200);
    expect(res.json.disputed).toBe(false);
    expect(fakeStripe.retrieveCalls).toEqual([
      expect.objectContaining({ id: lot.paymentIntentId, params: { expand: ["latest_charge"] } }),
    ]);
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("true when the charge is disputed, and restoreCredits is then blocked by disputed", async () => {
    const { lot } = await refundedThenFailed(suite.sql, fakeStripe);
    fakeStripe.setDisputed(lot.paymentIntentId, true);

    const res = await preview(lot);

    expect(res.status).toBe(200);
    expect(res.json.disputed).toBe(true);
    expect(res.json.restoreCredits).toMatchObject({ outcome: "blocked", code: "stripe_blocks", reason: "disputed" });
  });

  it("a failed charge read is 503 stripe_unavailable; the refunds the list read are still copied", async () => {
    const external = reId("ext");
    const lot = await lotOnStripe("refund_pending", [refundObject(external, "succeeded", 300)]);
    fakeStripe.failRetrieves(stripeError(500));

    const res = await preview(lot);

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: external, status: "succeeded", ever_succeeded: true }),
    ]);
  });
});

describe("preview: refundFailure (v9 §5.3, the view credit_lot_refund_failures)", () => {
  it("false for a lot waiting on a decision with nothing failed", async () => {
    const lot = await lotOnStripe("refund_pending");
    const res = await preview(lot);
    expect(res.status).toBe(200);
    expect(res.json.refundFailure).toBe(false);
  });

  it("true for a refunded lot whose refund failed later", async () => {
    const { lot } = await refundedThenFailed(suite.sql, fakeStripe);
    const res = await preview(lot);
    expect(res.json.refundFailure).toBe(true);
  });

  it("true for a refunding lot Stripe declined though no refund exists, and the preview still judges a retry for it", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined" });

    const res = await preview(lot);

    expect(res.json.refundFailure).toBe(true);
    expect(res.json.unresolvedFailedRefunds).toEqual([]);
    expect(res.json.action).toMatchObject({ kind: "retry", outcome: "create_refund", amountCents: PAID_CENTS });
    expect(res.json.restoreCredits).toMatchObject({ outcome: "allowed" });
  });

  it("false for a refunding lot that stopped on stripe_request_invalid (our configuration, not a refusal)", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_request_invalid" });

    const res = await preview(lot);

    expect(res.json.refundFailure).toBe(false);
  });
});

describe("preview: restoreCredits and action on a refunded lot (v9 §4.5, §5.3)", () => {
  it("a refunded lot whose refund failed: action null, restoreCredits allowed — and the restore with the listed ids goes through", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);

    const res = await preview(lot);

    expect(res.status).toBe(200);
    expect(res.json.action).toBeNull();
    expect(res.json.restoreCredits).toMatchObject({ outcome: "allowed" });
    expect(res.json.unresolvedFailedRefunds).toEqual([expect.objectContaining({ stripeRefundId: failed, amountCents: PAID_CENTS })]);

    const restore = await call(suite.baseUrl, paths.restoreCredits(lot.lotId), {
      body: { reason: "Buyer agreed.", failedRefundIds: res.json.unresolvedFailedRefunds.map((r: { stripeRefundId: string }) => r.stripeRefundId) },
      idempotencyKey: freshKey("restore"),
    });
    expect(restore.status).toBe(200);
    await mailsSettled(suite.sql, lot);
  });

  it("a refunded lot that was resolved outside: restoreCredits blocked by paid_outside", async () => {
    const { lot, failed } = await refundedThenFailed(suite.sql, fakeStripe);
    const outside = await seedOperation(suite.sql, lot, { kind: "resolve_outside", status: "succeeded", result: "resolved_outside", createdSecondsAgo: 60 });
    await suite.sql`UPDATE credit_refunds SET resolved_by_operation_id = ${outside.id} WHERE stripe_refund_id = ${failed}`;

    const res = await preview(lot);

    expect(res.json.restoreCredits).toMatchObject({ outcome: "blocked", code: "stripe_blocks", reason: "paid_outside" });
  });

  it("a refund_pending lot with a failed and a succeeded refund: approve blocked refund_failed, restoreCredits blocked refund_succeeded", async () => {
    const lot = await lotOnStripe("refund_pending", [
      refundObject(reId("gone"), "failed", 300),
      refundObject(reId("done"), "succeeded", 200),
    ]);

    const res = await preview(lot);

    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "blocked", code: "stripe_blocks", reason: "refund_failed" });
    expect(res.json.restoreCredits).toMatchObject({ outcome: "blocked", code: "stripe_blocks", reason: "refund_succeeded" });
    expect(res.json.refundFailure).toBe(true);
  });

  it("a plain refund_pending lot: restoreCredits blocked by lot_state_changed (nothing failed)", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await preview(lot);

    expect(res.json.restoreCredits).toMatchObject({ outcome: "blocked", code: "lot_state_changed" });
  });
});
