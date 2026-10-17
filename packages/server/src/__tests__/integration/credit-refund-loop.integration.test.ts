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
 *       `attemptsExhausted(attempt_count)`, Stripe is looked up first
 *       (v8 §6.2 E11, §7.1): a refund carrying the disposition's
 *       `metadata.refund_operation_id` is judged like any other answer;
 *       only a read that succeeded and holds none → E11 (`needs_attention`,
 *       `attempts_exhausted`). A failed read is E16, copy or no copy: the
 *       row stays `started` with one more attempt, and the next claim reads
 *       again. No create in any case. Every attempt that leaves the row
 *       `started` (E7, E16, E17) releases its lease (`locked_until = now()`,
 *       `lease_token` kept), so the next claim waits only on
 *       `next_attempt_at` (v8 round 5, §6.2). `last_error` holds
 *       `refunds.create` errors only; a failed read's text is in its event
 *       row, and an E11 shows the create error (§5.1).
 *       Otherwise `executeRefund` with the row under the new lease.
 *
 *       A resume reads first (§7.1 step 1): when the row's `first_called_at`
 *       is set, `refunds.list` comes before any create. A refund carrying
 *       `metadata.refund_operation_id = op.id` is judged and no create is
 *       made; a failed read is E16 with no create; only when none is found
 *       is `refunds.create` called, under `credit-refund-<id>`. What that
 *       first read listed is copied too, before the later reads (§6.4). A first
 *       execution (`first_called_at` null) still creates first.
 *
 *   export function executeRefund(op): Promise<void>  (executor.ts)
 *     When the create answers with a refund object, that answer is copied
 *     first (R1) and the `refunds.list` read right after it second (R2), in
 *     one transaction (§6.4): the copy ends on the listed status and keeps
 *     `ever_succeeded` from the create answer; when that read fails (E16) the
 *     create answer is still copied. The disposition is judged on the listed
 *     status; a refund that the create answered `succeeded` and the list
 *     shows `failed` is E6 on a copy that once succeeded, which goes to a
 *     person (`stripe_refund_failed_later`); every E6 under `started` goes to
 *     a person and leaves the lot `refunding` (v9 §6.2). When
 *     the answer needs a lookup and nothing is found (E7, E9, E17), the
 *     refunds read in that attempt are still copied (§6.4 R2).
 *
 *     Step 2 — every `awaiting_stripe` disposition with
 *       `next_attempt_at <= now()`, with or without a refund id:
 *       `listRefunds(payment_intent)` → `applyRefundSnapshot`. The row's
 *       `next_attempt_at` then lies in the future by the backoff, never more
 *       than `backoff_max_seconds` from now. A row with no refund id 24 hours
 *       after `first_called_at`, whose read this tick succeeded and holds no
 *       refund of it → E12 (`needs_attention`, `stripe_result_unknown`).
 *       A failed read → E16 (stays, `last_error` untouched, `attempt_count`
 *       unchanged, backoff), past 24 hours too (v8 §6.2, §7.1); when another
 *       writer finished the row while the read failed, nothing is added.
 *       An E12 shows the create error that left the result unknown.
 *
 *     Step 4 — calls `runDailyReconcile()` from `reconcile.ts` every tick;
 *       that function decides for itself whether the daily pass is due (§7.2)
 *       and takes the Redis lock.
 *
 *   export function startRefundLoop(): { stop: () => Promise<void> }
 *     Written like `startLifecycleRelay`: the first tick runs at once, the
 *     next is scheduled `loop_interval_seconds` after the previous one
 *     settled. It runs whenever `env.INTERNAL_API_ENABLED` is true, whatever
 *     `env.PAYMENT_ENABLED` says (§7.1: every disposition the API accepted is
 *     finished by the loop). When `INTERNAL_API_ENABLED` is false it
 *     schedules nothing and returns a handle whose `stop` resolves.
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

import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { env, getRedis, initCore } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { executeRefund } from "@server/modules/credit-refund/executor.js";
import { findById, type CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import { runRefundLoopOnce, startRefundLoop } from "@server/modules/credit-refund/refund-loop.js";
import { followUpOperationLater } from "@server/modules/credit-refund/refund-follow-up.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { aroundNextList, beforeNextList, fakeStripe, gate, stripeError } from "./fake-stripe-refunds.js";
import { mailsSettled } from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  bellsOf,
  copiesOf,
  dbClockUs,
  eventsOf,
  expectLeaseReleased,
  ledgerOf,
  mailsOf,
  readLot,
  readOp,
  refundObject,
  reId,
  giveIntentlessPaymentsAnIntent,
  inTx,
  markReconcileJustFinished,
  parkInFlightOperations,
  seedCopy,
  seedOperation,
  seedRefundLot,
  setLastError,
  useRefundSuite,
  type LotState,
  type OpRow,
  type RefundFixture,
  type SeedOp,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useRefundSuite("credit-refund-loop-test");

const US = 1_000_000;

beforeEach(async () => {
  fakeStripe.reset();
  await parkInFlightOperations(suite.sql);
  await markReconcileJustFinished(suite.sql);
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

  it("E11: attempts used up and Stripe holds no refund of it → looked up first, then needs_attention attempts_exhausted, no create", async () => {
    const { maxAttempts } = getCreditRefundConfig();
    const { lot, opId } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: maxAttempts,
      firstCalledHoursAgo: 1,
    });

    await runRefundLoopOnce();

    expect(listsFor(lot)).toBe(1);
    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "attempts_exhausted",
      lease_token: null,
      attempt_count: maxAttempts,
    });
    expect(await eventNames(opId)).toEqual(["claimed", "attempts_exhausted"]);
    // It rests on a read that worked, so it carries no read failure (v8 §6.2 E11).
    const exhausted = (await eventsOf(suite.sql, opId)).at(-1)!;
    expect(exhausted.detail).toEqual({ actor: "loop" });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
  });

  it("attempts used up, but Stripe holds the approval's refund, succeeded: it is booked, no attempts_exhausted, no create", async () => {
    const { maxAttempts } = getCreditRefundConfig();
    const own = reId("own");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: maxAttempts,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, opId)]);

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "succeeded",
      result: "refunded",
      stripe_refund_id: own,
      attention_reason: null,
    });
    await expectBookedOn(lot, own);
    expect(await eventNames(opId)).toEqual(["claimed", "refund_succeeded"]);
  });

  it("a later attempt refused with a 400, then attempts run out with nothing on Stripe: E17 then E11 → needs_attention stripe_declined (v9 §5.4, §6.2)", async () => {
    const { maxAttempts } = getCreditRefundConfig();
    const { lot, opId } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: maxAttempts - 1,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.nextCreate({ kind: "error", error: stripeError(400, { code: "charge_disputed" }) });

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started", attempt_count: maxAttempts });
    expect(await eventNames(opId)).toEqual(["claimed", "unclassified_error"]);

    await setNextAttempt(opId, -1);
    await runRefundLoopOnce();

    expect(createsFor(lot)).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_declined",
      result: null,
    });
    expect(await eventNames(opId)).toEqual(["claimed", "unclassified_error", "claimed", "attempts_exhausted"]);
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
  });

  it.each([
    { label: "no copy of its refund", copied: false },
    { label: "a copy of its refund, succeeded (from a create answer before an E16)", copied: true },
  ])(
    "attempts used up and the read fails, $label: E16 — stays started with one more attempt, no create, no E11, nothing booked (v8 §6.2 E11)",
    async ({ copied }) => {
      const { maxAttempts } = getCreditRefundConfig();
      const own = reId("own");
      const lot = await seedRefundLot(suite.sql, "refunding");
      const { id: opId } = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "started",
        leaseExpired: true,
        attemptCount: maxAttempts,
        firstCalledHoursAgo: 1,
      });
      if (copied) await seedCopy(suite.sql, lot, { id: own, amountCents: PAID_CENTS, status: "succeeded", operationId: opId });
      fakeStripe.register(lot.paymentIntentId, PAID_CENTS, copied ? [refundObject(own, "succeeded", PAID_CENTS, opId)] : []);
      await setLastError(suite.sql, opId, "synthetic 429");
      fakeStripe.failLists(stripeError(500));

      await runRefundLoopOnce();

      expect(createsFor(lot)).toEqual([]);
      const op = await readOp(suite.sql, opId);
      expect(op).toMatchObject({ status: "started", attempt_count: maxAttempts + 1, result: null, attention_reason: null });
      // last_error keeps the create error; the read failure is in the event row (v8 round 5).
      expect(op.last_error).toBe("synthetic 429");
      await expectLeaseReleased(suite.sql, opId);
      expect(await eventNames(opId)).toEqual(["claimed", "stripe_read_failed"]);
      expect((await eventsOf(suite.sql, opId)).at(-1)!.detail).toMatchObject({ message: "synthetic 500", actor: "loop" });
      expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding", remaining: `${CREDITS}.000000` });
      expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    },
  );

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
    // The old holder starts under a lease it holds with time left, so it
    // reaches refunds.create (§9 arbitration rule).
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started" });
    const stale = (await findById(opId))!;
    const hold = gate();
    // The old holder's call hangs and then times out on a 5xx; the loop's
    // call under the same key gets the refund.
    fakeStripe.nextCreate({ kind: "hang", until: hold.until, then: { kind: "error", error: stripeError(500) } });
    fakeStripe.nextCreate({ kind: "refund", status: "succeeded" });

    const oldHolder = executeRefund(stale, "loop");
    await vi.waitFor(() => expect(createsFor(lot)).toHaveLength(1), { timeout: 10_000 });
    // While its call hangs, the lease runs out and the attempt falls due.
    await suite.sql`
      UPDATE credit_refund_operations
      SET locked_until = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
      WHERE id = ${opId}
    `;
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

  it.each([
    { event: "E7", name: "retryable_error", resumed: false, setup: () => fakeStripe.nextCreate({ kind: "error", error: stripeError(429) }) },
    { event: "E17", name: "unclassified_error", resumed: false, setup: () => fakeStripe.nextCreate({ kind: "error", error: stripeError(402) }) },
    { event: "E16", name: "stripe_read_failed", resumed: true, setup: () => fakeStripe.failLists(stripeError(503)) },
  ])(
    "$event: the attempt ends with the row still started and the lease released, so the next tick claims it as soon as next_attempt_at is due (v8 round 5, §6.2)",
    async ({ name, resumed, setup }) => {
      const { opId } = await seeded("refunding", {
        kind: "approve",
        status: "started",
        leaseExpired: true,
        ...(resumed && { firstCalledHoursAgo: 1, attemptCount: 1 }),
      });
      setup();

      await runRefundLoopOnce();

      expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started" });
      expect(await eventNames(opId)).toEqual(["claimed", name]);
      await expectLeaseReleased(suite.sql, opId);

      // Only the backoff is moved; the lease is left as the attempt left it.
      fakeStripe.failLists(null);
      await setNextAttempt(opId, -1);
      await runRefundLoopOnce();

      expect((await eventNames(opId)).filter((e) => e === "claimed")).toHaveLength(2);
      expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
    },
  );

  it("E11 after a 429 create and a later failed read: attention_detail is the create error, not the read failure (v8 round 5, §5.1)", async () => {
    const { maxAttempts } = getCreditRefundConfig();
    const { lot, opId } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      attemptCount: maxAttempts - 1,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.nextCreate({ kind: "error", error: stripeError(429) });
    await runRefundLoopOnce();
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started", attempt_count: maxAttempts, last_error: "synthetic 429" });

    fakeStripe.failLists(stripeError(503));
    await setNextAttempt(opId, -1);
    await runRefundLoopOnce();
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started", attempt_count: maxAttempts + 1, last_error: "synthetic 429" });
    expect((await eventsOf(suite.sql, opId)).at(-1)).toMatchObject({ event: "stripe_read_failed", detail: { message: "synthetic 503" } });

    fakeStripe.failLists(null);
    await setNextAttempt(opId, -1);
    await runRefundLoopOnce();

    expect(createsFor(lot)).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "attempts_exhausted",
      attention_detail: "synthetic 429",
    });
  });

  it.each([
    { label: "a 429", error: () => stripeError(429) },
    {
      label: "a timeout",
      // stripe-node builds a timeout's error with a message and no type.
      error: () =>
        new Stripe.errors.StripeConnectionError({
          message: "Request was retried 0 times: timed out",
        } as ConstructorParameters<typeof Stripe.errors.StripeConnectionError>[0]),
    },
  ])(
    "the create answers $label and the lookup read after it fails: E16 keeps the create error in last_error and in the event row; a later read that finds nothing with attempts used up → E11 shows it (v8 round 6, §6.2 started × E16)",
    async ({ error }) => {
      const { maxAttempts } = getCreditRefundConfig();
      const { lot, opId } = await seeded("refunding", {
        kind: "approve",
        status: "started",
        leaseExpired: true,
        attemptCount: maxAttempts - 1,
      });
      const createError = error();
      fakeStripe.nextCreate({ kind: "error", error: createError });
      // A first execution makes no pre-read: the one list is the lookup after the create.
      fakeStripe.failLists(stripeError(503));

      await runRefundLoopOnce();

      expect(createsFor(lot)).toHaveLength(1);
      expect(await readOp(suite.sql, opId)).toMatchObject({
        status: "started",
        attempt_count: maxAttempts,
        last_error: createError.message,
      });
      const failed = (await eventsOf(suite.sql, opId)).at(-1)!;
      expect(failed.event).toBe("stripe_read_failed");
      // The row carries both Stripe texts: the read that failed and the create before it.
      expect(JSON.stringify(failed.detail)).toContain("synthetic 503");
      expect(JSON.stringify(failed.detail)).toContain(createError.message);

      fakeStripe.failLists(null);
      await setNextAttempt(opId, -1);
      await runRefundLoopOnce();

      expect(createsFor(lot)).toHaveLength(1);
      expect(await readOp(suite.sql, opId)).toMatchObject({
        status: "needs_attention",
        attention_reason: "attempts_exhausted",
        attention_detail: createError.message.split("\n")[0],
      });
    },
  );
});

// ── step 1: a resume reads Stripe before it creates ──────────────────

describe("step 1 — a resume looks its refund up before it creates (§7.1)", () => {
  /**
   * A started approval whose executor called Stripe before and is gone: the
   * lease ran out and `first_called_at` is set.
   * @param firstCalledHoursAgo - When the first create call was made.
   * @returns The lot and the disposition.
   */
  async function resumable(firstCalledHoursAgo: number): Promise<{ lot: SeededLot; opId: string }> {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "started",
      leaseExpired: true,
      firstCalledHoursAgo,
      attemptCount: 1,
    });
    return { lot, opId };
  }

  /**
   * Run one tick, noting how many creates had been made for the lot when the
   * tick's first `refunds.list` came.
   * @param lot - The lot.
   * @returns The creates made before the first read; -1 when nothing was read.
   */
  async function tickNotingCreatesAtFirstRead(lot: SeededLot): Promise<number> {
    const seen = { creates: -1 };
    beforeNextList(fakeStripe, () => {
      seen.creates = createsFor(lot).length;
    });
    await runRefundLoopOnce();
    return seen.creates;
  }

  it("Stripe holds the disposition's refund (key long expired): it is judged and booked, and refunds.create is not called", async () => {
    const own = reId("own");
    const { lot, opId } = await resumable(30);
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, opId)]);

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "succeeded",
      result: "refunded",
      stripe_refund_id: own,
    });
    await expectBookedOn(lot, own);
    expect(await eventNames(opId)).toEqual(["claimed", "refund_succeeded"]);
  });

  it("the read fails: E16, the row stays started with one more attempt, and refunds.create is not called", async () => {
    const { lot, opId } = await resumable(1);
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
    fakeStripe.failLists(stripeError(500));

    await runRefundLoopOnce();

    expect(createsFor(lot)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started", attempt_count: 2 });
    expect(await eventNames(opId)).toEqual(["claimed", "stripe_read_failed"]);
  });

  it("nothing found: refunds.create is called once, under credit-refund-<id>, after the read", async () => {
    const { lot, opId } = await resumable(1);
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS);

    const createsAtFirstRead = await tickNotingCreatesAtFirstRead(lot);

    expect(createsAtFirstRead).toBe(0);
    expect(createsFor(lot).map((c) => c.options?.idempotencyKey)).toEqual([`credit-refund-${opId}`]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
  });

  it.each([
    {
      label: "the read after the create lists it failed",
      afterCreate: (external: string) => fakeStripe.setStatus(external, "failed"),
      expected: (external: string) => [external, "failed", true],
    },
    {
      label: "the read after the create fails (E16)",
      afterCreate: () => fakeStripe.failLists(stripeError(503)),
      expected: (external: string) => [external, "succeeded", true],
    },
  ])(
    "the pre-read lists an external refund succeeded and none of ours, so it creates; $label: the external refund's copy keeps ever_succeeded (§6.4 '凡是读到就写')",
    async ({ afterCreate, expected }) => {
      const external = reId("external");
      const { lot } = await resumable(1);
      fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(external, "succeeded", 100)]);
      // The first list is the pre-read; the hook it installs runs before the second.
      beforeNextList(fakeStripe, () => beforeNextList(fakeStripe, () => afterCreate(external)));

      await runRefundLoopOnce();

      expect(createsFor(lot)).toHaveLength(1);
      const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === external);
      expect(copy && [copy.stripe_refund_id, copy.status, copy.ever_succeeded]).toEqual(expected(external));
    },
  );

  it("a first execution (first_called_at empty) still creates before it reads", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });

    const createsAtFirstRead = await tickNotingCreatesAtFirstRead(lot);

    expect(createsAtFirstRead).toBe(1);
    expect(createsFor(lot).map((c) => c.options?.idempotencyKey)).toEqual([`credit-refund-${opId}`]);
  });
});

// ── the executor: what it reads after the create ─────────────────────

describe("executeRefund — the list read after the create decides (§5.4, §6.4)", () => {
  /**
   * A started approval under a lease the caller holds, never called yet.
   * @returns The lot, the disposition id and the row to execute.
   */
  async function startedApprove(): Promise<{ lot: SeededLot; opId: string; op: CreditRefundOperation }> {
    const lot = await lotOnStripe("refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
    return { lot, opId, op: (await findById(opId))! };
  }

  /**
   * The refund Stripe holds under the disposition's metadata.
   * @param lot - The lot whose payment it is on.
   * @param opId - The disposition.
   * @returns The refund id.
   */
  function ownOnStripe(lot: SeededLot, opId: string): string {
    const own = fakeStripe.refundsOf(lot.paymentIntentId).find((r) => r.metadata.refund_operation_id === opId);
    if (!own) throw new Error(`no refund on Stripe for disposition ${opId}`);
    return own.id;
  }

  it("create answers succeeded, the list right after says failed: copy failed and ever_succeeded, needs_attention stripe_refund_failed_later, lot stays refunding — no sent_back, no ledger row, no bell, no mail", async () => {
    const { lot, opId, op } = await startedApprove();
    beforeNextList(fakeStripe, () => fakeStripe.setStatus(ownOnStripe(lot, opId), "failed"));

    await executeRefund(op, "loop");

    const own = ownOnStripe(lot, opId);
    expect(createsFor(lot)).toHaveLength(1);
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded])).toEqual([
      [own, "failed", true],
    ]);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
      result: null,
    });
    expect(await eventNames(opId)).toEqual(["refund_declined"]);
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({
      lifecycle: "refunding",
      remaining: `${CREDITS}.000000`,
    });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("create answers succeeded and the list read after it fails: E16, and the create answer is still copied — succeeded, ever_succeeded", async () => {
    const { lot, opId, op } = await startedApprove();
    beforeNextList(fakeStripe, () => fakeStripe.failLists(stripeError(500)));

    await executeRefund(op, "loop");

    const own = ownOnStripe(lot, opId);
    expect(createsFor(lot)).toHaveLength(1);
    expect(await eventNames(opId)).toEqual(["stripe_read_failed"]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "started" });
    expect(
      (await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded, c.operation_id]),
    ).toEqual([[own, "succeeded", true, opId]]);
  });

  it("the create answer itself is a failed refund (never succeeded): E6 → needs_attention stripe_declined, the lot stays refunding (v9 §6.2, acceptance #9)", async () => {
    const { lot, opId, op } = await startedApprove();
    fakeStripe.nextCreate({ kind: "refund", status: "failed" });

    await executeRefund(op, "loop");

    const own = ownOnStripe(lot, opId);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_declined",
      result: null,
      stripe_refund_id: own,
    });
    expect(await eventNames(opId)).toEqual(["refund_declined"]);
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({
      lifecycle: "refunding",
      remaining: `${CREDITS}.000000`,
    });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded])).toEqual([
      [own, "failed", false],
    ]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("Stripe refuses the first request because a refund of this payment failed before (400 'A previous attempt to refund charge … failed'): E6 → needs_attention stripe_declined, lot stays refunding, no refund made (v9 §5.2)", async () => {
    const failedBefore = reId("failed_before");
    const lot = await lotOnStripe("refunding", [refundObject(failedBefore, "failed", 300)]);
    const { id: opId } = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });

    await executeRefund((await findById(opId))!, "loop");

    expect(createsFor(lot)).toHaveLength(1);
    expect(createsFor(lot)[0]!.params).not.toHaveProperty("amount");
    expect(fakeStripe.refundsOf(lot.paymentIntentId).map((r) => r.id)).toEqual([failedBefore]);
    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "needs_attention", attention_reason: "stripe_declined", stripe_refund_id: null });
    expect(op.attention_detail).toMatch(/^A previous attempt to refund charge .* failed$/);
    expect(await eventNames(opId)).toEqual(["refund_declined"]);
    expect((await eventsOf(suite.sql, opId)).at(-1)!.detail).toMatchObject({ httpStatus: 400 });
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding", remaining: `${CREDITS}.000000` });
  });

  it.each([401, 403, 404])(
    "a first-request %i: E6 → needs_attention stripe_request_invalid, lot stays refunding (v9 §5.4)",
    async (httpStatus) => {
      const { lot, opId, op } = await startedApprove();
      fakeStripe.nextCreate({ kind: "error", error: stripeError(httpStatus) });

      await executeRefund(op, "loop");

      expect(await readOp(suite.sql, opId)).toMatchObject({ status: "needs_attention", attention_reason: "stripe_request_invalid" });
      expect(await eventNames(opId)).toEqual(["refund_declined"]);
      expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
    },
  );

  it("create answers pending, the list right after says succeeded: booked, copy ever_succeeded", async () => {
    const { lot, opId, op } = await startedApprove();
    fakeStripe.nextCreate({ kind: "refund", status: "pending" });
    beforeNextList(fakeStripe, () => fakeStripe.setStatus(ownOnStripe(lot, opId), "succeeded"));

    await executeRefund(op, "loop");

    const own = ownOnStripe(lot, opId);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "succeeded",
      result: "refunded",
      stripe_refund_id: own,
    });
    await expectBookedOn(lot, own);
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded])).toEqual([
      [own, "succeeded", true],
    ]);
  });

  /**
   * Run `write` once, after the next `refunds.list` has read what Stripe
   * holds and before it answers: a webhook committing between the
   * executor's read and its answer transaction.
   * @param write - What the webhook commits.
   */
  function betweenNextReadAndAnswer(write: () => Promise<void>): void {
    aroundNextList(fakeStripe, async (read) => {
      const data = await read();
      await write();
      return data;
    });
  }

  it("approve: the list says its refund succeeded, but a webhook already copied it failed with expired_or_canceled_card → judged by the copy, status and failure reason: needs_attention stripe_refund_failed_later, not partial_refund (findings [7][9]; v8 §6.4, round 4 H5)", async () => {
    const { lot, opId, op } = await startedApprove();
    betweenNextReadAndAnswer(() =>
      seedCopy(suite.sql, lot, {
        id: ownOnStripe(lot, opId),
        amountCents: PAID_CENTS,
        status: "failed",
        everSucceeded: true,
        operationId: opId,
        failureReason: "expired_or_canceled_card",
      }),
    );

    await executeRefund(op, "loop");

    const own = ownOnStripe(lot, opId);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
      attention_detail: "expired_or_canceled_card",
      result: null,
    });
    expect((await eventsOf(suite.sql, opId)).at(-1)!.detail).toMatchObject({
      refund: { id: own, status: "failed", failureReason: "expired_or_canceled_card" },
    });
    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded])).toEqual([
      [own, "failed", true],
    ]);
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding", remaining: `${CREDITS}.000000` });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it.each([
    { event: "E9", name: "charge_already_refunded", error: () => stripeError(400, { code: "charge_already_refunded" }) },
    { event: "E7", name: "retryable_error", error: () => stripeError(429) },
    { event: "E17", name: "unclassified_error", error: () => stripeError(402) },
  ])(
    "$event: the lookup finds nothing of ours, and the refunds read are still copied (an external full refund, ever_succeeded)",
    async ({ name, error }) => {
      const external = reId("external");
      const lot = await lotOnStripe("refunding", [refundObject(external, "succeeded", PAID_CENTS)]);
      const { id: opId } = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
      fakeStripe.nextCreate({ kind: "error", error: error() });

      await executeRefund((await findById(opId))!, "loop");

      expect(await eventNames(opId)).toEqual([name]);
      expect(
        (await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded, c.operation_id]),
      ).toEqual([[external, "succeeded", true, null]]);
    },
  );
});

// ── the executor: it creates only under a lease it still holds ───────

describe("executeRefund — refunds.create only under a lease still held with a Stripe call's time left (v8 round 6, §9 arbitration rule)", () => {
  /**
   * Hand the disposition's lease to another claimer, as a later E13 would:
   * a new token, a full lease.
   * @param opId - The disposition.
   */
  async function claimedByAnother(opId: string): Promise<void> {
    await suite.sql`
      UPDATE credit_refund_operations
      SET lease_token = ${randomUUID()}, locked_until = now() + interval '120 seconds'
      WHERE id = ${opId}
    `;
  }

  it("A: a first execution whose token was replaced before it calls Stripe makes no create, writes no event and changes no row", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started" });
    const stale = (await findById(opId))!;
    await claimedByAnother(opId);
    const before = await readOp(suite.sql, opId);

    await executeRefund(stale, "loop");

    expect(createsFor(lot)).toEqual([]);
    expect(fakeStripe.refundsOf(lot.paymentIntentId)).toEqual([]);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toEqual(before);
  });

  /**
   * A started approval that called Stripe before (a resume), on a lot whose
   * payment Stripe holds one external refund, succeeded.
   * @returns The lot, the disposition id and the external refund's id.
   */
  async function resumeWithExternalSucceeded(): Promise<{ lot: SeededLot; opId: string; external: string }> {
    const external = reId("external");
    const { lot, opId } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(external, "succeeded", 100)]);
    return { lot, opId, external };
  }

  /**
   * The copy of one refund on the lot, as [id, status, ever_succeeded].
   * @param lot - The lot.
   * @param refundId - The refund.
   * @returns The triple, or undefined when no copy exists.
   */
  async function copyOf(lot: SeededLot, refundId: string): Promise<[string, string, boolean] | undefined> {
    const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === refundId);
    return copy && [copy.stripe_refund_id, copy.status, copy.ever_succeeded];
  }

  it("A: a resume whose token is replaced while its pre-read is out makes no create, writes no event and changes no row, but still copies what its pre-read listed — an external refund succeeded keeps ever_succeeded (§6.4 '凡是读到就写', round 7)", async () => {
    const { lot, opId, external } = await resumeWithExternalSucceeded();
    const stale = (await findById(opId))!;
    const seen: { row?: OpRow } = {};
    aroundNextList(fakeStripe, async (read) => {
      const data = await read();
      await claimedByAnother(opId);
      seen.row = await readOp(suite.sql, opId);
      return data;
    });

    await executeRefund(stale, "loop");

    expect(createsFor(lot)).toEqual([]);
    expect(listsFor(lot)).toBe(1);
    expect(fakeStripe.refundsOf(lot.paymentIntentId).map((r) => r.id)).toEqual([external]);
    expect(await copyOf(lot, external)).toEqual([external, "succeeded", true]);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toEqual(seen.row);
  });

  it("B: the row still holds its token but less than stripe_call_timeout_ms of the lease is left: no create, no event, no row change", async () => {
    const { stripeCallTimeoutMs } = getCreditRefundConfig();
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started" });
    await suite.sql`
      UPDATE credit_refund_operations
      SET locked_until = now() + make_interval(secs => ${(stripeCallTimeoutMs - 5000) / 1000}::double precision)
      WHERE id = ${opId}
    `;
    const op = (await findById(opId))!;
    const before = await readOp(suite.sql, opId);

    await executeRefund(op, "loop");

    expect(createsFor(lot)).toEqual([]);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toEqual(before);
  });

  it("B: a resume with too little lease left makes no create, writes no event and changes no row, but still copies what its pre-read listed — an external refund succeeded keeps ever_succeeded (§6.4 '凡是读到就写', round 7)", async () => {
    const { stripeCallTimeoutMs } = getCreditRefundConfig();
    const { lot, opId, external } = await resumeWithExternalSucceeded();
    await suite.sql`
      UPDATE credit_refund_operations
      SET locked_until = now() + make_interval(secs => ${(stripeCallTimeoutMs - 5000) / 1000}::double precision)
      WHERE id = ${opId}
    `;
    const op = (await findById(opId))!;
    const before = await readOp(suite.sql, opId);

    await executeRefund(op, "loop");

    expect(createsFor(lot)).toEqual([]);
    expect(listsFor(lot)).toBe(1);
    expect(await copyOf(lot, external)).toEqual([external, "succeeded", true]);
    expect(await eventsOf(suite.sql, opId)).toEqual([]);
    expect(await readOp(suite.sql, opId)).toEqual(before);
  });

  it("C (control): a lease still held with its time left creates as before", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started" });

    await executeRefund((await findById(opId))!, "loop");

    expect(createsFor(lot).map((c) => c.options?.idempotencyKey)).toEqual([`credit-refund-${opId}`]);
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
  });
});

describe("executeRefund — a stale attempt whose copy finishes another disposition (§6.5 M1, round 9 [2][6])", () => {
  it.each([
    { exit: "its pre-read finds its own refund (late_answer)", ownListed: true },
    { exit: "its pre-read finds none of its own and the lease refuses the create", ownListed: false },
  ])(
    "$exit: the other disposition's buyer mail is sent right after the executor's commit, not left for the sweep",
    async ({ ownListed }) => {
      const ownA = reId("own-a");
      const ownB = reId("own-b");
      const lot = await lotOnStripe("refunding");
      const { id: a } = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "started",
        leaseExpired: true,
        firstCalledHoursAgo: 1,
        attemptCount: 1,
      });
      let b = "";
      aroundNextList(fakeStripe, async (read) => {
        // While the loop's attempt on A has its pre-read out, another instance
        // took A over and finished it, and a retry B was accepted whose refund
        // Stripe now shows succeeded.
        await suite.sql`
          UPDATE credit_refund_operations
          SET status = 'needs_attention', attention_reason = 'stripe_refund_failed_later',
              attention_detail = 'seeded', lease_token = NULL, locked_until = NULL,
              next_attempt_at = NULL, finished_at = now()
          WHERE id = ${a}
        `;
        ({ id: b } = await seedOperation(suite.sql, lot, {
          kind: "retry",
          status: "awaiting_stripe",
          stripeRefundId: ownB,
          firstCalledHoursAgo: 0,
          notify: true,
        }));
        // Step 2 of this tick must not be the one to read B.
        await setNextAttempt(b, 3600);
        fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
          ...(ownListed ? [refundObject(ownA, "failed", PAID_CENTS, a)] : []),
          refundObject(ownB, "succeeded", PAID_CENTS, b),
        ]);
        return read();
      });

      await runRefundLoopOnce();

      expect(createsFor(lot)).toEqual([]);
      // The exit taken: only judging its own refund answers A, late.
      expect((await eventNames(a)).includes("late_answer")).toBe(ownListed);
      expect(await readOp(suite.sql, b)).toMatchObject({ status: "succeeded", result: "refunded" });
      // B's mail row is seconds old, so this tick's sweep (rows pending over a
      // minute) did not take it, and no later tick runs: only a send after the
      // executor's commit can move it.
      expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
        expect.objectContaining({ operation_id: b, kind: "refund_completed", origin: "auto" }),
      ]);
      await mailsSettled(suite.sql, lot);
    },
  );

  /**
   * Approval A's first attempt creates, and its create answers a refund
   * object; while the list read after it is out, another instance has taken
   * A over and finished it, and retry B was accepted and left
   * `awaiting_stripe` with no refund id (its create got a 5xx). The list read
   * then fails, or holds B's refund succeeded.
   * @param listFails - Whether the list read after A's create fails (E16).
   * @returns The lot, A and B.
   */
  async function staleCreateWithWaitingRetry(listFails: boolean): Promise<{ lot: SeededLot; a: string; b: string }> {
    const ownB = reId("own-b");
    const { lot, opId: a } = await seeded("refunding", { kind: "approve", status: "started" });
    // A's refund failed, so B's succeeded refund alone settles the payment.
    fakeStripe.nextCreate({ kind: "refund", status: "failed" });
    let b = "";
    aroundNextList(fakeStripe, async (read) => {
      await suite.sql`
        UPDATE credit_refund_operations
        SET status = 'needs_attention', attention_reason = 'stripe_refund_failed_later',
            attention_detail = 'seeded', lease_token = NULL, locked_until = NULL,
            next_attempt_at = NULL, finished_at = now()
        WHERE id = ${a}
      `;
      ({ id: b } = await seedOperation(suite.sql, lot, {
        kind: "retry",
        status: "awaiting_stripe",
        stripeRefundId: null,
        firstCalledHoursAgo: 0,
        notify: true,
      }));
      if (listFails) throw stripeError(500);
      fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
        ...fakeStripe.refundsOf(lot.paymentIntentId),
        refundObject(ownB, "succeeded", PAID_CENTS, b),
      ]);
      return read();
    });
    await executeRefund((await findById(a))!, "loop");
    // The exit taken: A's lease is gone, so its own answer lands late.
    expect(await eventNames(a)).toContain("late_answer");
    return { lot, a, b };
  }

  it("a create answer is copied but judges no other disposition: when the list read after it fails (E16), the waiting retry gets no event at all (round 10 [1])", async () => {
    const { lot, b } = await staleCreateWithWaitingRetry(true);

    // No refunds.list read held anything of B: no 'refund_not_found' (E10).
    expect(await eventsOf(suite.sql, b)).toEqual([]);
    expect(await readOp(suite.sql, b)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null });
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("a create answer is copied but judges no other disposition: when the list read after it succeeds, the waiting retry is judged once, from the list, and mailed once (round 10 [1])", async () => {
    const { lot, b } = await staleCreateWithWaitingRetry(false);

    expect(await eventNames(b)).toEqual(["refund_succeeded"]);
    expect(await readOp(suite.sql, b)).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ operation_id: b, kind: "refund_completed", origin: "auto" }),
    ]);
    await mailsSettled(suite.sql, lot);
    // Processed once: this suite has no SMTP transport, so the send records
    // `skipped` (refund-mail.ts), not `sent`.
    expect((await mailsOf(suite.sql, lot.lotId)).map((m) => [m.operation_id, m.status])).toEqual([[b, "skipped"]]);
  });

  it("an empty refunds.list read judges the waiting retry too, like every other list reader: a stale resume whose pre-read lists nothing and whose lease refuses the create gives the waiting retry one 'refund_not_found' (round 11 P4)", async () => {
    // A resume of approval A: its pre-read is a refunds.list read, and no
    // create follows it once the lease is gone.
    const { lot, opId: a } = await seeded("refunding", {
      kind: "approve",
      status: "started",
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    const stale = (await findById(a))!;
    let b = "";
    aroundNextList(fakeStripe, async (read) => {
      // While the pre-read is out, another instance took A over and finished
      // it, and retry B was accepted and left awaiting_stripe with no refund
      // id (its create got a 5xx). Stripe holds no refund of the payment.
      await suite.sql`
        UPDATE credit_refund_operations
        SET status = 'needs_attention', attention_reason = 'stripe_refund_failed_later',
            attention_detail = 'seeded', lease_token = NULL, locked_until = NULL,
            next_attempt_at = NULL, finished_at = now()
        WHERE id = ${a}
      `;
      ({ id: b } = await seedOperation(suite.sql, lot, {
        kind: "retry",
        status: "awaiting_stripe",
        stripeRefundId: null,
        firstCalledHoursAgo: 0,
      }));
      return read();
    });

    await executeRefund(stale, "loop");

    expect(createsFor(lot)).toEqual([]);
    expect(listsFor(lot)).toBe(1);
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([]);
    // The lease-refusal exit: A gets no event from this stale attempt.
    expect(await eventsOf(suite.sql, a)).toEqual([]);
    // The empty list is Stripe's whole answer for the payment: B is judged on
    // it, once, as the loop, exactly as step 2 and the reconcile would.
    expect((await eventsOf(suite.sql, b)).map((e) => [e.event, e.detail.actor])).toEqual([["refund_not_found", "loop"]]);
    expect(await readOp(suite.sql, b)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null });
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

  it("succeeded since: the buyer mail is sent right after the booking commits, not left for the sweep (§6.5 M1)", async () => {
    const { lot, opId } = await awaitingOwn("succeeded");

    await runRefundLoopOnce();

    // The row is seconds old, so this tick's step 3 (rows pending over a
    // minute) did not take it: only the send after the commit can.
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ operation_id: opId, kind: "refund_completed", origin: "auto" }),
    ]);
    await mailsSettled(suite.sql, lot);
  });

  it("the read finishes a different disposition than the one listed: that one's buyer mail is sent right after the commit, not left for the sweep (§6.5 M1, round 8 [3])", async () => {
    const ownA = reId("own-a");
    const ownR = reId("own-r");
    const lot = await seedRefundLot(suite.sql, "refunding");
    const { id: a } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: ownA,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(ownA, "pending", PAID_CENTS, a)]);
    let r = "";
    aroundNextList(fakeStripe, async (read) => {
      // Between the tick listing A and its read: A's refund failed and went to
      // a person, and a retry R was accepted; Stripe now shows R succeeded.
      await suite.sql`
        UPDATE credit_refund_operations
        SET status = 'needs_attention', attention_reason = 'stripe_refund_failed_later',
            attention_detail = 'seeded', next_attempt_at = NULL, finished_at = now()
        WHERE id = ${a}
      `;
      ({ id: r } = await seedOperation(suite.sql, lot, {
        kind: "retry",
        status: "awaiting_stripe",
        stripeRefundId: ownR,
        firstCalledHoursAgo: 0,
        notify: true,
      }));
      fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
        refundObject(ownA, "failed", PAID_CENTS, a),
        refundObject(ownR, "succeeded", PAID_CENTS, r),
      ]);
      return read();
    });

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, r)).toMatchObject({ status: "succeeded", result: "refunded" });
    // R's mail row is seconds old, so this tick's sweep (rows pending over a
    // minute) did not take it, and no later tick runs: only the send after
    // the commit can move it.
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ operation_id: r, kind: "refund_completed", origin: "auto" }),
    ]);
    await mailsSettled(suite.sql, lot);
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

  it("no refund id, 24 hours after the first call, and the read fails: E16 — stays awaiting_stripe, last_error left to the create error, pushed out, no E12 (v8 §6.2 E12, §7.1, round 5)", async () => {
    const { lot, opId } = await awaitingNoId(25);
    await setLastError(suite.sql, opId, "synthetic 500");
    fakeStripe.failLists(stripeError(503));
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();
    const after = await dbClockUs(suite.sql);

    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null, attention_reason: null, attempt_count: 0 });
    expect(op.last_error).toBe("synthetic 500");
    expect(await eventsOf(suite.sql, opId)).toEqual([
      expect.objectContaining({ event: "stripe_read_failed", from_status: "awaiting_stripe", to_status: "awaiting_stripe" }),
    ]);
    await expectPushedOut(opId, before, after);
    expect(await readLot(suite.sql, lot.lotId)).toMatchObject({ lifecycle: "refunding" });
  });

  it("no refund id past 24 hours: the read fails (stays), then a read that works and holds no refund of it → E12, whose row carries no read failure", async () => {
    const { opId } = await awaitingNoId(25);
    fakeStripe.failLists(stripeError(500));
    await runRefundLoopOnce();
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe" });

    fakeStripe.failLists(null);
    await setNextAttempt(opId, -1);
    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_result_unknown",
    });
    const deadline = (await eventsOf(suite.sql, opId)).at(-1)!;
    expect(deadline).toMatchObject({ event: "deadline_reached", from_status: "awaiting_stripe", to_status: "needs_attention" });
    expect(deadline.detail).toEqual({ actor: "loop" });
  });

  it("E12 after a 500 create and later failed reads: attention_detail is the 500's text, not the read failure (v8 round 5, §5.1)", async () => {
    const { lot, opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });
    fakeStripe.nextCreate({ kind: "error", error: stripeError(500) });
    await runRefundLoopOnce();
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null, last_error: "synthetic 500" });

    await suite.sql`UPDATE credit_refund_operations SET first_called_at = now() - interval '25 hours' WHERE id = ${opId}`;
    fakeStripe.failLists(stripeError(503));
    await setNextAttempt(opId, -1);
    await runRefundLoopOnce();
    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", last_error: "synthetic 500" });

    fakeStripe.failLists(null);
    await setNextAttempt(opId, -1);
    await runRefundLoopOnce();

    expect(createsFor(lot)).toHaveLength(1);
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_result_unknown",
      attention_detail: "synthetic 500",
    });
  });

  it("the read fails while a webhook finishes the disposition: the finished row gets no event from the failed read (round 4 H7)", async () => {
    const { lot, opId, own } = await awaitingOwn("succeeded");
    const paymentId = lot.paymentId;
    aroundNextList(fakeStripe, async () => {
      // Another writer reads Stripe and commits the finish while this read
      // is still out; then this read fails.
      const judged = await inTx((tx) =>
        applyRefundSnapshot(tx, paymentId, [refundObject(own, "succeeded", PAID_CENTS, opId)], "webhook"),
      );
      // The real webhook follows the disposition up after its commit.
      if (judged !== null) followUpOperationLater(judged);
      throw stripeError(500);
    });

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded", last_error: null });
    expect((await eventsOf(suite.sql, opId)).map((e) => [e.event, e.detail.actor])).toEqual([
      ["refund_succeeded", "webhook"],
    ]);
    await mailsSettled(suite.sql, lot);
  });

  it("with a refund id, 24 hours do not end the wait", async () => {
    const { opId, own } = await awaitingOwn("pending", 30);

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: own, attention_reason: null });
  });

  it("E16: a failed read leaves last_error alone (its text is in the event row), counts no attempt and backs off (v8 round 5, §5.1)", async () => {
    const { opId } = await awaitingOwn("succeeded");
    fakeStripe.failLists(stripeError(500));
    const before = await dbClockUs(suite.sql);

    await runRefundLoopOnce();
    const after = await dbClockUs(suite.sql);

    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "awaiting_stripe", attempt_count: 0, last_error: null });
    expect(await eventsOf(suite.sql, opId)).toEqual([
      expect.objectContaining({
        event: "stripe_read_failed",
        from_status: "awaiting_stripe",
        to_status: "awaiting_stripe",
        detail: expect.objectContaining({ message: "synthetic 500" }),
      }),
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

describe("startRefundLoop — started whenever the internal API is on (§7.1)", () => {
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
      if (flags.internal) {
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
    { internal: false, payments: false },
  ])("does not run with INTERNAL_API_ENABLED=$internal, PAYMENT_ENABLED=$payments", async (flags) => {
    expect(await ticked(flags, 1500)).toBe(false);
  });

  it("runs its first tick at once when both are on, and stop() resolves", async () => {
    expect(await ticked({ internal: true, payments: true }, 10_000)).toBe(true);
  });

  it("runs with INTERNAL_API_ENABLED=true and PAYMENT_ENABLED=false: an awaiting disposition is read", async () => {
    expect(await ticked({ internal: true, payments: false }, 10_000)).toBe(true);
  });

  it("runs with INTERNAL_API_ENABLED=true and PAYMENT_ENABLED=false: a started disposition whose lease ran out is claimed", async () => {
    const { opId } = await seeded("refunding", { kind: "approve", status: "started", leaseExpired: true });
    initCore({ ...BASE, INTERNAL_API_ENABLED: "true", PAYMENT_ENABLED: "false" });
    const loop = startRefundLoop();
    try {
      await vi.waitFor(async () => expect(await eventNames(opId)).toContain("claimed"), { timeout: 10_000 });
    } finally {
      await loop.stop();
      initCore({ ...BASE, PAYMENT_ENABLED: "true" });
    }
  });
});
