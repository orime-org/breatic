// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund disposition against real Stripe test mode (inner#1410 §11, the
 * `@needs-payments` row): payments are PaymentIntents created and confirmed
 * here with Stripe's test payment methods (`pm_card_visa`;
 * `pm_card_refundFail`, whose refund starts `succeeded` and later turns
 * `failed`), the lot is seeded in the testcontainers database the way the
 * other refund suites do, and the internal endpoints are called over a real
 * socket with signed requests. Nothing here stands in for Stripe.
 *
 * Every case is tagged, so the default integration run leaves the file out
 * (`testNamePattern` in vitest.integration.config.ts). Run it on purpose:
 *
 *   STRIPE_SECRET_KEY=sk_test_… pnpm --filter @breatic/server test:integration \
 *     -t @needs-payments src/__tests__/integration/credit-refund-real-stripe.integration.test.ts
 *
 * The suite refuses any key that is not `sk_test_…`, before the first call.
 * Checkout itself cannot be driven (docs.stripe.com/automated-testing), and
 * the webhook needs the Stripe CLI, so a refund that fails later is found by
 * the refund loop's daily reconcile instead (§7.2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, inject, vi } from "vitest";
import postgres from "postgres";
import Stripe from "stripe";
import { initCore, loadLocales } from "@breatic/core";
import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import {
  ADMIN,
  PREVIOUS_SECRET,
  SECRET,
  call,
  freshKey,
  mailsSettled,
  paths,
  resetInternalRateLimit,
  serveOnLoopback,
  type InternalSuite,
  type RunningApp,
} from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  bellsOf,
  copiesOf,
  ledgerOf,
  readLot,
  seedRefundLot,
  type SeededLot,
} from "./credit-refund-fixtures.js";

/** Long enough for Stripe to turn a `pm_card_refundFail` refund to `failed`. */
const CASE_TIMEOUT_MS = 300_000;
const FAILED_LATER_WITHIN_MS = 240_000;
const APPROVE = { reason: "Within 14 days, unused.", confirmedRefundIds: [] as string[] };

const suite = {} as InternalSuite;
let running: RunningApp | undefined;
let stripe: Stripe;
const lots: SeededLot[] = [];

beforeAll(async () => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    throw new Error("This suite runs against Stripe test mode only: set STRIPE_SECRET_KEY to an sk_test_ key.");
  }
  stripe = new Stripe(key);
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: key,
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: SECRET,
    INTERNAL_API_SECRET_PREVIOUS: PREVIOUS_SECRET,
  });
  loadLocales();
  suite.sql = postgres(inject("DATABASE_URL"), {
    max: 8,
    prepare: false,
    connection: { application_name: "credit-refund-real-stripe-test" },
  });
  const { createInternalApp } = await import("@server/internal-app.js");
  running = await serveOnLoopback(createInternalApp());
  suite.baseUrl = running.baseUrl;
});

afterAll(async () => {
  // Background mail sends write back over these connections.
  for (const lot of lots) await mailsSettled(suite.sql, lot);
  await running?.close();
  await suite.sql?.end({ timeout: 1 });
  initCore(process.env);
});

beforeEach(async () => {
  await resetInternalRateLimit();
});

/**
 * A `refund_pending` lot whose payment is a real PaymentIntent of
 * {@link PAID_CENTS}, paid with the given test payment method.
 * @param paymentMethod - A Stripe `pm_card_*` test payment method.
 * @returns The lot, its `paymentIntentId` the real one.
 */
async function paidLot(paymentMethod: string): Promise<SeededLot> {
  const intent = await stripe.paymentIntents.create({
    amount: PAID_CENTS,
    currency: "usd",
    payment_method: paymentMethod,
    payment_method_types: ["card"],
    confirm: true,
  });
  expect(intent.status).toBe("succeeded");
  const lot = await seedRefundLot(suite.sql, "refund_pending");
  await suite.sql`
    UPDATE payments SET stripe_payment_intent_id = ${intent.id} WHERE id = ${lot.paymentId}
  `;
  const real = { ...lot, paymentIntentId: intent.id };
  lots.push(real);
  return real;
}

/**
 * Send a signed POST.
 * @param path - The endpoint.
 * @param body - JSON body.
 * @param key - Idempotency key.
 * @returns The answer.
 */
function post(path: string, body: unknown, key: string = freshKey()) {
  return call(suite.baseUrl, path, { body, idempotencyKey: key });
}

/**
 * Every refund Stripe holds for a payment intent.
 * @param paymentIntent - `pi_…`.
 * @returns The refunds, newest first.
 */
async function stripeRefundsOf(paymentIntent: string): Promise<Stripe.Refund[]> {
  return (await stripe.refunds.list({ payment_intent: paymentIntent, limit: 100 })).data;
}

/**
 * The lot booked as refunded on `refundId`: zero balance, one `refund`
 * ledger row of `-remaining_credits`.
 * @param lot - The lot.
 * @param refundId - The ledger row's reference.
 */
async function expectBookedOn(lot: SeededLot, refundId: string): Promise<void> {
  expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
  const refundRows = (await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund");
  expect(refundRows).toEqual([{ entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: refundId }]);
}

/**
 * Run the refund loop with its daily reconcile due, until `check` holds.
 * @param check - Throws until the expected state is reached.
 * @param timeout - How long to keep trying.
 */
async function loopUntil(check: () => Promise<void>, timeout: number): Promise<void> {
  await vi.waitFor(
    async () => {
      await suite.sql`DELETE FROM credit_refund_reconcile_status`;
      await runRefundLoopOnce();
      await check();
    },
    { timeout, interval: 3_000 },
  );
}

describe("approve against Stripe test mode", () => {
  it(
    "pm_card_visa: 200 refunded; Stripe holds one refund of the whole payment, tagged with the disposition and created under credit-refund-<id>; lot booked, copy and bell written @needs-payments",
    async () => {
      const lot = await paidLot("pm_card_visa");

      const res = await post(paths.approve(lot.lotId), APPROVE, freshKey("approve"));

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ kind: "approve", status: "succeeded", result: "refunded", attentionReason: null, requestedBy: ADMIN });
      const opId: string = res.json.id;
      const onStripe = await stripeRefundsOf(lot.paymentIntentId);
      expect(onStripe).toHaveLength(1);
      expect(onStripe[0]).toMatchObject({
        id: res.json.stripeRefundId,
        amount: PAID_CENTS,
        status: "succeeded",
        metadata: { refund_operation_id: opId },
      });

      // The same key and parameters within 24 hours return the cached refund
      // rather than a new one: proof of the key the product used. A different
      // key would ask for a second refund of a fully refunded charge instead.
      const replayed = await stripe.refunds.create(
        { payment_intent: lot.paymentIntentId, metadata: { refund_operation_id: opId } },
        { idempotencyKey: `credit-refund-${opId}` },
      );
      expect(replayed.id).toBe(onStripe[0]!.id);
      expect(replayed.lastResponse.headers["idempotent-replayed"]).toBe("true");
      expect(await stripeRefundsOf(lot.paymentIntentId)).toHaveLength(1);

      await expectBookedOn(lot, onStripe[0]!.id);
      expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
        expect.objectContaining({
          stripe_refund_id: onStripe[0]!.id,
          operation_id: opId,
          amount_cents: PAID_CENTS,
          status: "succeeded",
          ever_succeeded: true,
        }),
      ]);
      const bells = await bellsOf(suite.sql, lot.userId);
      expect(bells).toHaveLength(1);
      expect(bells[0]).toMatchObject({ type: "credit.refund_completed" });
      expect(bells[0]!.payload.lotId).toBe(lot.lotId);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "the same approve request sent again under the same Idempotency-Key replays the snapshot and creates no second Stripe refund @needs-payments",
    async () => {
      const lot = await paidLot("pm_card_visa");
      const key = freshKey("approve");
      const first = await post(paths.approve(lot.lotId), APPROVE, key);
      expect(first.status).toBe(200);
      await mailsSettled(suite.sql, lot);
      const ledgerAfterFirst = await ledgerOf(suite.sql, lot.lotId);

      const again = await post(paths.approve(lot.lotId), APPROVE, key);

      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      const onStripe = await stripeRefundsOf(lot.paymentIntentId);
      expect(onStripe.map((r) => r.id)).toEqual([first.json.stripeRefundId]);
      expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerAfterFirst);
      await expectBookedOn(lot, first.json.stripeRefundId);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("a refund that succeeds and later fails (pm_card_refundFail)", () => {
  it(
    "approve books it; the reconcile finds it failed; the preview blocks refund_again (refund_failed: the failed amount does not come back); resolved-outside answers for it @needs-payments",
    async () => {
      const lot = await paidLot("pm_card_refundFail");

      const approved = await post(paths.approve(lot.lotId), APPROVE, freshKey("approve"));

      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ kind: "approve", status: "succeeded", result: "refunded" });
      const failedId: string = approved.json.stripeRefundId;
      await expectBookedOn(lot, failedId);

      await loopUntil(async () => {
        const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failedId);
        expect(copy).toMatchObject({ status: "failed", ever_succeeded: true, resolved_by_operation_id: null });
      }, FAILED_LATER_WITHIN_MS);

      // §5.2 v6: paid − succeeded − failed = 0, so a refund_again of the
      // failed amount is one Stripe would refuse; the preview says so.
      const preview = await call(suite.baseUrl, paths.preview(lot.lotId));
      expect(preview.status).toBe(200);
      expect(preview.json.unresolvedFailedRefunds).toEqual([
        expect.objectContaining({ stripeRefundId: failedId, amountCents: PAID_CENTS }),
      ]);
      expect(preview.json.action).toMatchObject({
        kind: "refund_again",
        outcome: "blocked",
        code: "stripe_blocks",
        reason: "refund_failed",
      });
      const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

      const resolved = await post(paths.resolvedOutside(lot.lotId), {
        reason: "Paid back by bank transfer after the card refund failed.",
        failedRefundIds: [failedId],
        confirmedSucceededCents: 0,
      });

      expect(resolved.status).toBe(200);
      const opId: string = resolved.json.id;
      expect(resolved.json).toMatchObject({ kind: "resolve_outside", status: "succeeded", result: "resolved_outside", notify: false });
      expect((await stripeRefundsOf(lot.paymentIntentId)).map((r) => r.id)).toEqual([failedId]);
      const failed = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failedId);
      expect(failed).toMatchObject({ status: "failed", ever_succeeded: true, resolved_by_operation_id: opId });
      const after = await call(suite.baseUrl, paths.preview(lot.lotId));
      expect(after.json.unresolvedFailedRefunds).toEqual([]);
      expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
      expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    },
    CASE_TIMEOUT_MS,
  );
});
