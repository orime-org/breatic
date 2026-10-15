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
 * `succeeded`. A request refused at its preconditions still keeps the copies
 * of what it read (v6 §4.6, §6.4), and a copy that reached `failed` or
 * `canceled` keeps that status whatever an older read says. Settle and
 * resolved-outside carry `confirmedSucceededCents`, the succeeded sum the
 * operator saw, and are refused when Stripe's differs; settle is also
 * refused when that sum is below what was paid (v9 §5.3: only whole
 * refunds, no acceptPartial). Reject is refused while a failed refund is
 * unanswered, send-back once Stripe declined the lot (v9 §5.3). The
 * restore-credits endpoint is in `internal-api-restore-credits.integration.test.ts`.
 * Who is told follows §5.1's `notify` column: reject always,
 * settle as asked, send-back and resolved-outside never. Resolved-outside on
 * a `refund_pending` or `refunding` lot books it (§5.3, §5.5); on a
 * `refunded` lot it only answers for the failed refunds.
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
import {
  ADMIN,
  call,
  errorShape,
  expectRefusedAroundInFlight,
  freshKey,
  holdersOf,
  paths,
  useInternalApp,
} from "./internal-api-harness.js";
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
  refundedThenFailed,
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

  it.each(["failed", "canceled"] as const)(
    "an unresolved %s refund on Stripe is 409 stripe_blocks refund_failed: the exits are restore-credits or resolved-outside (v9 §5.3)",
    async (status) => {
      const lot = await lotOnStripe("refund_pending", [refundObject(reId("gone"), status, 300)]);
      const before = await worldOf(suite.sql, lot);

      const res = await post(paths.reject(lot.lotId), body);

      await expectRefused(res, lot, before, "stripe_blocks");
      expect(res.json.reason).toBe("refund_failed");
    },
  );

  it("a succeeded refund is answered before an unresolved failed one (v9 §5.3 check order): 409 stripe_blocks refund_succeeded", async () => {
    const lot = await lotOnStripe("refund_pending", [
      refundObject(reId("done"), "succeeded", 300),
      refundObject(reId("gone"), "failed", 200),
    ]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.reject(lot.lotId), body);

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("refund_succeeded");
  });

  it("a failed refund already answered for does not block: the rejection goes through", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const resolver = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      createdSecondsAgo: 600,
    });
    const answered = reId("answered");
    await seedCopy(suite.sql, lot, { id: answered, amountCents: 300, status: "failed", resolvedBy: resolver.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(answered, "failed", 300)]);

    const res = await post(paths.reject(lot.lotId), body);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: "reject", result: "rejected" });
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

  it("the product's 500 plus an external 580 cover the payment, notify false: books on the product's refund, records both sums, closes the attention, tells nobody", async () => {
    const { lot, stuck, own } = await partiallyRefunded();
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(reId("ext_rest"), "succeeded", PAID_CENTS - 500),
    ]);

    const res = await post(paths.settle(lot.lotId), {
      reason: "The rest was refunded from the dashboard.",
      notify: false,
      confirmedSucceededCents: PAID_CENTS,
    });

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "settle", status: "succeeded", result: "refunded", notify: false });
    expect(await readOp(suite.sql, opId)).toMatchObject({ settled_succeeded_cents: PAID_CENTS, confirmed_succeeded_cents: PAID_CENTS });
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

  it("a succeeded sum below what was paid is 409 stripe_blocks succeeded_below_paid (v9 §5.3: only whole refunds)", async () => {
    const { lot } = await partiallyRefunded();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 500 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_below_paid");
  });

  it("a confirmed sum that no longer matches Stripe is 409 stripe_blocks succeeded_sum_changed, checked before the paid amount", async () => {
    const { lot } = await partiallyRefunded();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 400 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_sum_changed");
  });

  it("nothing succeeded on Stripe is 409 stripe_blocks succeeded_below_paid", async () => {
    const lot = await lotOnStripe("refund_pending");
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 0 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_below_paid");
  });

  it("a refund still processing is 409 stripe_blocks", async () => {
    const { lot } = await partiallyRefunded();
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(reId("pend"), "pending", 580),
    ]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 500 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("refund_in_progress");
  });

  it("a disposition still in flight is 409 operation_in_progress", async () => {
    const lot = await lotOnStripe("refunding", [refundObject(reId("full"), "succeeded", PAID_CENTS)]);
    const inFlight = await seedOperation(suite.sql, lot, { kind: "approve", status: "awaiting_stripe" });
    const before = await worldOf(suite.sql, lot);
    const key = freshKey();

    const res = await post(
      paths.settle(lot.lotId),
      { reason: "r", notify: true, confirmedSucceededCents: PAID_CENTS },
      key,
    );

    await expectRefusedAroundInFlight(suite.sql, res, lot, before, inFlight.id, key);
  });

  it("an active lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("active", [refundObject(reId("full"), "succeeded", PAID_CENTS)]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), { reason: "r", notify: true, confirmedSucceededCents: PAID_CENTS });

    await expectRefused(res, lot, before, "lot_state_changed");
  });

  it("a refused settle still copies the refunds it read: a succeeded external refund keeps ever_succeeded; no disposition, no key (v6 §4.6)", async () => {
    const { lot } = await partiallyRefunded();
    const external = reId("ext_seen_once");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(external, "succeeded", 80),
    ]);
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("settle");

    const res = await post(
      paths.settle(lot.lotId),
      { reason: "r", notify: false, confirmedSucceededCents: 580 },
      key,
    );

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_below_paid");
    expect((await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === external)).toMatchObject({
      operation_id: null,
      status: "succeeded",
      ever_succeeded: true,
    });
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
  });

  it("a read older than the copy cannot turn a failed refund back to succeeded: settle on the old sum is 409 succeeded_sum_changed, nothing booked (v6 §6.4, finding [13])", async () => {
    // The product already saw the approval's refund fail (the copy says so);
    // this settle's own read is older and still lists it as succeeded.
    const lot = await seedRefundLot(suite.sql, "refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_refund_failed_later",
      createdSecondsAgo: 60,
    });
    const own = reId("failed_since");
    await seedCopy(suite.sql, lot, { id: own, amountCents: PAID_CENTS, status: "failed", everSucceeded: true, operationId: stuck.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, stuck.id)]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.settle(lot.lotId), {
      reason: "Stripe shows it refunded.",
      notify: true,
      confirmedSucceededCents: PAID_CENTS,
    });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_sum_changed");
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: own, status: "failed", ever_succeeded: true }),
    ]);
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunding", remaining: `${CREDITS}.000000`, attempts: 0 });
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
  });

  it.each([true, false])(
    "a body carrying acceptPartial (%s) is 422 invalid_body: the field is gone and the body is strict (v9 §4.5)",
    async (acceptPartial) => {
      const { lot } = await partiallyRefunded();
      const before = await worldOf(suite.sql, lot);

      const res = await post(paths.settle(lot.lotId), { reason: "r", notify: false, confirmedSucceededCents: 500, acceptPartial });

      expect(res.status).toBe(422);
      expect(res.json.code).toBe("invalid_body");
      expect(await worldOf(suite.sql, lot)).toEqual(before);
    },
  );
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

  it("a lot Stripe declined is 409 stripe_blocks stripe_declined: a rejection would contradict the approval (v9 §5.3)", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined" });
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.sendBack(lot.lotId), body);

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("stripe_declined");
  });

  it("Stripe declined the approval, then a retry ran out of attempts: still 409 stripe_blocks stripe_declined — the history counts, not the latest reason", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      createdSecondsAgo: 900,
    });
    await seedOperation(suite.sql, lot, {
      kind: "retry",
      status: "needs_attention",
      attentionReason: "attempts_exhausted",
      createdSecondsAgo: 60,
    });
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.sendBack(lot.lotId), body);

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("stripe_declined");
  });

  it("after stripe_request_invalid (our configuration, not Stripe declining) send-back is allowed", async () => {
    const lot = await lotOnStripe("refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_request_invalid",
      createdSecondsAgo: 60,
    });

    const res = await post(paths.sendBack(lot.lotId), body);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: "send_back", status: "succeeded", result: "sent_back" });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refund_pending", remaining: `${CREDITS}.000000`, attempts: 0 });
    expect((await readOp(suite.sql, stuck.id)).attention_closed_by).toBe(res.json.id);
  });
});

describe("POST …/refund/resolved-outside", () => {
  /** A refunded lot whose product refund later failed on Stripe. */
  const failedLater = () => refundedThenFailed(suite.sql, fakeStripe, { label: "failed", createdSecondsAgo: 120 });

  it("answers for the failed refund, moves neither lot nor ledger, tells nobody, creates nothing", async () => {
    const { lot, failed } = await failedLater();
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "Paid back by bank transfer.", failedRefundIds: [failed], confirmedSucceededCents: 0 });

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
    const { lot } = await failedLater();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [reId("other")], confirmedSucceededCents: 0 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("failed_refunds_changed");
  });

  it("a refused request (failed_refunds_changed) still copies the succeeded refund it read; no disposition, no key (v6 §4.6, finding [2])", async () => {
    const { lot } = await failedLater();
    const external = reId("dash_unseen");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(external, "succeeded", 700),
    ]);
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("outside");

    const res = await post(
      paths.resolvedOutside(lot.lotId),
      { reason: "r", failedRefundIds: [reId("stale")], confirmedSucceededCents: 0 },
      key,
    );

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("failed_refunds_changed");
    expect((await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === external)).toMatchObject({
      operation_id: null,
      status: "succeeded",
      ever_succeeded: true,
    });
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
  });

  it("a body without confirmedSucceededCents is 422 invalid_body (v6 §4.5)", async () => {
    const { lot, failed } = await failedLater();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [failed] });

    expect(res.status).toBe(422);
    expect(res.json.code).toBe("invalid_body");
    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });

  it("a confirmed sum that differs from Stripe's succeeded sum is 409 stripe_blocks succeeded_sum_changed", async () => {
    const { lot, failed } = await failedLater();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [failed], confirmedSucceededCents: 1 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_sum_changed");
  });

  it("a refund still processing on Stripe is 409 stripe_blocks", async () => {
    const { lot, failed } = await failedLater();
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(reId("pend"), "pending", 100),
    ]);
    const before = await worldOf(suite.sql, lot);

    await expectRefused(
      await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [failed], confirmedSucceededCents: 0 }),
      lot,
      before,
      "stripe_blocks",
    );
  });

  it("an active lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("active");
    const before = await worldOf(suite.sql, lot);

    await expectRefused(
      await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [], confirmedSucceededCents: 0 }),
      lot,
      before,
      "lot_state_changed",
    );
  });
});

describe("POST …/refund/resolved-outside on a lot not yet refunded (§5.3: it books the lot)", () => {
  /**
   * The lot booked by the resolve_outside disposition: refunded, nothing
   * left, one refund ledger row on `referenceId`, the succeeded sum recorded,
   * nobody told, nothing created on Stripe.
   * @param lot - The lot.
   * @param opId - The disposition.
   * @param referenceId - The ledger row's reference.
   * @param settledCents - `settled_succeeded_cents`.
   */
  async function expectResolvedAndBooked(lot: SeededLot, opId: string, referenceId: string, settledCents: number) {
    expect(await readOp(suite.sql, opId)).toMatchObject({
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      notify: false,
      settled_succeeded_cents: settledCents,
    });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: referenceId },
    ]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(fakeStripe.createCalls).toEqual([]);
  }

  /**
   * A refunding lot whose approval's refund succeeded on Stripe, then failed
   * (the copy remembers it succeeded), and the approval waits on a person.
   * @returns The lot, the open approval, and its failed refund.
   */
  async function refundingWithFailedRefund() {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_refund_failed_later",
      createdSecondsAgo: 120,
    });
    const failed = reId("failed_own");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: PAID_CENTS, status: "succeeded", operationId: stuck.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", PAID_CENTS, stuck.id)]);
    return { lot, stuck, failed };
  }

  it("a refund_pending lot with nothing on Stripe and an empty list: 200 resolved_outside, booked on the disposition itself", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "Paid back by bank transfer.", failedRefundIds: [], confirmedSucceededCents: 0 });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: "resolve_outside", status: "succeeded", result: "resolved_outside", notify: false });
    await expectResolvedAndBooked(lot, res.json.id, res.json.id, 0);
  });

  it("a refunding lot whose refund failed: answers for it, books on the disposition itself, closes the attention", async () => {
    const { lot, stuck, failed } = await refundingWithFailedRefund();

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "Paid back by bank transfer.", failedRefundIds: [failed], confirmedSucceededCents: 0 });

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    await expectResolvedAndBooked(lot, opId, opId, 0);
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: failed, status: "failed", ever_succeeded: true, resolved_by_operation_id: opId }),
    ]);
    expect((await readOp(suite.sql, stuck.id)).attention_closed_by).toBe(opId);
  });

  it("a refund_pending lot partly refunded outside the product: books on the largest succeeded refund with the succeeded sum", async () => {
    const small = reId("small");
    const big = reId("big");
    const lot = await lotOnStripe("refund_pending", [
      refundObject(small, "succeeded", 200),
      refundObject(big, "succeeded", 300),
    ]);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "Rest paid by bank transfer.", failedRefundIds: [], confirmedSucceededCents: 500 });

    expect(res.status).toBe(200);
    await expectResolvedAndBooked(lot, res.json.id, big, 500);
  });

  it("a refunding lot with its failed refund left out of the request is 409 stripe_blocks failed_refunds_changed", async () => {
    const { lot } = await refundingWithFailedRefund();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [], confirmedSucceededCents: 0 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("failed_refunds_changed");
  });

  it("a refund that succeeded on Stripe after the confirmation page is 409 succeeded_sum_changed: not booked, the refund copied (v6 §5.3, finding [8])", async () => {
    // The approval ran out of attempts after a create that timed out; that
    // create completed on Stripe after the operator looked.
    const lot = await seedRefundLot(suite.sql, "refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "attempts_exhausted",
      createdSecondsAgo: 120,
    });
    const late = reId("late_create");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(late, "succeeded", PAID_CENTS, stuck.id)]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), {
      reason: "Paid back by bank transfer.",
      failedRefundIds: [],
      confirmedSucceededCents: 0,
    });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("succeeded_sum_changed");
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunding", remaining: `${CREDITS}.000000`, attempts: 0 });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: late, operation_id: stuck.id, status: "succeeded", ever_succeeded: true }),
    ]);
  });

  it.each(["refund_pending", "refunding"] as const)(
    "a %s lot whose confirmed sum matches books it (the sum is the one the operator saw)",
    async (state) => {
      const seen = reId("seen");
      const lot = await lotOnStripe(state, [refundObject(seen, "succeeded", 400)]);
      if (state === "refunding") {
        await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "partial_refund" });
      }

      const res = await post(paths.resolvedOutside(lot.lotId), {
        reason: "Rest paid by bank transfer.",
        failedRefundIds: [],
        confirmedSucceededCents: 400,
      });

      expect(res.status).toBe(200);
      await expectResolvedAndBooked(lot, res.json.id, seen, 400);
      expect((await readOp(suite.sql, res.json.id)).confirmed_succeeded_cents).toBe(400);
    },
  );

  it("a refunding lot with a refund still processing is 409 stripe_blocks refund_in_progress", async () => {
    const lot = await lotOnStripe("refunding", [refundObject(reId("pend"), "pending", 100)]);
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "partial_refund" });
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [], confirmedSucceededCents: 0 });

    await expectRefused(res, lot, before, "stripe_blocks");
    expect(res.json.reason).toBe("refund_in_progress");
  });

  it("a refunding lot with a disposition still in flight is 409 operation_in_progress", async () => {
    const lot = await lotOnStripe("refunding");
    const inFlight = await seedOperation(suite.sql, lot, { kind: "approve", status: "awaiting_stripe" });
    const before = await worldOf(suite.sql, lot);
    const key = freshKey();

    const res = await post(paths.resolvedOutside(lot.lotId), { reason: "r", failedRefundIds: [], confirmedSucceededCents: 0 }, key);

    await expectRefusedAroundInFlight(suite.sql, res, lot, before, inFlight.id, key);
  });
});

describe("settle after a refund had failed (§5.5, finding [7])", () => {
  it("the failed refund is answered for by the settle: the preview lists none, and restore-credits on the refunded lot is 409 lot_state_changed", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_refund_failed_later",
      createdSecondsAgo: 120,
    });
    const failed = reId("approve_failed");
    const external = reId("ext_whole");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: 680, status: "succeeded", operationId: stuck.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      refundObject(failed, "failed", 680, stuck.id),
      refundObject(external, "succeeded", PAID_CENTS),
    ]);

    const settled = await post(paths.settle(lot.lotId), {
      reason: "The whole payment was refunded from the dashboard.",
      notify: false,
      confirmedSucceededCents: PAID_CENTS,
    });
    expect(settled.status).toBe(200);
    const settleId: string = settled.json.id;
    expect((await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failed)).toMatchObject({
      status: "failed",
      ever_succeeded: true,
      resolved_by_operation_id: settleId,
    });

    const preview = await call(suite.baseUrl, paths.preview(lot.lotId));
    expect(preview.status).toBe(200);
    expect(preview.json.unresolvedFailedRefunds).toEqual([]);
    expect(preview.json.action).toBeNull();

    const restore = await post(paths.restoreCredits(lot.lotId), { reason: "r", failedRefundIds: [failed] });
    expect(restore.status).toBe(409);
    expect(errorShape(restore.json)).toEqual({ code: "lot_state_changed", reason: undefined, detailTranslated: true });
    expect(fakeStripe.createCalls).toEqual([]);
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
