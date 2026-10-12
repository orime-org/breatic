// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The self-renewing refund loop (inner#1410 §7.1), steps 1, 2 and 4, on real
 * Postgres and Redis with the stateful fake Stripe. Step 3 (mail) is not
 * covered here.
 *
 * Contract this suite drives — `packages/server/src/modules/credit-refund/refund-loop.ts`:
 *
 *   export function runRefundLoopOnce(): Promise<void>
 *     One tick: step 1, then step 2, then step 4.
 *
 *     Step 1 — claim a `started` disposition whose `locked_until < now()` and
 *       `next_attempt_at <= now()`, one row per claim
 *       (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`),
 *       repeated until none is claimable. A claim is E13 through
 *       `transitionOperation` (event `claimed`, a new lease). Then, when
 *       `attemptsExhausted(attempt_count)` → E11 (`needs_attention`,
 *       `attempts_exhausted`, no Stripe call); otherwise `executeRefund` with
 *       the row under the new lease.
 *
 *     Step 2 — every `awaiting_stripe` disposition with
 *       `next_attempt_at <= now()`, with or without a refund id:
 *       `listRefunds(payment_intent)` → `applyRefundSnapshot`. The row's
 *       `next_attempt_at` then lies in the future by the backoff, never more
 *       than `backoff_max_seconds` from now. A row with no refund id 24 hours
 *       after `first_called_at` → E12 (`needs_attention`,
 *       `stripe_result_unknown`). A failed read → E16 (stays, `last_error`
 *       kept, `attempt_count` unchanged, backoff).
 *
 *     Step 4 — calls `runDailyReconcile()` from `reconcile.ts` every tick;
 *       that function decides for itself whether the daily pass is due (§7.2)
 *       and takes the Redis lock.
 *
 *   export function startRefundLoop(): { stop: () => Promise<void> }
 *     Written like `startLifecycleRelay`: the first tick runs at once, the
 *     next is scheduled `loop_interval_seconds` after the previous one
 *     settled. When `env.INTERNAL_API_ENABLED` or `env.PAYMENT_ENABLED` is
 *     false it schedules nothing and returns a handle whose `stop` resolves.
 *     `stop()` resolves once an in-flight tick has settled. `index.ts` calls
 *     it after listen and puts `stop` into the shutdown `drains`.
 *
 * Every case first parks dispositions other suites left in flight
 * (`parkInFlightOperations`) and marks the daily reconcile as just finished,
 * so a tick sees only the rows the case seeded; the step 4 case clears that.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { env, getRedis, initCore } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { executeRefund } from "@server/modules/credit-refund/executor.js";
import { findById } from "@server/modules/credit-refund/operation.repo.js";
import { runRefundLoopOnce, startRefundLoop } from "@server/modules/credit-refund/refund-loop.js";
import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import {
  CREDITS,
  PAID_CENTS,
  bellsOf,
  copiesOf,
  dbClockUs,
  eventsOf,
  ledgerOf,
  readLot,
  readOp,
  refundObject,
  reId,
  giveIntentlessPaymentsAnIntent,
  parkInFlightOperations,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  type LotState,
  type RefundFixture,
  type SeedOp,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useRefundSuite("credit-refund-loop-test");

const US = 1_000_000;

beforeEach(async () => {
  fakeStripe.reset();
  await parkInFlightOperations(suite.sql);
  // Step 4 runs every tick; a reconcile that just finished is not due, so the
  // tick touches only what the case seeded.
  await suite.sql`
    INSERT INTO credit_refund_reconcile_status (name, last_started_at, last_finished_at, last_ok_at)
    VALUES ('daily', now(), now(), now())
    ON CONFLICT (name) DO UPDATE SET
      last_started_at = now(), last_finished_at = now(), last_ok_at = now(),
      last_error = NULL, failing_payment_ids = '{}', next_retry_at = NULL
  `;
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
 * A disposition seeded on a lot, and the lot.
 * @param state - Where the lot stands.
 * @param op - The disposition.
 * @returns Both.
 */
async function seeded(state: LotState, op: SeedOp): Promise<{ lot: SeededLot; opId: string; leaseToken: string | null }> {
  const lot = await lotOnStripe(state);
  const { id, leaseToken } = await seedOperation(suite.sql, lot, op);
  return { lot, opId: id, leaseToken };
}

/**
 * The create calls made for one payment intent.
 * @param lot - The lot whose payment it is.
 * @returns The calls.
 */
function createsFor(lot: SeededLot) {
  return fakeStripe.createCalls.filter((c) => c.params.payment_intent === lot.paymentIntentId);
}

/**
 * The list calls made for one payment intent.
 * @param lot - The lot whose payment it is.
 * @returns How many.
 */
function listsFor(lot: SeededLot): number {
  return fakeStripe.listedIntents().filter((pi) => pi === lot.paymentIntentId).length;
}

/**
 * The event names of a disposition, oldest first.
 * @param opId - The disposition.
 * @returns The names.
 */
async function eventNames(opId: string): Promise<string[]> {
  return (await eventsOf(suite.sql, opId)).map((e) => e.event);
}

/**
 * The lot booked as refunded on `refundId`.
 * @param lot - The lot.
 * @param refundId - The ledger row's reference.
 */
async function expectBookedOn(lot: SeededLot, refundId: string): Promise<void> {
  expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunded", remaining: "0.000000" });
  expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
    { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: refundId },
  ]);
}

/**
 * Move a disposition's `next_attempt_at`.
 * @param opId - The disposition.
 * @param seconds - Seconds from now (negative for the past).
 */
async function setNextAttempt(opId: string, seconds: number): Promise<void> {
  await suite.sql`
    UPDATE credit_refund_operations
    SET next_attempt_at = now() + make_interval(secs => ${seconds}::double precision)
    WHERE id = ${opId}
  `;
}

/**
 * A promise and the function that settles it.
 * @returns Both.
 */
function gate(): { until: Promise<void>; open: () => void } {
  let open!: () => void;
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open };
}

// ── step 1: started dispositions whose executor is gone ──────────────

describe("step 1 — claim and resume a started disposition", () => {
  it("claims a started row whose lease ran out and whose attempt is due, and runs it to the end", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });

    await runRefundLoopOnce();

    const calls = createsFor(lot);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ idempotencyKey: `credit-refund-${opId}` });
    expect(calls[0]!.params).toMatchObject({ metadata: { refund_operation_id: opId } });
    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "succeeded", result: "refunded", lease_token: null });
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    await expectBookedOn(lot, created!.id);
    expect(await eventNames(opId)).toEqual(["claimed", "refund_succeeded"]);
    const [claimed] = await eventsOf(suite.sql, opId);
    expect(claimed).toMatchObject({ from_status: "started", to_status: "started" });
  });

  it("leaves a started row alone while its executor still holds the lease", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started" });
    const before = await readOp(suite.sql, opId);

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toEqual(before);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
  });

  it("leaves a started row alone until its next attempt is due", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });
    await setNextAttempt(opId, 3600);
    const before = await readOp(suite.sql, opId);

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toEqual(before);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
  });

  it("does not touch an awaiting_stripe row in step 1, nor a started one in step 2", async () => {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "pending", PAID_CENTS, opId)]);
    const held = await seeded("refunding", { kind: "approve", status: "started" });

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(listsFor(held.lot)).toBe(0);
    expect(createsFor(held.lot)).toEqual([]);
  });

  it("two ticks at once on one due row: one claim, one Stripe create", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });

    await Promise.all([runRefundLoopOnce(), runRefundLoopOnce()]);

    expect(createsFor(lot)).toHaveLength(1);
    expect((await eventNames(opId)).filter((e) => e === "claimed")).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
  });

  it("a second tick while the first still waits on Stripe claims nothing", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });
    const hold = gate();
    fakeStripe.nextCreate({ kind: "hang", until: hold.until, then: { kind: "refund", status: "succeeded" } });

    const first = runRefundLoopOnce();
    await vi.waitFor(() => expect(createsFor(lot)).toHaveLength(1), { timeout: 10_000 });
    await runRefundLoopOnce();
    expect(createsFor(lot)).toHaveLength(1);
    hold.open();
    await first;

    expect(createsFor(lot)).toHaveLength(1);
    expect((await eventNames(opId)).filter((e) => e === "claimed")).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
  });

  it("E11: attempts used up → needs_attention attempts_exhausted, without calling Stripe", async () => {
    const { maxAttempts } = getCreditRefundConfig();
    const { lot, opId } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: maxAttempts,
    });

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "attempts_exhausted",
      lease_token: null,
      attempt_count: maxAttempts,
    });
    expect(await eventNames(opId)).toEqual(["claimed", "attempts_exhausted"]);
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
  });

  it("one attempt below the cap still calls Stripe", async () => {
    const { maxAttempts } = getCreditRefundConfig();
    const { lot, opId } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: maxAttempts - 1,
    });

    await runRefundLoopOnce();

    expect(createsFor(lot)).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
  });

  it("a retryable answer pushes the next attempt out, so the next tick does not call Stripe again", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });
    fakeStripe.nextCreate({ kind: "error", error: stripeError(429) });
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();

    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "started", attempt_count: 1 });
    expect(op.next_attempt_us!).toBeGreaterThan(before);
    await runRefundLoopOnce();
    expect(createsFor(lot)).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started", attempt_count: 1 });
  });

  it("the old holder's late answer is discarded after the loop took the row over", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });
    const stale = (await findById(opId))!;
    const hold = gate();
    // The old holder's call hangs and then times out on a 5xx; the loop's
    // call under the same key gets the refund.
    fakeStripe.nextCreate({ kind: "hang", until: hold.until, then: { kind: "error", error: stripeError(500) } });
    fakeStripe.nextCreate({ kind: "refund", status: "succeeded" });

    const oldHolder = executeRefund(stale);
    await vi.waitFor(() => expect(createsFor(lot)).toHaveLength(1), { timeout: 10_000 });
    await runRefundLoopOnce();
    const afterLoop = await readOp(suite.sql, opId);
    expect(afterLoop).toMatchObject({ status: "succeeded", result: "refunded" });
    hold.open();
    await oldHolder;

    expect(await readOp(suite.sql, opId)).toEqual(afterLoop);
    const events = await eventsOf(suite.sql, opId);
    expect(events.at(-1)).toMatchObject({ event: "late_answer", from_status: "succeeded", to_status: "succeeded" });
    expect(createsFor(lot).map((c) => c.options?.idempotencyKey)).toEqual([
      `credit-refund-${opId}`,
      `credit-refund-${opId}`,
    ]);
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toHaveLength(1);
  });
});

// ── step 2: dispositions waiting on Stripe ───────────────────────────

describe("step 2 — re-read Stripe for awaiting_stripe dispositions", () => {
  /**
   * An approval waiting on its own refund, which Stripe holds in `status`.
   * @param status - Stripe's status for the refund.
   * @param firstCalledHoursAgo - When the first create call was made.
   * @returns The lot, the disposition and its refund id.
   */
  async function awaitingOwn(
    status: RefundFixture["status"],
    firstCalledHoursAgo = 1,
  ): Promise<{ lot: SeededLot; opId: string; own: string }> {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, status, PAID_CENTS, opId)]);
    return { lot, opId, own };
  }

  /**
   * An approval left waiting after a 5xx: no refund id.
   * @param firstCalledHoursAgo - When the first create call was made.
   * @param refunds - What Stripe holds, built from the disposition id.
   * @returns The lot and the disposition.
   */
  async function awaitingNoId(
    firstCalledHoursAgo: number,
    refunds: (opId: string) => RefundFixture[] = () => [],
  ): Promise<{ lot: SeededLot; opId: string }> {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: null,
      firstCalledHoursAgo,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, refunds(opId));
    return { lot, opId };
  }

  /**
   * The row's next attempt lies in the future, at least the backoff base and
   * at most the backoff max from the tick.
   * @param opId - The disposition.
   * @param before - Database clock before the tick.
   * @param after - Database clock after the tick.
   */
  async function expectPushedOut(opId: string, before: number, after: number): Promise<void> {
    const { backoffBaseSeconds, backoffMaxSeconds } = getCreditRefundConfig();
    const next = (await readOp(suite.sql, opId)).next_attempt_us!;
    expect(next).toBeGreaterThanOrEqual(before + backoffBaseSeconds * US);
    expect(next).toBeLessThanOrEqual(after + backoffMaxSeconds * US);
  }

  it("still pending: stays, refund id kept, copy written, next attempt pushed out", async () => {
    const { lot, opId, own } = await awaitingOwn("pending");
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();
    const after = await dbClockUs(suite.sql);

    expect(listsFor(lot)).toBeGreaterThanOrEqual(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: own, attempt_count: 0 });
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.operation_id])).toEqual([
      [own, "pending", opId],
    ]);
    expect(await eventsOf(suite.sql, opId)).toEqual([
      expect.objectContaining({ event: "refund_pending", from_status: "awaiting_stripe", to_status: "awaiting_stripe" }),
    ]);
    await expectPushedOut(opId, before, after);
  });

  it("the wait never exceeds backoff_max_seconds, however long the row has waited", async () => {
    const { opId } = await awaitingOwn("pending", 23);
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();
    const after = await dbClockUs(suite.sql);

    await expectPushedOut(opId, before, after);
  });

  it("a row whose next attempt is not due is not read", async () => {
    const { lot, opId } = await awaitingOwn("succeeded");
    await setNextAttempt(opId, 3600);
    const before = await readOp(suite.sql, opId);

    await runRefundLoopOnce();

    expect(listsFor(lot)).toBe(0);
    expect(await readOp(suite.sql, opId)).toEqual(before);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
  });

  it("succeeded since: booked, buyer told", async () => {
    const { lot, opId, own } = await awaitingOwn("succeeded");

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "succeeded",
      result: "refunded",
      settled_succeeded_cents: PAID_CENTS,
    });
    await expectBookedOn(lot, own);
    expect((await bellsOf(suite.sql, lot.userId)).map((b) => b.type)).toEqual(["credit.refund_completed"]);
    expect(await eventNames(opId)).toEqual(["refund_succeeded"]);
  });

  it("failed since: needs_attention stripe_refund_failed_later, lot stays refunding", async () => {
    const { lot, opId } = await awaitingOwn("failed");

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
    });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding", remaining: `${CREDITS}.000000` });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
  });

  it("no refund id, under 24 hours, Stripe has none: stays, refund_not_found, pushed out", async () => {
    const { opId } = await awaitingNoId(2);
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();
    const after = await dbClockUs(suite.sql);

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null, attempt_count: 0 });
    expect(await eventNames(opId)).toEqual(["refund_not_found"]);
    await expectPushedOut(opId, before, after);
  });

  it("no refund id, Stripe now lists one under the disposition's metadata: its id is recorded", async () => {
    const found = reId("found");
    const { opId } = await awaitingNoId(2, (id) => [refundObject(found, "pending", PAID_CENTS, id)]);

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: found });
  });

  it("E12: no refund id 24 hours after the first call → needs_attention stripe_result_unknown", async () => {
    const { lot, opId } = await awaitingNoId(25);

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_result_unknown",
      next_attempt_us: null,
    });
    expect((await eventsOf(suite.sql, opId)).at(-1)).toMatchObject({
      event: "deadline_reached",
      from_status: "awaiting_stripe",
      to_status: "needs_attention",
    });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
  });

  it("with a refund id, 24 hours do not end the wait", async () => {
    const { opId, own } = await awaitingOwn("pending", 30);

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: own, attention_reason: null });
  });

  it("E16: a failed read keeps the error, counts no attempt and backs off", async () => {
    const { opId } = await awaitingOwn("succeeded");
    fakeStripe.failLists(stripeError(500));
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();
    const after = await dbClockUs(suite.sql);

    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "awaiting_stripe", attempt_count: 0 });
    expect(op.last_error).toEqual(expect.any(String));
    expect(op.last_error!.length).toBeGreaterThan(0);
    expect(await eventsOf(suite.sql, opId)).toEqual([
      expect.objectContaining({ event: "stripe_read_failed", from_status: "awaiting_stripe", to_status: "awaiting_stripe" }),
    ]);
    await expectPushedOut(opId, before, after);
  });
});

// ── step 4: the daily reconcile ──────────────────────────────────────

describe("step 4 — the daily reconcile runs from the loop", () => {
  it("a tick runs the reconcile when it is due", async () => {
    await giveIntentlessPaymentsAnIntent(suite.sql);
    await suite.sql`DELETE FROM credit_refund_reconcile_status WHERE name = 'daily'`;
    await getRedis().del(`${env.ENV}:server:refund-reconcile-lock`);
    const lot = await lotOnStripe("refunding");

    await runRefundLoopOnce();

    const [row] = await suite.sql<{ finished: boolean }[]>`
      SELECT last_finished_at IS NOT NULL AS finished
      FROM credit_refund_reconcile_status WHERE name = 'daily'
    `;
    expect(row).toEqual({ finished: true });
    expect(listsFor(lot)).toBeGreaterThanOrEqual(1);
    await getRedis().del(`${env.ENV}:server:refund-reconcile-lock`);
  });
});

// ── startRefundLoop: when the loop runs at all ───────────────────────

describe("startRefundLoop — started only with the internal API and payments on", () => {
  const BASE = {
    ...process.env,
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    INTERNAL_API_SECRET: "internal-secret-loop-suite-0123456789",
  };

  /**
   * Start the loop under the given flags and say whether its first tick read
   * Stripe for a due awaiting disposition.
   * @param flags - The two switches.
   * @param flags.internal - `INTERNAL_API_ENABLED`.
   * @param flags.payments - `PAYMENT_ENABLED`.
   * @param waitMs - How long to give the first tick.
   * @returns Whether Stripe was read for the seeded disposition.
   */
  async function ticked(flags: { internal: boolean; payments: boolean }, waitMs: number): Promise<boolean> {
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "pending", PAID_CENTS, opId)]);
    initCore({
      ...BASE,
      INTERNAL_API_ENABLED: String(flags.internal),
      PAYMENT_ENABLED: String(flags.payments),
    });
    const loop = startRefundLoop();
    try {
      if (flags.internal && flags.payments) {
        await vi.waitFor(() => expect(listsFor(lot)).toBeGreaterThanOrEqual(1), { timeout: waitMs });
      } else {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } finally {
      await loop.stop();
      initCore({ ...BASE, PAYMENT_ENABLED: "true" });
    }
    return listsFor(lot) > 0;
  }

  it.each([
    { internal: false, payments: true },
    { internal: true, payments: false },
    { internal: false, payments: false },
  ])("does not run with INTERNAL_API_ENABLED=$internal, PAYMENT_ENABLED=$payments", async (flags) => {
    expect(await ticked(flags, 1500)).toBe(false);
  });

  it("runs its first tick at once when both are on, and stop() resolves", async () => {
    expect(await ticked({ internal: true, payments: true }, 10_000)).toBe(true);
  });
});
