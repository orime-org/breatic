// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal endpoints that finish in one transaction — reject, settle,
 * send-back, resolved-outside — and the mail resend (inner#1410 §5.3, §6.5,
 * §8, acceptance #5, #11, #13), driven over a real socket with signed
 * requests, against real Postgres and Redis and a stateful fake Stripe.
 *
 * None of them creates anything on Stripe: each reads `refunds.list` first
 * (a failed read is 503 and stores nothing), then in one transaction writes
 * the copies, re-checks against them and inserts the disposition already
 * `succeeded`. Who is told follows §5.1's `notify` column: reject always,
 * settle as asked, send-back and resolved-outside never.
 *
 * Mail outbox snapshot asserted here: `{ id, operationId, kind, origin,
 * status, requestedBy, reason }`.
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

import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import { ADMIN, call, errorShape, freshKey, paths, useInternalApp } from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  bellsOf,
  copiesOf,
  ledgerOf,
  mailsOf,
  readLot,
  readOp,
  reId,
  refundObject,
  seedCopy,
  seedOperation,
  seedRefundLot,
  worldOf,
  type LotState,
  type RefundFixture,
  type SeededLot,
  type WorldState,
} from "./credit-refund-fixtures.js";

const suite = useInternalApp("internal-api-one-shot-test");

const MAIL_STATUSES_AFTER_FINISH = ["pending", "sending", "skipped"];
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000bb";

/**
 * A lot in `state` whose payment Stripe knows, with these refunds on it.
 * @param state - Where the lot stands.
 * @param refunds - What Stripe already holds for the payment.
 * @returns The lot.
 */
async function lotOnStripe(state: LotState, refunds: RefundFixture[] = []): Promise<SeededLot> {
  const lot = await seedRefundLot(suite.sql, state);
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS, refunds);
  return lot;
}

/**
 * Send a signed POST with a fresh (or given) idempotency key.
 * @param path - The endpoint.
 * @param body - JSON body.
 * @param key - Idempotency key.
 * @returns The answer.
 */
function post(path: string, body: unknown, key: string = freshKey()) {
  return call(suite.baseUrl, path, { body, idempotencyKey: key });
}

/**
 * Everything but the refund copies.
 * @param w - The world.
 * @returns The world without copies.
 */
function exceptCopies(w: WorldState): Omit<WorldState, "copies"> {
  const { copies: _copies, ...rest } = w;
  return rest;
}

/**
 * Assert a 409 that stored nothing but (perhaps) the copies it read.
 * @param res - The answer.
 * @param lot - The lot.
 * @param before - The world before.
 * @param code - Expected code.
 */
async function expectRefused(
  res: Awaited<ReturnType<typeof post>>,
  lot: SeededLot,
  before: WorldState,
  code: string,
): Promise<void> {
  expect(res.status).toBe(409);
  expect(res.json.code).toBe(code);
  expect(errorShape(res.json).detailTranslated).toBe(true);
  expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
  expect(fakeStripe.createCalls).toEqual([]);
}

describe("POST …/refund/reject", () => {
  const body = { reason: "Credits were used before the request." };

  it("returns the lot to active, counts the attempt, writes the zero rejected row, the bell and the auto mail; never creates a refund", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await post(paths.reject(lot.lotId), body);

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({
      lotId: lot.lotId,
      kind: "reject",
      status: "succeeded",
      result: "rejected",
      notify: true,
      requestedBy: ADMIN,
      reason: body.reason,
    });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "active", remaining: `${CREDITS}.000000`, attempts: 1 });
    const ledger = await ledgerOf(suite.sql, lot.lotId);
    expect(ledger.filter((r) => r.entry_type === "refund_rejected")).toEqual([
      { entry_type: "refund_rejected", amount: "0.000000", reference_id: opId },
    ]);
    const bells = await bellsOf(suite.sql, lot.userId);
    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({ type: "credit.refund_rejected", expires_at: null });
    expect(bells[0]!.payload.lotId).toBe(lot.lotId);
    const mails = await mailsOf(suite.sql, lot.lotId);
    expect(mails).toEqual([
      expect.objectContaining({ operation_id: opId, kind: "refund_rejected", origin: "auto", requested_by: null, idempotency_key: null }),
    ]);
    expect(MAIL_STATUSES_AFTER_FINISH).toContain(mails[0]!.status);
    expect(fakeStripe.listCalls).toEqual([expect.objectContaining({ payment_intent: lot.paymentIntentId })]);
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it.each([
    ["a succeeded refund", "succeeded"],
    ["a processing refund", "pending"],
    ["a refund needing action", "requires_action"],
  ] as const)("Stripe holding %s is 409 stripe_blocks", async (_name, status) => {
    const lot = await lotOnStripe("refund_pending", [refundObject(reId("x"), status, 300)]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.reject(lot.lotId), body);

    await expectRefused(res, lot, before, "stripe_blocks");
  });

  it("a refunding lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "partial_refund" });
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await post(paths.reject(lot.lotId), body), lot, before, "lot_state_changed");
  });

  it("a failed Stripe read is 503 stripe_unavailable and writes nothing", async () => {
    const lot = await lotOnStripe("refund_pending");
    const before = await worldOf(suite.sql, lot);
    fakeStripe.failLists(stripeError(500));

    const res = await post(paths.reject(lot.lotId), body);

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });

  it("an unknown lot is 404 not_found", async () => {
    const res = await post(paths.reject(UNKNOWN_ID), body);

    expect(res.status).toBe(404);
    expect(errorShape(res.json)).toEqual({ code: "not_found", reason: undefined, detailTranslated: true });
  });
});

describe("POST …/refund/settle", () => {
  /**
   * A refunding lot whose approval stopped at a partial refund: the
   * product's refund of 500 succeeded, the rest never happened.
   * @returns The lot, the stuck disposition and its refund.
   */
  async function partiallyRefunded() {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const own = reId("own");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "partial_refund",
      stripeRefundId: own,
      createdSecondsAgo: 60,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", 500, stuck.id)]);
    return { lot, stuck, own };
  }

  it("accepting a partial refund with notify false: books on the product's refund, records both sums, closes the attention, tells nobody", async () => {
    const { lot, stuck, own } = await partiallyRefunded();

    const res = await post(paths.settle(lot.lotId), {
      reason: "Buyer agreed to a partial refund.",
      notify: false,
      confirmedSucceededCents: 500,
      acceptPartial: true,
    });

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "settle", status: "succeeded", result: "refunded", notify: false });
    expect(await readOp(suite.sql, opId)).toMatchObject({ settled_succeeded_cents: 500, confirmed_succeeded_cents: 500 });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: own },
    ]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    const closed = await readOp(suite.sql, stuck.id);
    expect(closed.attention_closed_by).toBe(opId);
    expect(typeof closed.attention_closed_at).toBe("string");
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("a full refund made outside the product, on a refund_pending lot, with notify true: books on it and tells the buyer", async () => {
    const outside = reId("dash");
    const lot = await lotOnStripe("refund_pending", [refundObject(outside, "succeeded", PAID_CENTS)]);

    const res = await post(paths.settle(lot.lotId), {
      reason: "Refunded from the Stripe dashboard.",
      notify: true,
      confirmedSucceededCents: PAID_CENTS,
      acceptPartial: false,
    });

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "settle", status: "succeeded", result: "refunded", notify: true });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: outside },
    ]);
    const bells = await bellsOf(suite.sql, lot.userId);
    expect(bells.map((b) => b.type)).toEqual(["credit.refund_completed"]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ operation_id: opId, kind: "refund_completed", origin: "auto" }),
    ]);
  });

  it("a partial refund without acceptPartial is 409 stripe_blocks", async () => {
    const { lot } = await partiallyRefunded();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 500, acceptPartial: false });

    await expectRefused(res, lot, before, "stripe_blocks");
  });

  it("a confirmed sum that no longer matches Stripe is 409 stripe_blocks", async () => {
    const { lot } = await partiallyRefunded();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 400, acceptPartial: true });

    await expectRefused(res, lot, before, "stripe_blocks");
  });

  it("nothing succeeded on Stripe is 409 stripe_blocks even with acceptPartial", async () => {
    const lot = await lotOnStripe("refund_pending");
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 0, acceptPartial: true });

    await expectRefused(res, lot, before, "stripe_blocks");
  });

  it("a refund still processing is 409 stripe_blocks", async () => {
    const { lot } = await partiallyRefunded();
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(reId("pend"), "pending", 580),
    ]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 500, acceptPartial: true });

    await expectRefused(res, lot, before, "stripe_blocks");
  });

  it("a disposition still in flight is 409 operation_in_progress", async () => {
    const lot = await lotOnStripe("refunding", [refundObject(reId("full"), "succeeded", PAID_CENTS)]);
    await seedOperation(suite.sql, lot, { kind: "approve", status: "awaiting_stripe" });
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: true, confirmedSucceededCents: PAID_CENTS, acceptPartial: false });

    await expectRefused(res, lot, before, "operation_in_progress");
  });

  it("an active lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("active", [refundObject(reId("full"), "succeeded", PAID_CENTS)]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: true, confirmedSucceededCents: PAID_CENTS, acceptPartial: false });

    await expectRefused(res, lot, before, "lot_state_changed");
  });

  it("a body missing acceptPartial is 422 invalid_body", async () => {
    const { lot } = await partiallyRefunded();

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 500 });

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_body");
  });
});

describe("POST …/refund/send-back", () => {
  const body = { reason: "Stripe has no refund for it; back to the queue." };

  it("a refunding lot with nothing refunded on Stripe goes back to refund_pending; the attention is closed; nobody is told", async () => {
    const lot = await lotOnStripe("refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_result_unknown",
      createdSecondsAgo: 60,
    });
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

    const res = await post(paths.sendBack(lot.lotId), body);

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "send_back", status: "succeeded", result: "sent_back", notify: false });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refund_pending", remaining: `${CREDITS}.000000`, attempts: 0 });
    expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect((await readOp(suite.sql, stuck.id)).attention_closed_by).toBe(opId);
  });

  it.each([
    ["a succeeded refund", "succeeded"],
    ["a processing refund", "pending"],
  ] as const)("Stripe holding %s is 409 stripe_blocks", async (_name, status) => {
    const lot = await lotOnStripe("refunding", [refundObject(reId("x"), status, 300)]);
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_result_unknown" });
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await post(paths.sendBack(lot.lotId), body), lot, before, "stripe_blocks");
  });

  it("a refund_pending lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("refund_pending");
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await post(paths.sendBack(lot.lotId), body), lot, before, "lot_state_changed");
  });

  it("a disposition still in flight is 409 operation_in_progress", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
    const before = await worldOf(suite.sql, lot);

    await expectRefused(await post(paths.sendBack(lot.lotId), body), lot, before, "operation_in_progress");
  });
});

describe("POST …/refund/resolved-outside", () => {
  /**
   * A refunded lot whose product refund later failed on Stripe.
   * @returns The lot and the failed refund's id.
   */
  async function refundedThenFailed() {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "succeeded", result: "refunded", createdSecondsAgo: 120 });
    const failed = reId("failed");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: PAID_CENTS, status: "succeeded", operationId: approve.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", PAID_CENTS, approve.id)]);
    return { lot, failed };
  }

  it("answers for the failed refund, moves neither lot nor ledger, tells nobody, creates nothing", async () => {
    const { lot, failed } = await refundedThenFailed();
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "Paid back by bank transfer.", failedRefundIds: [failed] });

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "resolve_outside", status: "succeeded", result: "resolved_outside", notify: false });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: failed, status: "failed", ever_succeeded: true, resolved_by_operation_id: opId }),
    ]);
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("failedRefundIds that differ from the unresolved set is 409 stripe_blocks failed_refunds_changed", async () => {
    const { lot } = await refundedThenFailed();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [reId("other")] });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("failed_refunds_changed");
  });

  it("a refund still processing on Stripe is 409 stripe_blocks", async () => {
    const { lot, failed } = await refundedThenFailed();
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(reId("pend"), "pending", 100),
    ]);
    const before = await worldOf(suite.sql, lot);

    await expectRefused(
      await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [failed] }),
      lot,
      before,
      "stripe_blocks",
    );
  });

  it("a refund_pending lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("refund_pending");
    const before = await worldOf(suite.sql, lot);

    await expectRefused(
      await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [] }),
      lot,
      before,
      "lot_state_changed",
    );
  });
});

describe("POST /internal/v1/refund-operations/:operationId/mail/resend (§6.5)", () => {
  it("after a rejection: inserts a new resend row beside the auto one and answers its snapshot", async () => {
    const lot = await lotOnStripe("refund_pending");
    const rejected = await post(paths.reject(lot.lotId), { reason: "No." });
    expect(rejected.status).toBe(200);
    const opId: string = rejected.json.id;
    const key = freshKey("resend");

    const res = await post(paths.resend(opId), { reason: "Buyer says it never arrived." }, key);

    expect([200, 202]).toContain(res.status);
    expect(res.status).toBe(["pending", "sending"].includes(res.json.status) ? 202 : 200);
    expect(res.json).toMatchObject({
      operationId: opId,
      kind: "refund_rejected",
      origin: "resend",
      requestedBy: ADMIN,
      reason: "Buyer says it never arrived.",
    });
    const mails = await mailsOf(suite.sql, lot.lotId);
    expect(mails.map((m) => [m.origin, m.kind, m.requested_by, m.idempotency_key])).toEqual([
      ["auto", "refund_rejected", null, null],
      ["resend", "refund_rejected", ADMIN, key],
    ]);
  });

  it("a disposition finished refunded without notifying may still be resent: the mail is refund_completed", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const settled = await seedOperation(suite.sql, lot, { kind: "settle", status: "succeeded", result: "refunded", notify: false });

    const res = await post(paths.resend(settled.id), { reason: "Buyer asked for a receipt." });

    expect([200, 202]).toContain(res.status);
    expect(res.json).toMatchObject({ operationId: settled.id, kind: "refund_completed", origin: "resend" });
    expect((await mailsOf(suite.sql, lot.lotId)).map((m) => m.origin)).toEqual(["resend"]);
  });

  it.each([
    ["sent_back", { kind: "approve", status: "succeeded", result: "sent_back" }],
    ["resolved_outside", { kind: "resolve_outside", status: "succeeded", result: "resolved_outside" }],
    ["needs_attention", { kind: "approve", status: "needs_attention", attentionReason: "partial_refund" }],
    ["awaiting_stripe", { kind: "approve", status: "awaiting_stripe" }],
  ] as const)("a disposition that is %s is 409 mail_not_resendable and inserts nothing", async (_name, op) => {
    const lot = await seedRefundLot(suite.sql, op.kind === "resolve_outside" ? "refunded" : "refunding");
    const seeded = await seedOperation(suite.sql, lot, op);

    const res = await post(paths.resend(seeded.id), { reason: "r" });

    expect(res.status).toBe(409);
    expect(errorShape(res.json)).toEqual({ code: "mail_not_resendable", reason: undefined, detailTranslated: true });
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("an unknown disposition is 404 not_found", async () => {
    const res = await post(paths.resend(UNKNOWN_ID), { reason: "r" });

    expect(res.status).toBe(404);
    expect(errorShape(res.json)).toEqual({ code: "not_found", reason: undefined, detailTranslated: true });
  });

  it("a resend without a reason is 422 invalid_body", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const settled = await seedOperation(suite.sql, lot, { kind: "settle", status: "succeeded", result: "refunded" });

    const res = await post(paths.resend(settled.id), {});

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_body");
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });
});
