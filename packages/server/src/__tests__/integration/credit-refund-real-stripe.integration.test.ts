// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund disposition against real Stripe test mode (inner#1410 §11, the
 * `@needs-payments` row): payments are PaymentIntents created and confirmed
 * here with Stripe's test payment methods, the lot is seeded in the
 * testcontainers database the way the other refund suites do, and the
 * internal endpoints are called over a real socket with signed requests.
 * Nothing here stands in for Stripe.
 *
 * Test payment methods (docs.stripe.com/testing, "Simulate an asynchronous
 * refund"):
 *   - `pm_card_visa`: the refund succeeds at once.
 *   - `pm_card_pendingRefund` (4000000000007726): "If you initiate a refund,
 *     its status begins as `pending`. Some time later, its status
 *     transitions to `succeeded` and sends a `refund.updated` event."
 *   - `pm_card_refundFail` (4000000000005126): "its status begins as
 *     `succeeded`. Some time later, its status transitions to `failed` and
 *     sends a `refund.failed` event."
 *   - `pm_card_createDispute` (4000000000000259): the charge succeeds and is
 *     then disputed as fraudulent (docs.stripe.com/testing, "Disputes").
 *
 * Two Stripe answers the v9 design rests on are only known from test mode
 * (§5.2, §10): a create on a payment whose refund failed, and a create on a
 * disputed charge. Their cases assert what the design needs — a 400 that is
 * a Stripe refusal (§5.4 `isStripeRefusal`) — and print the exact status,
 * type and code on a line starting `@needs-payments observed:`, to be
 * copied into the design when the sub-gate is run.
 *
 * Every case is tagged, so the default integration run leaves the file out
 * (`testNamePattern` in vitest.integration.config.ts). Run it on purpose:
 *
 *   STRIPE_SECRET_KEY=sk_test_… pnpm --filter @breatic/server test:integration \
 *     -t @needs-payments src/__tests__/integration/credit-refund-real-stripe.integration.test.ts
 *
 * The suite refuses any key that is not `sk_test_…`, before the first call.
 * Checkout itself cannot be driven (docs.stripe.com/automated-testing).
 * Without a webhook, a refund that changes later is found by the refund
 * loop and its daily reconcile (§7.1, §7.2).
 *
 * The webhook case (§7.3) also needs the Stripe CLI forwarding to the
 * product's webhook, which this suite serves on 127.0.0.1:4242 (override
 * with STRIPE_CLI_FORWARD_PORT). In one shell, logged in to the account of
 * the key (docs.stripe.com/stripe-cli, `stripe listen`):
 *
 *   stripe listen --api-key sk_test_… \
 *     --events refund.created,refund.updated,refund.failed \
 *     --forward-to http://127.0.0.1:4242/api/v1/payment/webhook
 *
 * It prints "Your webhook signing secret is whsec_…". In another:
 *
 *   STRIPE_CLI_FORWARDING=1 STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_SECRET_KEY=sk_test_… \
 *     pnpm --filter @breatic/server test:integration \
 *     -t @needs-payments src/__tests__/integration/credit-refund-real-stripe.integration.test.ts
 *
 * Without STRIPE_CLI_FORWARDING=1 the webhook case reports itself skipped;
 * with it, a missing `whsec_` secret fails the suite rather than skipping.
 * While the CLI forwards, the webhook may finish the other cases' refunds
 * before the loop does; those cases assert the end state, not who wrote it.
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
  errorShape,
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
  EVENT_NAME,
  bellsOf,
  copiesOf,
  eventsOf,
  inFailureList,
  ledgerOf,
  pendingReasonsOf,
  readLot,
  readOp,
  seedRefundLot,
  unresolvedViewOf,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import { expectRestored, expectRestoredBell } from "./credit-refund-cells.js";

/**
 * Long enough for Stripe to move a `pm_card_refundFail` refund to `failed`
 * or a `pm_card_pendingRefund` refund to `succeeded`; the docs only say
 * "some time later".
 */
const CASE_TIMEOUT_MS = 300_000;
const FAILED_LATER_WITHIN_MS = 240_000;
const APPROVE = { reason: "Within 14 days, unused.", confirmedRefundIds: [] as string[] };
/** How long Stripe may take to open the dispute of a `pm_card_createDispute` charge. */
const DISPUTED_WITHIN_MS = 120_000;
/** Where a buyer mail may stand once its background send has finished. */
const MAIL_FINISHED = ["sent", "skipped", "failed"];

/** The Stripe CLI is forwarding to {@link FORWARD_PORT} (see the header). */
const FORWARDING = process.env.STRIPE_CLI_FORWARDING === "1";
const FORWARD_PORT = Number(process.env.STRIPE_CLI_FORWARD_PORT ?? 4242);
const NOT_FORWARDING =
  `Stripe CLI is not forwarding to 127.0.0.1:${FORWARD_PORT}: run \`stripe listen\` as the file header shows, ` +
  "then set STRIPE_CLI_FORWARDING=1 and STRIPE_WEBHOOK_SECRET to the whsec_ it printed";
const REFUND_EVENT_TYPES = ["refund.created", "refund.updated", "refund.failed"];

const suite = {} as InternalSuite;
let running: RunningApp | undefined;
/** The product app with the Stripe webhook, served only while the CLI forwards. */
let webhookApp: RunningApp | undefined;
let stripe: Stripe;
const lots: SeededLot[] = [];

beforeAll(async () => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    throw new Error("This suite runs against Stripe test mode only: set STRIPE_SECRET_KEY to an sk_test_ key.");
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (FORWARDING && !webhookSecret.startsWith("whsec_")) {
    throw new Error("STRIPE_CLI_FORWARDING=1 needs STRIPE_WEBHOOK_SECRET set to the whsec_ that `stripe listen` printed.");
  }
  stripe = new Stripe(key);
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: key,
    STRIPE_WEBHOOK_SECRET: FORWARDING ? webhookSecret : "whsec_unused_by_this_suite",
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
  if (FORWARDING) {
    const { createApp } = await import("@server/app.js");
    webhookApp = await serveOnLoopback(createApp(), FORWARD_PORT);
  }
});

afterAll(async () => {
  // Background mail sends write back over these connections.
  for (const lot of lots) await mailsSettled(suite.sql, lot);
  await running?.close();
  await webhookApp?.close();
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

/** Stripe's answer to a create, as far as §5.4 classifies it. */
interface CreateAnswerSeen {
  httpStatus: number | undefined;
  type: string | undefined;
  code: string | undefined;
  shouldRetry: string | undefined;
  message: string;
}

/**
 * Print what Stripe answered, for the design (see the header), and assert
 * the part the design rests on: a 400 that is a Stripe refusal — `code` not
 * rate_limit / lock_timeout / charge_already_refunded, `type` not
 * idempotency_error, no `Stripe-Should-Retry: true` (§5.4).
 * @param what - Which case observed it.
 * @param seen - The answer.
 */
function expectRefusal(what: string, seen: CreateAnswerSeen): void {
  console.info(`@needs-payments observed: ${what}: ${JSON.stringify(seen)}`);
  expect(seen.httpStatus).toBe(400);
  expect(["rate_limit", "lock_timeout", "charge_already_refunded"]).not.toContain(seen.code);
  expect(seen.type).not.toBe("idempotency_error");
  expect(seen.shouldRetry).not.toBe("true");
}

/**
 * A `refund_pending` lot paid with `pm_card_refundFail`, approved (booked on
 * the refund Stripe first reports succeeded), and the reconcile having read
 * that refund `failed` (§6.3 L8).
 * @returns The lot and the failed refund.
 */
async function bookedThenFailed(): Promise<{ lot: SeededLot; failedId: string }> {
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
  return { lot, failedId };
}

/**
 * The preview of a refunded lot whose refund failed later (v9 §4.5, §5.2,
 * §5.3): no create operation is judged (`action` null), the lot is on the
 * "refund failed" list, restore is open, the charge is not disputed, and the
 * failed refund is the one unresolved — in the preview and in the view.
 * @param lot - The lot.
 * @param failedId - The failed refund.
 */
async function expectFailedRefundPreview(lot: SeededLot, failedId: string): Promise<void> {
  const preview = await call(suite.baseUrl, paths.preview(lot.lotId));
  expect(preview.status).toBe(200);
  expect(preview.json.action).toBeNull();
  expect(preview.json.refundFailure).toBe(true);
  expect(preview.json.restoreCredits).toMatchObject({ outcome: "allowed" });
  expect(preview.json.disputed).toBe(false);
  expect(preview.json.unresolvedFailedRefunds).toEqual([
    expect.objectContaining({ stripeRefundId: failedId, amountCents: PAID_CENTS }),
  ]);
  expect((await unresolvedViewOf(suite.sql, lot.lotId)).map((r) => r.stripe_refund_id)).toEqual([failedId]);
  expect(await inFailureList(suite.sql, lot.lotId)).toBe(true);
}

/** One refund event Stripe sent, as `events.list` reports it. */
interface SentEvent {
  id: string;
  type: string;
  refundId: string;
}

/**
 * The refund events Stripe has sent for these refunds since `since`.
 * @param refundIds - `re_…` ids.
 * @param since - Unix seconds.
 * @returns The events, any order.
 */
async function refundEventsOf(refundIds: readonly string[], since: number): Promise<SentEvent[]> {
  const events = await stripe.events
    .list({ types: REFUND_EVENT_TYPES, created: { gte: since }, limit: 100 })
    .autoPagingToArray({ limit: 1000 });
  return events
    .map((e) => ({ id: e.id, type: e.type, refundId: (e.data.object as Stripe.Refund).id }))
    .filter((e) => refundIds.includes(e.refundId));
}

/**
 * The event types the product's webhook claimed, by event id.
 * @param eventIds - Stripe event ids.
 * @returns `event_id → type` for the ids claimed.
 */
async function claimedEvents(eventIds: readonly string[]): Promise<Record<string, string>> {
  if (eventIds.length === 0) return {};
  const rows = await suite.sql<{ event_id: string; type: string }[]>`
    SELECT event_id, type FROM stripe_webhook_events WHERE event_id IN ${suite.sql(eventIds)}
  `;
  return Object.fromEntries(rows.map((r) => [r.event_id, r.type]));
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
    "approve books it; the reconcile finds it failed; the preview judges no create (action null), lists the lot as a refund failure and opens restore; resolved-outside answers for it; restore is then refused for good (paid_outside) @needs-payments",
    async () => {
      const { lot, failedId } = await bookedThenFailed();

      await expectFailedRefundPreview(lot, failedId);
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
      expect(after.json.refundFailure).toBe(false);
      expect(after.json.restoreCredits).toMatchObject({ outcome: "blocked", code: "stripe_blocks", reason: "paid_outside" });
      expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
      expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });

      // §5.3: money already reached the buyer outside the system, so the
      // credits are never given back on top of it.
      const restore = await post(paths.restoreCredits(lot.lotId), {
        reason: "The buyer asked for the credits instead.",
        failedRefundIds: [],
      });

      expect(restore.status).toBe(409);
      expect(errorShape(restore.json)).toMatchObject({ code: "stripe_blocks", reason: "paid_outside" });
      expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
      expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
      expect((await bellsOf(suite.sql, lot.userId)).map((b) => b.type)).toEqual(["credit.refund_completed"]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "after the refund failed Stripe refuses a new refund of the payment (a first-request 400, the reason approve and retry are blocked by refund_failed); the buyer takes the credits back: lot active, credits back by a refund_reversed row, bell credit.refund_restored @needs-payments",
    async () => {
      const { lot, failedId } = await bookedThenFailed();
      await expectFailedRefundPreview(lot, failedId);

      // §5.2, §9 "no Stripe create after a failed refund": the product
      // never asks; asked directly, Stripe refuses on the first request.
      const direct = await stripe.refunds
        .create({ payment_intent: lot.paymentIntentId })
        .then(() => null, (err: unknown) => err);
      expect(direct).toBeInstanceOf(Stripe.errors.StripeError);
      const err = direct as Stripe.errors.StripeError;
      expectRefusal("refunds.create after a failed refund", {
        httpStatus: err.statusCode,
        type: err.rawType,
        code: err.code,
        shouldRetry: err.headers?.["stripe-should-retry"],
        message: err.message,
      });
      expect(err.message).toMatch(/A previous attempt to refund charge .+ failed/);
      expect((await stripeRefundsOf(lot.paymentIntentId)).map((r) => r.id)).toEqual([failedId]);

      const restore = await post(paths.restoreCredits(lot.lotId), {
        reason: "The card refund failed; the buyer agreed to take the credits back.",
        failedRefundIds: [failedId],
      });

      expect(restore.status).toBe(200);
      const opId: string = restore.json.id;
      expect(restore.json).toMatchObject({
        kind: "restore_credits",
        status: "succeeded",
        result: "restored",
        failedRefundIds: [failedId],
      });
      await mailsSettled(suite.sql, lot);
      await expectRestored(suite.sql, lot, opId, { wasBooked: true, resolved: [failedId], mailStatuses: MAIL_FINISHED });
      await expectRestoredBell(suite.sql, lot);
      expect((await stripeRefundsOf(lot.paymentIntentId)).map((r) => r.id)).toEqual([failedId]);
      expect(await unresolvedViewOf(suite.sql, lot.lotId)).toEqual([]);
      expect(await inFailureList(suite.sql, lot.lotId)).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("a disputed charge (pm_card_createDispute)", () => {
  it(
    "once Stripe reports the charge disputed, approve is refused by Stripe on the first request: needs_attention stripe_declined, the lot stays refunding, nothing on Stripe; restore is refused (disputed) @needs-payments",
    async () => {
      const lot = await paidLot("pm_card_createDispute");
      await vi.waitFor(
        async () => {
          const intent = await stripe.paymentIntents.retrieve(lot.paymentIntentId, { expand: ["latest_charge"] });
          expect((intent.latest_charge as Stripe.Charge | null)?.disputed).toBe(true);
        },
        { timeout: DISPUTED_WITHIN_MS, interval: 3_000 },
      );

      const res = await post(paths.approve(lot.lotId), APPROVE, freshKey("approve"));

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ kind: "approve", status: "needs_attention", result: null, attentionReason: "stripe_declined" });
      const opId: string = res.json.id;
      const declined = (await eventsOf(suite.sql, opId)).find((e) => e.event === EVENT_NAME.E6);
      expect(declined).toMatchObject({ from_status: "started", to_status: "needs_attention" });
      const detail = declined!.detail;
      expectRefusal("approve on a disputed charge", {
        httpStatus: detail.httpStatus as number | undefined,
        type: detail.type as string | undefined,
        code: detail.code as string | undefined,
        shouldRetry: detail.shouldRetry === undefined ? undefined : String(detail.shouldRetry),
        message: String(detail.message),
      });
      expect(await stripeRefundsOf(lot.paymentIntentId)).toEqual([]);
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
      expect(await inFailureList(suite.sql, lot.lotId)).toBe(true);

      const preview = await call(suite.baseUrl, paths.preview(lot.lotId));
      expect(preview.json.disputed).toBe(true);
      expect(preview.json.restoreCredits).toMatchObject({ outcome: "blocked", code: "stripe_blocks", reason: "disputed" });
      const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

      const restore = await post(paths.restoreCredits(lot.lotId), {
        reason: "The buyer asked for the credits instead.",
        failedRefundIds: [],
      });

      expect(restore.status).toBe(409);
      expect(errorShape(restore.json)).toMatchObject({ code: "stripe_blocks", reason: "disputed" });
      expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("a refund Stripe holds as pending and that later succeeds (pm_card_pendingRefund)", () => {
  it(
    "approve answers 202 awaiting_stripe on the pending refund; a later list read by the refund loop books it: lot refunded, one refund ledger row, copy succeeded, bell written @needs-payments",
    async () => {
      const lot = await paidLot("pm_card_pendingRefund");

      const res = await post(paths.approve(lot.lotId), APPROVE, freshKey("approve"));

      // §5.4: a `pending` create answer is E5, started → awaiting_stripe (§6.2).
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ kind: "approve", status: "awaiting_stripe", result: null, attentionReason: null });
      const opId: string = res.json.id;
      const refundId: string = res.json.stripeRefundId;
      expect(refundId).toMatch(/^re_/);
      const onStripe = await stripeRefundsOf(lot.paymentIntentId);
      expect(onStripe).toHaveLength(1);
      expect(onStripe[0]).toMatchObject({ id: refundId, amount: PAID_CENTS, metadata: { refund_operation_id: opId } });
      expect(await eventsOf(suite.sql, opId)).toContainEqual(
        expect.objectContaining({ event: EVENT_NAME.E5, from_status: "started", to_status: "awaiting_stripe" }),
      );
      // §5.1, §6.4: while pending, the copy holds Stripe's pending_reason.
      // Only a forwarded webhook can have moved the copy on by now.
      const pendingCopy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === refundId)!;
      if (!FORWARDING) expect(pendingCopy.status).toBe("pending");
      if (pendingCopy.status === "pending") {
        const reason = (await pendingReasonsOf(suite.sql, lot.lotId))[refundId];
        console.info(`@needs-payments observed: pm_card_pendingRefund pending_reason ${JSON.stringify(onStripe[0]!.pending_reason)}`);
        expect(["processing", "insufficient_funds", "charge_pending"]).toContain(reason);
        if (onStripe[0]!.status === "pending") expect(reason).toBe(onStripe[0]!.pending_reason);
      }

      // §7.1 step 2 and §7.2: the loop reads refunds.list and re-judges the
      // waiting disposition once Stripe has moved the refund to succeeded.
      await loopUntil(async () => {
        expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
      }, FAILED_LATER_WITHIN_MS);

      expect((await stripeRefundsOf(lot.paymentIntentId)).map((r) => [r.id, r.status])).toEqual([[refundId, "succeeded"]]);
      expect(await eventsOf(suite.sql, opId)).toContainEqual(
        expect.objectContaining({ event: EVENT_NAME.E2, from_status: "awaiting_stripe", to_status: "succeeded" }),
      );
      await expectBookedOn(lot, refundId);
      expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
        expect.objectContaining({
          stripe_refund_id: refundId,
          operation_id: opId,
          amount_cents: PAID_CENTS,
          status: "succeeded",
          ever_succeeded: true,
        }),
      ]);
      // §6.4: pending_reason is empty once the refund is no longer pending.
      expect(await pendingReasonsOf(suite.sql, lot.lotId)).toEqual({ [refundId]: null });
      const bells = await bellsOf(suite.sql, lot.userId);
      expect(bells).toHaveLength(1);
      expect(bells[0]).toMatchObject({ type: "credit.refund_completed" });
      expect(bells[0]!.payload.lotId).toBe(lot.lotId);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("the three refund webhooks, forwarded by the Stripe CLI", () => {
  it(
    "refund.created and refund.updated (pm_card_pendingRefund) and refund.created and refund.failed (pm_card_refundFail) are delivered and claimed, and their Stripe reads alone finish the pending approve and mark the failed refund — no loop run, no further request @needs-payments",
    async (ctx) => {
      ctx.skip(!FORWARDING, NOT_FORWARDING);
      // A minute of slack for the gap between this clock and Stripe's.
      const since = Math.floor(Date.now() / 1000) - 60;
      const pendingLot = await paidLot("pm_card_pendingRefund");
      const failLot = await paidLot("pm_card_refundFail");

      const pending = await post(paths.approve(pendingLot.lotId), APPROVE, freshKey("approve"));
      const failing = await post(paths.approve(failLot.lotId), APPROVE, freshKey("approve"));

      expect(pending.status).toBe(202);
      expect(failing.status).toBe(200);
      expect(failing.json).toMatchObject({ kind: "approve", status: "succeeded", result: "refunded" });
      const pendingOpId: string = pending.json.id;
      const pendingRefundId: string = pending.json.stripeRefundId;
      const failedRefundId: string = failing.json.stripeRefundId;

      // Nothing else reads Stripe for these two payments: the refund loop is
      // not started in tests and no request names them again.
      await vi.waitFor(
        async () => {
          expect(await readOp(suite.sql, pendingOpId)).toMatchObject({ status: "succeeded", result: "refunded" });
          const failedCopy = (await copiesOf(suite.sql, failLot.lotId)).find((c) => c.stripe_refund_id === failedRefundId);
          expect(failedCopy).toMatchObject({ status: "failed", ever_succeeded: true, resolved_by_operation_id: null });
        },
        { timeout: FAILED_LATER_WITHIN_MS, interval: 3_000 },
      );
      expect(await eventsOf(suite.sql, pendingOpId)).toContainEqual(
        expect.objectContaining({
          event: EVENT_NAME.E2,
          from_status: "awaiting_stripe",
          to_status: "succeeded",
          detail: expect.objectContaining({ actor: "webhook" }),
        }),
      );
      await expectBookedOn(pendingLot, pendingRefundId);
      // §6.3 L8: a booked lot stays refunded; the failed refund is listed as unresolved.
      expect(await readLot(suite.sql, failLot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });

      // Every refund event Stripe sent for the two refunds reached the
      // webhook and was claimed under its own type.
      await vi.waitFor(
        async () => {
          const sent = await refundEventsOf([pendingRefundId, failedRefundId], since);
          const typesOf = (refundId: string) => sent.filter((e) => e.refundId === refundId).map((e) => e.type);
          expect(typesOf(pendingRefundId)).toEqual(expect.arrayContaining(["refund.created", "refund.updated"]));
          expect(typesOf(failedRefundId)).toEqual(expect.arrayContaining(["refund.created", "refund.failed"]));
          expect(await claimedEvents(sent.map((e) => e.id))).toEqual(Object.fromEntries(sent.map((e) => [e.id, e.type])));
          const attempts = await suite.sql`
            SELECT event_id, event_type, account_id, endpoint_id, livemode,
              connected_account_id, response_status, result, finished_at IS NOT NULL AS finished
            FROM stripe_webhook_attempts WHERE event_id IN ${suite.sql(sent.map(e => e.id))} AND deleted_at IS NULL
          `;
          const account = await stripe.accounts.retrieve();
          expect(process.env.STRIPE_WEBHOOK_ACCOUNT_ID).toBe(account.id);
          for (const event of sent) {
            expect(attempts).toContainEqual({
              event_id: event.id, event_type: event.type, account_id: account.id,
              endpoint_id: null, livemode: false, connected_account_id: null,
              response_status: 200, result: "refund_synced", finished: true,
            });
          }
          console.info(`@needs-payments attempt recording observed: ${JSON.stringify({
            eventTypes: [...new Set(sent.map(event => event.type))].sort(),
            eventCount: sent.length, completedAttempts: attempts.filter(attempt => attempt.finished).length,
            mode: "test", endpoint: "unknown_cli_forwarding", responseStatus: 200, result: "refund_synced",
          })}`);
        },
        { timeout: 60_000, interval: 3_000 },
      );
    },
    CASE_TIMEOUT_MS,
  );
});
