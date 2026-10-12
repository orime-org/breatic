// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who wrote each disposition event row (inner#1410 §5.1, acceptance #14).
 *
 * Contract this suite specifies: every row of
 * `credit_refund_operation_events` carries `detail.actor`, naming the path
 * that executed the step:
 *
 *   - `request` — written while an internal API request runs: E1, the cells
 *     the endpoint's own executor runs in phase 3, and the E14 a one-shot
 *     disposition writes when it closes an open `needs_attention`.
 *   - `loop` — written by the refund loop: the claim (E13) and what the
 *     resumed executor writes after it, E11, and the step 2 recheck.
 *   - `webhook` — written while a refund webhook event is handled.
 *   - `reconcile` — written by the daily reconcile.
 *
 * Each path is driven through its production entry point: a signed request
 * to the internal app, `runRefundLoopOnce`, a signed delivery to
 * `POST /api/v1/payment/webhook`, `runDailyReconcile`. Dispositions are
 * seeded by SQL, which writes no event rows, so every row read back was
 * written by the path under test.
 */

import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
      verifier.webhooks.constructEvent(payload, signature, "whsec_refund_actor_suite"),
  };
});

import Stripe from "stripe";
import type { Hono } from "hono";
import { env, getRedis } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { runDailyReconcile } from "@server/modules/credit-refund/reconcile.js";
import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import { call, freshKey, mailsSettled, paths, useInternalApp } from "./internal-api-harness.js";
import {
  PAID_CENTS,
  REFUND_AGAIN_CENTS,
  copiesOf,
  eventsOf,
  giveIntentlessPaymentsAnIntent,
  parkInFlightOperations,
  readOp,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundAgainOn,
  seedRefundLot,
  type LotState,
  type RefundAgainCase,
  type RefundFixture,
  type SeedOp,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const WEBHOOK_SECRET = "whsec_refund_actor_suite";
const signer = new Stripe("sk_test_unused_by_this_suite");

const suite = useInternalApp("credit-refund-actor-test");
let app: Hono;

beforeAll(async () => {
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

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
 * A disposition seeded on a lot whose payment Stripe knows.
 * @param state - Where the lot stands.
 * @param op - The disposition.
 * @param refunds - What Stripe holds for the payment, given the disposition's id.
 * @returns The lot and the disposition's id.
 */
async function seededOp(
  state: LotState,
  op: SeedOp,
  refunds: (opId: string) => RefundFixture[] = () => [],
): Promise<{ lot: SeededLot; opId: string }> {
  const lot = await seedRefundLot(suite.sql, state);
  const { id } = await seedOperation(suite.sql, lot, op);
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS, refunds(id));
  return { lot, opId: id };
}

/**
 * An approval waiting on Stripe for its own refund, which Stripe now holds
 * as succeeded for the full amount: the next read of the payment books it.
 * @returns The lot and the disposition's id.
 */
async function awaitingRefundThatSucceeded(): Promise<{ lot: SeededLot; opId: string }> {
  const refundId = reId("own");
  return seededOp(
    "refunding",
    { kind: "approve", status: "awaiting_stripe", stripeRefundId: refundId, firstCalledHoursAgo: 0, attemptCount: 1 },
    (opId) => [refundObject(refundId, "succeeded", PAID_CENTS, opId)],
  );
}

/**
 * A disposition's event rows as `[event, detail.actor]`, oldest first.
 * @param opId - The disposition.
 * @returns The pairs.
 */
async function actorsOf(opId: string): Promise<[string, unknown][]> {
  return (await eventsOf(suite.sql, opId)).map((e) => [e.event, e.detail.actor]);
}

/**
 * Deliver one signed `refund.updated` event for a refund to the webhook.
 * @param refund - The refund the event carries.
 * @returns The webhook's HTTP status.
 */
async function deliverRefundUpdated(refund: unknown): Promise<number> {
  const payload = JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    api_version: "2025-01-27.acacia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "refund.updated",
    data: { object: refund },
  });
  const res = await app.request("/api/v1/payment/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
    },
    body: payload,
  });
  return res.status;
}

/**
 * Mark the daily reconcile as just finished, so a loop tick's step 4 does
 * nothing.
 */
async function reconcileJustFinished(): Promise<void> {
  await suite.sql`
    INSERT INTO credit_refund_reconcile_status (name, last_started_at, last_finished_at, last_ok_at)
    VALUES ('daily', now(), now(), now())
    ON CONFLICT (name) DO UPDATE SET
      last_started_at = now(), last_finished_at = now(), last_ok_at = now(),
      last_error = NULL, failing_payment_ids = '{}', next_retry_at = NULL
  `;
}

describe("request: rows written while an internal API request runs", () => {
  it("a rejection's E1", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await call(suite.baseUrl, paths.reject(lot.lotId), {
      body: { reason: "Outside the policy." },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    expect(await actorsOf(res.json.id)).toEqual([["requested", "request"]]);
  });

  it("an approval's E1 and the E2 its own executor writes in phase 3", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await call(suite.baseUrl, paths.approve(lot.lotId), {
      body: { reason: "Within the window.", confirmedRefundIds: [] },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    expect(res.json.result).toBe("refunded");
    await mailsSettled(suite.sql, lot);
    expect(await actorsOf(res.json.id)).toEqual([
      ["requested", "request"],
      ["refund_succeeded", "request"],
    ]);
  });

  it("the E14 a settle writes on the open needs_attention it closes", async () => {
    const outside = reId("dash");
    const { lot, opId: stuck } = await seededOp(
      "refunding",
      { kind: "approve", status: "needs_attention", attentionReason: "partial_refund" },
      () => [refundObject(outside, "succeeded", PAID_CENTS)],
    );

    const res = await call(suite.baseUrl, paths.settle(lot.lotId), {
      body: { reason: "Refunded in full outside.", notify: false, confirmedSucceededCents: PAID_CENTS, acceptPartial: false },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    expect(await actorsOf(res.json.id)).toEqual([["requested", "request"]]);
    expect(await actorsOf(stuck)).toEqual([["attention_closed", "request"]]);
  });
});

describe("request: the E1 row carries the request body (v7 §6.2 E1, finding [23])", () => {
  /**
   * The detail of a disposition's E1 row.
   * @param opId - The disposition.
   * @returns The detail.
   */
  async function requestedDetail(opId: string): Promise<Record<string, unknown>> {
    const [requested] = await eventsOf(suite.sql, opId);
    expect(requested!.event).toBe("requested");
    return requested!.detail;
  }

  it("a settle booked short on purpose: acceptPartial, notify and confirmedSucceededCents", async () => {
    const outside = reId("partial");
    const lot = await lotOnStripe("refunding", [refundObject(outside, "succeeded", 300)]);

    const res = await call(suite.baseUrl, paths.settle(lot.lotId), {
      body: { reason: "Partial refund agreed.", notify: false, confirmedSucceededCents: 300, acceptPartial: true },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    expect(await requestedDetail(res.json.id)).toMatchObject({
      kind: "settle",
      actor: "request",
      notify: false,
      confirmedSucceededCents: 300,
      acceptPartial: true,
    });
  });

  it("an approval: confirmedRefundIds", async () => {
    const external = reId("ext");
    const lot = await lotOnStripe("refund_pending", [refundObject(external, "succeeded", 300)]);

    const res = await call(suite.baseUrl, paths.approve(lot.lotId), {
      body: { reason: "Within the window.", confirmedRefundIds: [external] },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    expect(await requestedDetail(res.json.id)).toMatchObject({
      kind: "approve",
      actor: "request",
      confirmedRefundIds: [external],
    });
  });

  it("a refund_again: failedRefundIds and notify", async () => {
    const { lot, failed } = await seedRefundAgainOn(suite.sql, {
      status: "needs_attention",
      attentionReason: "stripe_declined",
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", REFUND_AGAIN_CENTS)]);

    const res = await call(suite.baseUrl, paths.refundAgain(lot.lotId), {
      body: { reason: "Pay the failed refund again.", failedRefundIds: [failed], notify: true },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    expect(await requestedDetail(res.json.id)).toMatchObject({
      kind: "refund_again",
      actor: "request",
      failedRefundIds: [failed],
      notify: true,
    });
  });
});

describe("loop: rows written by the refund loop", () => {
  beforeEach(async () => {
    await parkInFlightOperations(suite.sql);
    await reconcileJustFinished();
  });

  it("the claim of a started disposition whose lease lapsed, and what the resumed executor writes", async () => {
    const { lot, opId } = await seededOp("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: 1,
      firstCalledHoursAgo: 0,
    });

    await runRefundLoopOnce();

    expect(await actorsOf(opId)).toEqual([
      ["claimed", "loop"],
      ["refund_succeeded", "loop"],
    ]);
    await mailsSettled(suite.sql, lot);
  });

  it("the claim and the E11 of a started disposition with its attempts used up", async () => {
    const { opId } = await seededOp("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: getCreditRefundConfig().maxAttempts,
      firstCalledHoursAgo: 1,
    });

    await runRefundLoopOnce();

    expect(await actorsOf(opId)).toEqual([
      ["claimed", "loop"],
      ["attempts_exhausted", "loop"],
    ]);
  });

  it("the E2 step 2 writes when its recheck finds the refund succeeded", async () => {
    const { opId } = await awaitingRefundThatSucceeded();

    await runRefundLoopOnce();

    expect(await actorsOf(opId)).toEqual([["refund_succeeded", "loop"]]);
  });
});

describe("webhook: rows written while a refund event is handled", () => {
  it("the E2 a refund.updated delivery writes", async () => {
    const { lot, opId } = await awaitingRefundThatSucceeded();
    const [refund] = fakeStripe.refundsOf(lot.paymentIntentId);

    expect(await deliverRefundUpdated(refund)).toBe(200);
    expect(await actorsOf(opId)).toEqual([["refund_succeeded", "webhook"]]);
  });
});

describe("reconcile: rows written by the daily reconcile", () => {
  /**
   * The reconcile's Redis lock key (§7.2).
   * @returns The key.
   */
  const lockKey = (): string => `${env.ENV}:server:refund-reconcile-lock`;

  beforeEach(async () => {
    await parkInFlightOperations(suite.sql);
    await giveIntentlessPaymentsAnIntent(suite.sql);
    await suite.sql`DELETE FROM credit_refund_reconcile_status`;
    await getRedis().del(lockKey());
  });

  it("the E2 a pass writes when it reads the refund succeeded", async () => {
    const { opId } = await awaitingRefundThatSucceeded();

    await runDailyReconcile();

    expect(await actorsOf(opId)).toEqual([["refund_succeeded", "reconcile"]]);
    await reconcileJustFinished();
  });
});

describe("a refund_again in needs_attention is answered for by whichever read sees its own refund succeeded (v7 §6.2, findings [1][6][8][22])", () => {
  beforeEach(async () => {
    await parkInFlightOperations(suite.sql);
    await reconcileJustFinished();
  });

  /**
   * A refund_again that ran out of attempts while its refund was in fact
   * made; Stripe now lists that refund succeeded.
   * @returns The case and its own refund's id.
   */
  async function exhaustedWhileRefunded(): Promise<RefundAgainCase & { own: string }> {
    const seeded = await seedRefundAgainOn(suite.sql, { status: "needs_attention", attentionReason: "attempts_exhausted" });
    const own = reId("again_own");
    fakeStripe.register(seeded.lot.paymentIntentId, PAID_CENTS, [
      refundObject(seeded.failed, "failed", REFUND_AGAIN_CENTS),
      refundObject(own, "succeeded", REFUND_AGAIN_CENTS, seeded.againId),
    ]);
    return { ...seeded, own };
  }

  /**
   * Its failed refund is answered for by it, its attention closed by itself,
   * and one row on it names the reader.
   * @param seeded - The case.
   * @param actor - The path that read the refund.
   */
  async function expectAnsweredBy(seeded: RefundAgainCase, actor: string): Promise<void> {
    const op = await readOp(suite.sql, seeded.againId);
    expect(op).toMatchObject({ status: "needs_attention", attention_closed_by: seeded.againId });
    expect(op.attention_closed_at).not.toBeNull();
    const failed = (await copiesOf(suite.sql, seeded.lot.lotId)).find((c) => c.stripe_refund_id === seeded.failed);
    expect(failed!.resolved_by_operation_id).toBe(seeded.againId);
    expect(await actorsOf(seeded.againId)).toEqual([["refund_succeeded", actor]]);
  }

  it("webhook", async () => {
    const seeded = await exhaustedWhileRefunded();
    const refund = fakeStripe.refundsOf(seeded.lot.paymentIntentId).find((r) => r.id === seeded.own);

    expect(await deliverRefundUpdated(refund)).toBe(200);

    await expectAnsweredBy(seeded, "webhook");
  });

  it("a request's step 0 (the preview), which then no longer offers refund_again for that refund", async () => {
    const seeded = await exhaustedWhileRefunded();

    const res = await call(suite.baseUrl, paths.preview(seeded.lot.lotId));

    expect(res.status).toBe(200);
    await expectAnsweredBy(seeded, "request");
    expect(res.json.unresolvedFailedRefunds).toEqual([]);
    expect(res.json.action).toMatchObject({ kind: "refund_again", outcome: "blocked" });
  });

  it("the loop's recheck of another disposition of the payment", async () => {
    const seeded = await exhaustedWhileRefunded();
    // A second refund_again left waiting after a 5xx: the loop reads the payment for it.
    await seedOperation(suite.sql, seeded.lot, {
      kind: "refund_again",
      status: "awaiting_stripe",
      stripeRefundId: null,
      firstCalledHoursAgo: 1,
      attemptCount: 1,
      failedRefundIds: [seeded.failed],
      refundAmountCents: REFUND_AGAIN_CENTS,
    });

    await runRefundLoopOnce();

    await expectAnsweredBy(seeded, "loop");
  });

  it("the daily reconcile", async () => {
    await giveIntentlessPaymentsAnIntent(suite.sql);
    await suite.sql`DELETE FROM credit_refund_reconcile_status`;
    await getRedis().del(`${env.ENV}:server:refund-reconcile-lock`);
    const seeded = await exhaustedWhileRefunded();

    await runDailyReconcile();

    await expectAnsweredBy(seeded, "reconcile");
    await reconcileJustFinished();
  });

  it("a copy already seen succeeded before it went to a person counts too: the next read answers for it", async () => {
    const seeded = await exhaustedWhileRefunded();
    await seedCopy(suite.sql, seeded.lot, {
      id: seeded.own,
      amountCents: REFUND_AGAIN_CENTS,
      status: "succeeded",
      operationId: seeded.againId,
    });
    const refund = fakeStripe.refundsOf(seeded.lot.paymentIntentId).find((r) => r.id === seeded.own);

    expect(await deliverRefundUpdated(refund)).toBe(200);

    await expectAnsweredBy(seeded, "webhook");
  });
});
