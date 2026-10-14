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

import type { Hono } from "hono";
import { env, getRedis } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { runDailyReconcile } from "@server/modules/credit-refund/reconcile.js";
import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import { call, freshKey, mailsSettled, paths, useInternalApp } from "./internal-api-harness.js";
import {
  PAID_CENTS,
  deliverWebhook,
  eventsOf,
  giveIntentlessPaymentsAnIntent,
  markReconcileJustFinished,
  parkInFlightOperations,
  refundEvent,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  type LotState,
  type RefundFixture,
  type SeedOp,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const WEBHOOK_SECRET = "whsec_refund_actor_suite";

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
      body: { reason: "Refunded in full outside.", notify: false, confirmedSucceededCents: PAID_CENTS },
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

  it("a settle: notify and confirmedSucceededCents, and no acceptPartial (v9: gone)", async () => {
    const outside = reId("full_outside");
    const lot = await lotOnStripe("refunding", [refundObject(outside, "succeeded", PAID_CENTS)]);

    const res = await call(suite.baseUrl, paths.settle(lot.lotId), {
      body: { reason: "Refunded in full outside.", notify: false, confirmedSucceededCents: PAID_CENTS },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    const detail = await requestedDetail(res.json.id);
    expect(detail).toMatchObject({
      kind: "settle",
      actor: "request",
      notify: false,
      confirmedSucceededCents: PAID_CENTS,
    });
    expect(detail).not.toHaveProperty("acceptPartial");
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

  it("a restore_credits (v9): failedRefundIds", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "succeeded", result: "refunded", createdSecondsAgo: 600 });
    const failed = reId("failed_later");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: PAID_CENTS, status: "failed", everSucceeded: true, operationId: approve.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", PAID_CENTS, approve.id)]);

    const res = await call(suite.baseUrl, paths.restoreCredits(lot.lotId), {
      body: { reason: "Buyer agreed to take the credits back.", failedRefundIds: [failed] },
      idempotencyKey: freshKey(),
    });

    expect(res.status).toBe(200);
    await mailsSettled(suite.sql, lot);
    expect(await requestedDetail(res.json.id)).toMatchObject({
      kind: "restore_credits",
      actor: "request",
      failedRefundIds: [failed],
    });
  });
});

describe("loop: rows written by the refund loop", () => {
  beforeEach(async () => {
    await parkInFlightOperations(suite.sql);
    await markReconcileJustFinished(suite.sql);
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

    const delivered = await deliverWebhook(app, WEBHOOK_SECRET, refundEvent("refund.updated", refund!, lot.paymentIntentId));
    expect(delivered.status).toBe(200);
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
    await markReconcileJustFinished(suite.sql);
  });
});
