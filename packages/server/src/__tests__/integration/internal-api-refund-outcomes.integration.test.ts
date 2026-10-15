// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the buyer and the operator end up with after an approve or a reject
 * driven over the internal API (inner#1410 acceptance #4, #5, #7, #9, #10,
 * #12, #14; design §5.2–§6.2), against real Postgres and Redis and the
 * stateful fake Stripe.
 *
 * The one stand-in besides Stripe: `insertAuto` of the mail outbox can be
 * armed to throw once. It is the last write of a finish, right after the
 * buyer's bell (`afterSucceeded`), so a throw there is a failure of the
 * booking transaction after the bell row was written; the armed call counts
 * the bells its transaction can see before it throws.
 */

import type * as RefundMailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

/** The armed failure: the buyer whose bells to count, and what the armed call saw. */
const injected = vi.hoisted(() => ({ armedFor: null as string | null, bellsSeen: -1 }));

vi.mock("@server/modules/credit-refund/refund-mail.repo.js", async (io) => {
  const actual = await io<typeof RefundMailRepo>();
  const { sql } = await import("drizzle-orm");
  return {
    ...actual,
    insertAuto: async (...args: Parameters<typeof actual.insertAuto>) => {
      const userId = injected.armedFor;
      if (userId === null) return actual.insertAuto(...args);
      injected.armedFor = null;
      const rows = (await args[2].execute(sql`
        SELECT count(*)::int AS n FROM notifications
        WHERE user_id = ${userId} AND type IN ('credit.refund_completed', 'credit.refund_rejected')
      `)) as unknown as { n: number }[];
      injected.bellsSeen = rows[0]!.n;
      throw new Error("injected failure after the bell was written");
    },
  };
});

import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import { call, freshKey, mailsSettled, paths, useInternalApp } from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  bellsOf,
  copiesOf,
  eventsOf,
  expectLeaseReleased,
  ledgerOf,
  mailsOf,
  markReconcileJustFinished,
  parkInFlightOperations,
  readLot,
  readOp,
  reId,
  refundObject,
  seedRefundLot,
  worldOf,
  type LotState,
  type RefundFixture,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useInternalApp("internal-api-refund-outcomes-test");

const APPROVE = { reason: "Within 14 days, unused.", confirmedRefundIds: [] as string[] };
const REJECT = { reason: "Credits were used." };

beforeEach(async () => {
  injected.armedFor = null;
  injected.bellsSeen = -1;
  // The loop scans the whole table: only this case's rows may be due.
  await parkInFlightOperations(suite.sql);
  await markReconcileJustFinished(suite.sql);
});

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
 * The lot untouched by any booking: still holding every credit.
 * @param lot - The lot.
 * @param lifecycle - Where it must stand.
 */
async function expectNotBooked(lot: SeededLot, lifecycle: string): Promise<void> {
  expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle, remaining: `${CREDITS}.000000`, attempts: 0 });
  expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
}

/**
 * Due a disposition's next look now, and end any lease it holds.
 * @param opId - The disposition.
 */
async function dueNow(opId: string): Promise<void> {
  await suite.sql`
    UPDATE credit_refund_operations
    SET next_attempt_at = now() - interval '1 second',
        locked_until = CASE WHEN locked_until IS NULL THEN NULL ELSE now() - interval '1 second' END
    WHERE id = ${opId}
  `;
}

describe("a booking transaction that fails after the bell row is written leaves no trace of the finish (acceptance #4, #5, #13)", () => {
  it("approve: 500; no bell, no ledger row, lot not booked; the loop later books it once on the same refund", async () => {
    const lot = await lotOnStripe("refund_pending");
    injected.armedFor = lot.userId;

    const res = await post(paths.approve(lot.lotId), APPROVE);

    expect(res.status).toBe(500);
    expect(res.json).toEqual({ code: "internal_error" });
    expect(injected.bellsSeen).toBe(1);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    // Phase 1 committed before Stripe was called: refunding, every credit kept.
    await expectNotBooked(lot, "refunding");
    const [op] = await suite.sql<{ id: string; status: string }[]>`
      SELECT id, status FROM credit_refund_operations WHERE lot_id = ${lot.lotId}
    `;
    expect(op!.status).toBe("started");
    expect(fakeStripe.createCalls).toHaveLength(1);

    await dueNow(op!.id);
    await runRefundLoopOnce();

    expect(await readOp(suite.sql, op!.id)).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(fakeStripe.createCalls).toHaveLength(1);
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: created!.id },
    ]);
    expect((await bellsOf(suite.sql, lot.userId)).map((b) => b.type)).toEqual(["credit.refund_completed"]);
    await mailsSettled(suite.sql, lot);
  });

  it("reject: 500; no disposition, no bell, no refund_rejected row, lot still refund_pending; the same key then succeeds", async () => {
    const lot = await lotOnStripe("refund_pending");
    const before = await worldOf(suite.sql, lot);
    const key = freshKey("reject");
    injected.armedFor = lot.userId;

    const res = await post(paths.reject(lot.lotId), REJECT, key);

    expect(res.status).toBe(500);
    expect(res.json).toEqual({ code: "internal_error" });
    expect(injected.bellsSeen).toBe(1);
    expect(await worldOf(suite.sql, lot)).toEqual(before);

    const again = await post(paths.reject(lot.lotId), REJECT, key);

    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ kind: "reject", status: "succeeded", result: "rejected" });
    expect((await bellsOf(suite.sql, lot.userId)).map((b) => b.type)).toEqual(["credit.refund_rejected"]);
    await mailsSettled(suite.sql, lot);
  });
});

describe("Stripe's first definite answer is that it did not refund: a person decides, the lot stays refunding, Stripe's words kept (v9 §6.2, acceptance #9)", () => {
  it("refunds.create answers a canceled refund: 200 needs_attention stripe_declined, lot stays refunding, credits untouched, nobody told", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "refund", status: "canceled" });

    const res = await post(paths.approve(lot.lotId), APPROVE);

    expect(res.status).toBe(200);
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    expect(res.json).toMatchObject({
      kind: "approve",
      status: "needs_attention",
      result: null,
      attentionReason: "stripe_declined",
      stripeRefundId: created!.id,
    });
    await expectNotBooked(lot, "refunding");
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: created!.id, status: "canceled", ever_succeeded: false }),
    ]);
    const events = await eventsOf(suite.sql, res.json.id);
    expect(events.map((e) => e.event)).toEqual(["requested", "refund_declined"]);
    expect(events[1]!.detail).toMatchObject({ refund: { id: created!.id, status: "canceled" }, actor: "request" });
  });

  it("refunds.create refused (first request, 400): the event row and last_error carry Stripe's message, status, type and code", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "error", error: stripeError(400, { code: "amount_too_large" }) });

    const res = await post(paths.approve(lot.lotId), APPROVE);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "needs_attention", attentionReason: "stripe_declined", attentionDetail: "synthetic 400" });
    await expectNotBooked(lot, "refunding");
    // last_error records the refunds.create error (§5.1).
    expect(await readOp(suite.sql, res.json.id)).toMatchObject({ last_error: "synthetic 400" });
    const declined = (await eventsOf(suite.sql, res.json.id)).at(-1)!;
    expect(declined).toMatchObject({
      event: "refund_declined",
      from_status: "started",
      to_status: "needs_attention",
      detail: {
        message: "synthetic 400",
        httpStatus: 400,
        type: "invalid_request_error",
        code: "amount_too_large",
        actor: "request",
      },
    });
  });

  it("refunds.create answers a failed refund: the event row carries the refund id, its status and Stripe's failure reason", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "refund", status: "failed" });

    const res = await post(paths.approve(lot.lotId), APPROVE);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "needs_attention", attentionReason: "stripe_declined" });
    await expectNotBooked(lot, "refunding");
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    expect((await eventsOf(suite.sql, res.json.id)).at(-1)).toMatchObject({
      event: "refund_declined",
      detail: { refund: { id: created!.id, status: "failed", failureReason: "lost_or_stolen_card" } },
    });
  });
});

describe("a refund Stripe first answered pending and later canceled goes to a person (acceptance #10)", () => {
  it("the loop reads it canceled: needs_attention stripe_refund_failed_later, lot stays refunding, credits not added back, nobody told", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "refund", status: "pending" });
    const res = await post(paths.approve(lot.lotId), APPROVE);
    expect(res.status).toBe(202);
    const opId: string = res.json.id;
    const refundId: string = res.json.stripeRefundId;

    fakeStripe.setStatus(refundId, "canceled");
    await dueNow(opId);
    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
      result: null,
      stripe_refund_id: refundId,
    });
    await expectNotBooked(lot, "refunding");
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: refundId, status: "canceled", ever_succeeded: false }),
    ]);
    expect((await eventsOf(suite.sql, opId)).at(-1)).toMatchObject({
      event: "refund_declined",
      from_status: "awaiting_stripe",
      to_status: "needs_attention",
      detail: { refund: { id: refundId, status: "canceled" }, actor: "loop" },
    });
  });
});

describe("a create that ends without an answer is retried under the same key until Stripe answers (acceptance #7)", () => {
  it.each([
    {
      label: "a 409 (the key is in use by a concurrent request)",
      error: () => stripeError(409, { code: "idempotency_key_in_use" }),
    },
    {
      label: "a dropped connection",
      // stripe-node's text for a connection that failed, not a timeout.
      error: () =>
        new Stripe.errors.StripeConnectionError({
          message: "An error occurred with our connection to Stripe. Request was retried 0 times.",
        } as ConstructorParameters<typeof Stripe.errors.StripeConnectionError>[0]),
    },
  ])("$label: 202 started; the loop asks again under credit-refund-<id> with the same parameters and books once", async ({ error }) => {
    const lot = await lotOnStripe("refund_pending");
    const failure = error();
    fakeStripe.nextCreate({ kind: "error", error: failure });

    const res = await post(paths.approve(lot.lotId), APPROVE);

    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ kind: "approve", status: "started", result: null, stripeRefundId: null });
    const opId: string = res.json.id;
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started", attempt_count: 1, last_error: failure.message });
    expect((await eventsOf(suite.sql, opId)).map((e) => e.event)).toEqual(["requested", "retryable_error"]);
    await expectLeaseReleased(suite.sql, opId);
    await expectNotBooked(lot, "refunding");

    await dueNow(opId);
    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(fakeStripe.createCalls).toHaveLength(2);
    expect(fakeStripe.createCalls[1]).toEqual(fakeStripe.createCalls[0]);
    expect(fakeStripe.createCalls[0]!.options).toMatchObject({ idempotencyKey: `credit-refund-${opId}` });
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    expect(fakeStripe.refundsOf(lot.paymentIntentId)).toHaveLength(1);
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: created!.id },
    ]);
    await mailsSettled(suite.sql, lot);
  });
});

describe("the preview lists every refund Stripe holds for the payment (acceptance #12)", () => {
  it("one succeeded partial and one failed: both listed, the failed one unresolved, approve blocked by refund_failed (v9 §5.2)", async () => {
    const partial = reId("partial");
    const failed = reId("failed");
    const lot = await lotOnStripe("refund_pending", [
      refundObject(partial, "succeeded", 300),
      refundObject(failed, "failed", 200),
    ]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.refunds).toHaveLength(2);
    expect(res.json.refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stripeRefundId: partial, amountCents: 300, status: "succeeded", madeByProduct: false }),
        expect.objectContaining({ stripeRefundId: failed, amountCents: 200, status: "failed", madeByProduct: false }),
      ]),
    );
    expect(res.json.unresolvedFailedRefunds).toEqual([expect.objectContaining({ stripeRefundId: failed, amountCents: 200 })]);
    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "blocked", code: "stripe_blocks", reason: "refund_failed" });
  });

  it("three refunds — succeeded, failed, pending — all listed with their statuses; approve blocked while one is processing", async () => {
    const ids = { succeeded: reId("ok"), failed: reId("gone"), pending: reId("pend") };
    const lot = await lotOnStripe("refund_pending", [
      refundObject(ids.succeeded, "succeeded", 300),
      refundObject(ids.failed, "failed", 200),
      refundObject(ids.pending, "pending", 100),
    ]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(
      (res.json.refunds as { stripeRefundId: string; amountCents: number; status: string }[])
        .map((r) => [r.stripeRefundId, r.amountCents, r.status])
        .sort(),
    ).toEqual(
      [
        [ids.succeeded, 300, "succeeded"],
        [ids.failed, 200, "failed"],
        [ids.pending, 100, "pending"],
      ].sort(),
    );
    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "blocked", code: "stripe_blocks", reason: "refund_in_progress" });
  });
});

describe("the event row records Stripe's raw refund for every create answer (acceptance #14)", () => {
  it.each([
    { status: "succeeded" as const, event: "refund_succeeded", http: 200 },
    { status: "pending" as const, event: "refund_pending", http: 202 },
  ])("a $status answer: the $event row carries the refund's id, status, amount and currency", async ({ status, event, http }) => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "refund", status });

    const res = await post(paths.approve(lot.lotId), APPROVE);

    expect(res.status).toBe(http);
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    const events = await eventsOf(suite.sql, res.json.id);
    expect(events.map((e) => e.event)).toEqual(["requested", event]);
    expect(events[1]!.detail).toMatchObject({
      refund: { id: created!.id, status, amount: PAID_CENTS, currency: "usd" },
      actor: "request",
    });
    await mailsSettled(suite.sql, lot);
  });
});
