// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three refund events on the Stripe webhook (inner#1410 §7.3), through
 * `POST /api/v1/payment/webhook` of the real app, signed the way Stripe
 * signs, on real Postgres with the stateful fake Stripe behind
 * `getStripeClient`.
 *
 * Contract this suite drives — `routes/payment.ts` handles `refund.created`,
 * `refund.updated` and `refund.failed`:
 *
 *   - Take `payment_intent` from the event's refund object.
 *   - Not a credit-pack payment (no payment with that intent, or a payment
 *     that opened no lot): `claimWebhookEvent` and answer 200; Stripe is not
 *     read.
 *   - A credit-pack payment: `listRefunds(payment_intent)` (every refund, the
 *     latest state — the event's own payload is not trusted for state), then
 *     in one transaction `lockLot`, `claimWebhookEvent`,
 *     `applyRefundSnapshot`. An event id already claimed is not claimed
 *     again, but the list read for it is still copied (§6.4).
 *   - The Stripe read fails: answer 500 and write nothing, so Stripe
 *     redelivers and the redelivery is processed.
 *
 * `verifyWebhookSignature` is replaced by stripe-node's own
 * `webhooks.constructEvent` with this suite's secret, and every delivery is
 * signed with `webhooks.generateTestHeaderString`.
 */

import { randomUUID } from "node:crypto";
import type * as BreaticCore from "@breatic/core";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  const { default: StripeSdk } = await import("stripe");
  const verifier = new StripeSdk("sk_test_unused_by_this_suite");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: (payload: string | Buffer, signature: string) =>
      verifier.webhooks.constructEvent(payload, signature, "whsec_refund_webhook_suite"),
  };
});

const logError = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", async (io) => {
  const actual = await io<typeof BreaticCore>();
  // `error` is recorded instead of written; every other level goes to the real logger.
  const logger = new Proxy(actual.logger, {
    get: (target, prop) => (prop === "error" ? logError : Reflect.get(target, prop)),
  });
  return { ...actual, logger };
});

import type { Hono } from "hono";
import { StripeReadError } from "@server/modules/credit-refund/stripe-refunds.js";
import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import { mailsSettled } from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  copiesOf,
  deliverWebhook,
  ledgerOf,
  mailsOf,
  pendingReasonsOf,
  readLot,
  readOp,
  refundEvent,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  worldOf,
  type LotState,
  type RefundEventType,
  type RefundFixture,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const WEBHOOK_SECRET = "whsec_refund_webhook_suite";

const suite = useRefundSuite("credit-refund-webhook-test");
let app: Hono;

beforeAll(async () => {
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  fakeStripe.reset();
});

/**
 * Deliver an event to the webhook, signed with the suite's secret.
 * @param event - The event body.
 * @returns The answer.
 */
function deliver(event: Record<string, unknown>): Promise<Response> {
  return deliverWebhook(app, WEBHOOK_SECRET, event);
}

/**
 * A lot in `state` whose payment Stripe knows, with these refunds on it.
 * @param state - Where the lot stands.
 * @param refunds - What Stripe holds for the payment.
 * @returns The lot.
 */
async function lotOnStripe(state: LotState, refunds: RefundFixture[] = []): Promise<SeededLot> {
  const lot = await seedRefundLot(suite.sql, state);
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS, refunds);
  return lot;
}

/**
 * The claimed webhook event rows for an event id.
 * @param eventId - Stripe's event id.
 * @returns The rows' types.
 */
async function claimedTypes(eventId: string): Promise<string[]> {
  const rows = await suite.sql<{ type: string }[]>`
    SELECT type FROM stripe_webhook_events WHERE event_id = ${eventId}
  `;
  return rows.map((r) => r.type);
}

/**
 * Whether Stripe was read for a payment intent.
 * @param paymentIntent - `pi_…`.
 * @returns True when `refunds.list` was called for it.
 */
function listed(paymentIntent: string): boolean {
  return fakeStripe.listedIntents().includes(paymentIntent);
}

describe("credit-pack payment: Stripe is read and copied", () => {
  it.each<RefundEventType>(["refund.created", "refund.updated", "refund.failed"])(
    "%s copies every refund Stripe lists for the payment and claims the event",
    async (type) => {
      const external = reId("external");
      const other = reId("other");
      const status = type === "refund.failed" ? "failed" : "pending";
      const lot = await lotOnStripe("active", [
        refundObject(external, status, 300),
        refundObject(other, "succeeded", 100),
      ]);
      const event = refundEvent(type, refundObject(external, status, 300), lot.paymentIntentId);

      const res = await deliver(event);

      expect(res.status).toBe(200);
      expect(listed(lot.paymentIntentId)).toBe(true);
      expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.operation_id]).sort()).toEqual(
        [
          [external, status, null],
          [other, "succeeded", null],
        ].sort(),
      );
      expect(await claimedTypes(event.id as string)).toEqual([type]);
    },
  );

  it("the state comes from Stripe's latest read, not the event payload", async () => {
    const external = reId("external");
    const lot = await lotOnStripe("active", [refundObject(external, "succeeded", 300)]);

    const res = await deliver(refundEvent("refund.created", refundObject(external, "pending", 300), lot.paymentIntentId));

    expect(res.status).toBe(200);
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded])).toEqual([
      [external, "succeeded", true],
    ]);
  });

  it("refund.updated to pending with insufficient_funds (Stripe balance short): the approval stays awaiting_stripe, the copy records the reason, nothing booked (v9 §5.2, §5.1)", async () => {
    const own = reId("held");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    await seedCopy(suite.sql, lot, { id: own, amountCents: PAID_CENTS, status: "pending", operationId: opId, pendingReason: "processing" });
    const held = refundObject(own, "pending", PAID_CENTS, opId, "insufficient_funds");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [held]);

    const res = await deliver(refundEvent("refund.updated", held, lot.paymentIntentId));

    expect(res.status).toBe(200);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", result: null, attention_reason: null });
    expect((await pendingReasonsOf(suite.sql, lot.lotId))[own]).toBe("insufficient_funds");
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding", remaining: `${CREDITS}.000000` });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
  });

  it("refund.updated to succeeded settles the approval waiting on it", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, opId)]);

    const res = await deliver(refundEvent("refund.updated", refundObject(own, "succeeded", PAID_CENTS, opId), lot.paymentIntentId));

    expect(res.status).toBe(200);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunded", remaining: "0.000000" });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: own },
    ]);
  });

  it("refund.updated to succeeded: the buyer mail is sent right after the booking commits (§6.5 M1)", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
      notify: true,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, opId)]);

    const res = await deliver(refundEvent("refund.updated", refundObject(own, "succeeded", PAID_CENTS, opId), lot.paymentIntentId));

    expect(res.status).toBe(200);
    // No refund loop runs in this suite: nothing but the send after the
    // commit can move the row.
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ operation_id: opId, kind: "refund_completed", origin: "auto" }),
    ]);
    await mailsSettled(suite.sql, lot);
  });

  it("refund.failed on a waiting approval → needs_attention stripe_refund_failed_later", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "failed", PAID_CENTS, opId)]);

    const res = await deliver(refundEvent("refund.failed", refundObject(own, "failed", PAID_CENTS, opId), lot.paymentIntentId));

    expect(res.status).toBe(200);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
    });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
  });

  it("refund.failed after the lot was refunded: the copy records the failure, lot and ledger stay", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunded");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "refunded",
      stripeRefundId: own,
    });
    await seedCopy(suite.sql, lot, { id: own, amountCents: PAID_CENTS, status: "succeeded", operationId: opId });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "failed", PAID_CENTS, opId)]);
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

    const res = await deliver(refundEvent("refund.failed", refundObject(own, "failed", PAID_CENTS, opId), lot.paymentIntentId));

    expect(res.status).toBe(200);
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded, c.resolved_by_operation_id])).toEqual([
      [own, "failed", true, null],
    ]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunded", remaining: "0.000000" });
    expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
  });
});

describe("redelivery", () => {
  it("the same event delivered again is claimed once, still copies what it reads, and finishes nothing twice (round 8 [2])", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
      notify: true,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "pending", PAID_CENTS, opId)]);
    const event = refundEvent("refund.updated", refundObject(own, "pending", PAID_CENTS, opId), lot.paymentIntentId);

    expect((await deliver(event)).status).toBe(200);
    // Stripe moves on before the redelivery. The handler copies the list it
    // reads, never the event's payload, so that read is copied too (§6.4).
    fakeStripe.setStatus(own, "succeeded");
    expect((await deliver(event)).status).toBe(200);

    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded])).toEqual([
      [own, "succeeded", true],
    ]);
    expect(await claimedTypes(event.id as string)).toEqual(["refund.updated"]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
    await mailsSettled(suite.sql, lot);
    const { copies: _copies, ...finished } = await worldOf(suite.sql, lot);
    expect(finished.mails).toHaveLength(1);

    // Delivered once more: the finished disposition gets no second booking, bell or mail.
    expect((await deliver(event)).status).toBe(200);
    await mailsSettled(suite.sql, lot);
    const { copies: _again, ...after } = await worldOf(suite.sql, lot);
    expect(after).toEqual(finished);
    expect(await claimedTypes(event.id as string)).toEqual(["refund.updated"]);
  });
});

describe("not a credit-pack payment", () => {
  it("an intent no payment of ours carries: claimed, 200, Stripe not read", async () => {
    const pi = `pi_unknown_${randomUUID().replace(/-/g, "")}`;
    const event = refundEvent("refund.created", refundObject(reId("x"), "succeeded", 500), pi);

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await claimedTypes(event.id as string)).toEqual(["refund.created"]);
    expect(listed(pi)).toBe(false);
    expect(fakeStripe.listCalls).toEqual([]);
  });

  it("a payment that opened no credit lot: claimed, 200, Stripe not read, nothing copied", async () => {
    const tag = randomUUID().slice(0, 8);
    const [user] = await suite.sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified) VALUES (${`refund-hook-${tag}@example.test`}, true) RETURNING id
    `;
    const [source] = await suite.sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    const pi = `pi_nolot_${tag}`;
    await suite.sql`
      INSERT INTO payments
        (id, user_id, amount_cents, total_cents, currency, status, credits_granted, stripe_payment_intent_id)
      VALUES (${source!.id}, ${user!.id}, 1000, ${PAID_CENTS}, 'usd', 'completed', ${CREDITS}, ${pi})
    `;
    fakeStripe.register(pi, PAID_CENTS, [refundObject(reId("x"), "succeeded", 500)]);
    const event = refundEvent("refund.updated", refundObject(reId("x"), "succeeded", 500), pi);

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await claimedTypes(event.id as string)).toEqual(["refund.updated"]);
    expect(listed(pi)).toBe(false);
    const copies = await suite.sql`SELECT 1 FROM credit_refunds WHERE payment_id = ${source!.id}`;
    expect(copies).toHaveLength(0);
  });
});

describe("Stripe cannot be read", () => {
  it("answers 500 and writes nothing, so the redelivery is processed", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, opId)]);
    fakeStripe.failLists(stripeError(500));
    const event = refundEvent("refund.updated", refundObject(own, "succeeded", PAID_CENTS, opId), lot.paymentIntentId);
    const before = await worldOf(suite.sql, lot);

    const res = await deliver(event);

    expect(res.status).toBe(500);
    expect(await worldOf(suite.sql, lot)).toEqual(before);
    expect(await claimedTypes(event.id as string)).toEqual([]);

    fakeStripe.failLists(null);
    const again = await deliver(event);

    expect(again.status).toBe(200);
    expect(await claimedTypes(event.id as string)).toEqual(["refund.updated"]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
  });

  it("the unread event is logged at error with the read error under `err` and Stripe's failure under `failure` (round 7 [8], round 8 [8][13], round 9 [1][4])", async () => {
    const external = reId("external");
    const lot = await lotOnStripe("refund_pending", [refundObject(external, "succeeded", 100)]);
    fakeStripe.failLists(stripeError(403));
    const event = refundEvent("refund.updated", refundObject(external, "succeeded", 100), lot.paymentIntentId);
    logError.mockClear();

    const res = await deliver(event);

    expect(res.status).toBe(500);
    // Error, as the request path logs the same failure. `err` keeps the stack
    // and cause chain; `failure` keeps Stripe's own error type.
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(StripeReadError),
        eventId: event.id,
        failure: expect.objectContaining({ message: "synthetic 403", httpStatus: 403 }),
      }),
      "refund_webhook_stripe_unreadable",
    );
  });
});
