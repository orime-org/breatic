// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The daily refund reconcile (inner#1410 §7.2), on real Postgres and Redis
 * with the stateful fake Stripe.
 *
 * Contract this suite drives — `packages/server/src/modules/credit-refund/reconcile.ts`:
 *
 *   export function runDailyReconcile(): Promise<void>
 *     The one writer of `credit_refund_reconcile_status` (row `name = 'daily'`,
 *     created on first use when absent).
 *
 *     When — it runs only when `last_finished_at` is null (or the row is
 *       absent) or older than 24 hours, or `next_retry_at <= now()`; and only
 *       when `SET {env}:server:refund-reconcile-lock 1 EX 600 NX` succeeds.
 *       Otherwise it reads nothing from Stripe and writes nothing. The lock
 *       is not deleted when the pass ends; it expires by itself.
 *
 *     Which payments — every pass is full: the payments of `refunding` lots;
 *       payments with a `credit_refunds` row created, or a disposition
 *       finished, within `reconcile_window_days`; payments with an unresolved
 *       failed refund (§5.3); and the previous pass's `failing_payment_ids`.
 *
 *     Per payment — `listRefundsForPayment(paymentId)` → `applyRefundSnapshot`;
 *       a payment with no payment intent reads as no refunds, not a failure;
 *       a payment that fails is recorded and the pass goes on to the next.
 *
 *     Bookkeeping — `last_started_at` at the start; at the end
 *       `last_finished_at` and this pass's `failing_payment_ids`; when nothing
 *       failed also `last_ok_at`, with `last_error` and `next_retry_at`
 *       cleared; when something failed `last_error` and
 *       `next_retry_at = now() + 1 hour`.
 *
 *   The refund loop's step 4 calls it every tick (see
 *   `credit-refund-loop.integration.test.ts`).
 *
 * Every case parks dispositions other suites left in flight, gives their
 * intent-less lot payments a placeholder intent (the pass scans the whole
 * table), and deletes the status row and the lock key, so a pass sees no
 * leftover progress and no leftover row it cannot read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as BreaticCore from "@breatic/core";

const logged = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof BreaticCore>();
  // `error` is recorded instead of written; every other level goes to the real logger.
  const logger = new Proxy(actual.logger, {
    get: (target, prop) => (prop === "error" ? logged.error : Reflect.get(target, prop)),
  });
  return { ...actual, logger };
});

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

import { env, getRedis } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { runDailyReconcile } from "@server/modules/credit-refund/reconcile.js";
import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import { mailsSettled } from "./internal-api-harness.js";
import {
  PAID_CENTS,
  copiesOf,
  dbClockUs,
  giveIntentlessPaymentsAnIntent,
  mailsOf,
  parkInFlightOperations,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  type LotState,
  type RefundFixture,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useRefundSuite("credit-refund-reconcile-test");

const US = 1_000_000;
const HOUR_US = 3600 * US;

/** The lock key §7.2 names. */
function lockKey(): string {
  return `${env.ENV}:server:refund-reconcile-lock`;
}

beforeEach(async () => {
  logged.error.mockClear();
  fakeStripe.reset();
  await parkInFlightOperations(suite.sql);
  await giveIntentlessPaymentsAnIntent(suite.sql);
  await suite.sql`DELETE FROM credit_refund_reconcile_status`;
  await getRedis().del(lockKey());
});

afterEach(async () => {
  await getRedis().del(lockKey());
});

interface StatusRow {
  last_started_us: number | null;
  last_finished_us: number | null;
  last_ok_us: number | null;
  last_error: string | null;
  failing: string[];
  next_retry_us: number | null;
}

/**
 * The reconcile status row, times as epoch microseconds.
 * @returns The row, or null when there is none.
 */
async function readStatus(): Promise<StatusRow | null> {
  const [row] = await suite.sql<Record<string, string | string[] | null>[]>`
    SELECT
      (extract(epoch FROM last_started_at) * 1000000)::bigint::text AS last_started_us,
      (extract(epoch FROM last_finished_at) * 1000000)::bigint::text AS last_finished_us,
      (extract(epoch FROM last_ok_at) * 1000000)::bigint::text AS last_ok_us,
      last_error,
      failing_payment_ids::text[] AS failing,
      (extract(epoch FROM next_retry_at) * 1000000)::bigint::text AS next_retry_us
    FROM credit_refund_reconcile_status WHERE name = 'daily'
  `;
  if (!row) return null;
  const num = (v: unknown) => (v === null ? null : Number(v));
  return {
    last_started_us: num(row.last_started_us),
    last_finished_us: num(row.last_finished_us),
    last_ok_us: num(row.last_ok_us),
    last_error: row.last_error as string | null,
    failing: [...(row.failing as string[])].sort(),
    next_retry_us: num(row.next_retry_us),
  };
}

/**
 * Write the status row as a previous pass would have left it.
 * @param row - Hours ago for the two times (null for none) and the failing ids.
 * @param row.finishedHoursAgo - `last_finished_at`.
 * @param row.retryInHours - `next_retry_at` from now (negative for the past).
 * @param row.failing - `failing_payment_ids`.
 */
async function setStatus(row: {
  finishedHoursAgo: number | null;
  retryInHours?: number | null;
  failing?: string[];
}): Promise<void> {
  const finished =
    row.finishedHoursAgo === null
      ? null
      : suite.sql`now() - make_interval(hours => ${row.finishedHoursAgo}::int)`;
  const retry =
    row.retryInHours === null || row.retryInHours === undefined
      ? null
      : suite.sql`now() + make_interval(secs => ${row.retryInHours * 3600}::double precision)`;
  await suite.sql`
    INSERT INTO credit_refund_reconcile_status
      (name, last_started_at, last_finished_at, failing_payment_ids, next_retry_at)
    VALUES ('daily', ${finished}, ${finished},
            string_to_array(${(row.failing ?? []).join(",")}, ',')::uuid[], ${retry})
    ON CONFLICT (name) DO UPDATE SET
      last_started_at = EXCLUDED.last_started_at,
      last_finished_at = EXCLUDED.last_finished_at,
      failing_payment_ids = EXCLUDED.failing_payment_ids,
      next_retry_at = EXCLUDED.next_retry_at
  `;
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
 * Backdate a refund copy's `created_at`.
 * @param refundId - The copy.
 * @param days - Days ago.
 */
async function copyCreatedDaysAgo(refundId: string, days: number): Promise<void> {
  await suite.sql`
    UPDATE credit_refunds SET created_at = now() - make_interval(days => ${days}::int)
    WHERE stripe_refund_id = ${refundId}
  `;
}

/**
 * Backdate a disposition's `finished_at` (and `created_at`, to keep order).
 * @param opId - The disposition.
 * @param days - Days ago.
 */
async function opFinishedDaysAgo(opId: string, days: number): Promise<void> {
  await suite.sql`
    UPDATE credit_refund_operations
    SET finished_at = now() - make_interval(days => ${days}::int),
        created_at = now() - make_interval(days => ${days}::int)
    WHERE id = ${opId}
  `;
}

/**
 * Whether the pass read Stripe for a lot's payment.
 * @param lot - The lot.
 * @returns True when `refunds.list` was called for its payment intent.
 */
function listed(lot: SeededLot): boolean {
  return fakeStripe.listedIntents().includes(lot.paymentIntentId);
}

// ── when it runs ─────────────────────────────────────────────────────

describe("when the daily reconcile runs", () => {
  it("runs when there is no status row yet", async () => {
    const lot = await lotOnStripe("refunding");
    const before = await dbClockUs(suite.sql);

    await runDailyReconcile();
    const after = await dbClockUs(suite.sql);

    expect(listed(lot)).toBe(true);
    const row = (await readStatus())!;
    expect(row.last_started_us).toBeGreaterThanOrEqual(before);
    expect(row.last_finished_us).toBeGreaterThanOrEqual(row.last_started_us!);
    expect(row.last_finished_us).toBeLessThanOrEqual(after);
  });

  it.each([
    { name: "last finished 25 hours ago", finishedHoursAgo: 25, retryInHours: null, runs: true },
    { name: "last finished 1 hour ago, no retry set", finishedHoursAgo: 1, retryInHours: null, runs: false },
    { name: "last finished 1 hour ago, retry time passed", finishedHoursAgo: 1, retryInHours: -0.01, runs: true },
    { name: "last finished 1 hour ago, retry time ahead", finishedHoursAgo: 1, retryInHours: 0.5, runs: false },
  ])("$name → runs: $runs", async ({ finishedHoursAgo, retryInHours, runs }) => {
    const lot = await lotOnStripe("refunding");
    await setStatus({ finishedHoursAgo, retryInHours });
    const before = await readStatus();

    await runDailyReconcile();

    expect(listed(lot)).toBe(runs);
    if (runs) {
      expect((await readStatus())!.last_finished_us).toBeGreaterThan(before!.last_finished_us!);
    } else {
      expect(fakeStripe.listCalls).toEqual([]);
      expect(await readStatus()).toEqual(before);
    }
  });

  it("does not run while another instance holds the lock", async () => {
    const lot = await lotOnStripe("refunding");
    await getRedis().set(lockKey(), "1", "EX", 600);

    await runDailyReconcile();

    expect(listed(lot)).toBe(false);
    expect(fakeStripe.listCalls).toEqual([]);
    expect(await readStatus()).toBeNull();
  });
});

// ── which payments ───────────────────────────────────────────────────

describe("which payments a pass reconciles", () => {
  it("refunding lots, the window by copy creation and by disposition finish, unresolved failed refunds, last pass's failures — and nothing else", async () => {
    const window = getCreditRefundConfig().reconcileWindowDays;

    const refunding = await lotOnStripe("refunding");

    const copyInWindowId = reId("in_window");
    const copyInWindow = await lotOnStripe("refunded", [refundObject(copyInWindowId, "succeeded", PAID_CENTS)]);
    await seedCopy(suite.sql, copyInWindow, { id: copyInWindowId, amountCents: PAID_CENTS, status: "succeeded" });
    await copyCreatedDaysAgo(copyInWindowId, window - 1);

    const copyOldId = reId("old_copy");
    const copyOld = await lotOnStripe("active", [refundObject(copyOldId, "canceled", 100)]);
    await seedCopy(suite.sql, copyOld, { id: copyOldId, amountCents: 100, status: "canceled" });
    await copyCreatedDaysAgo(copyOldId, window + 1);

    const finishedInWindow = await lotOnStripe("active");
    const rejected = await seedOperation(suite.sql, finishedInWindow, { kind: "reject", status: "succeeded", result: "rejected" });
    await opFinishedDaysAgo(rejected.id, window - 1);

    const finishedOldId = reId("finished_old");
    const finishedOld = await lotOnStripe("active", [refundObject(finishedOldId, "canceled", 100)]);
    const oldReject = await seedOperation(suite.sql, finishedOld, { kind: "reject", status: "succeeded", result: "rejected" });
    await opFinishedDaysAgo(oldReject.id, window + 1);
    await seedCopy(suite.sql, finishedOld, { id: finishedOldId, amountCents: 100, status: "canceled" });
    await copyCreatedDaysAgo(finishedOldId, window + 1);

    const unresolvedId = reId("unresolved");
    const unresolved = await lotOnStripe("refunded", [refundObject(unresolvedId, "failed", PAID_CENTS)]);
    await seedCopy(suite.sql, unresolved, { id: unresolvedId, amountCents: PAID_CENTS, status: "failed", everSucceeded: true });
    await copyCreatedDaysAgo(unresolvedId, window + 10);

    const resolvedId = reId("resolved");
    const resolved = await lotOnStripe("refunded", [refundObject(resolvedId, "failed", PAID_CENTS)]);
    const outside = await seedOperation(suite.sql, resolved, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      failedRefundIds: [resolvedId],
    });
    await seedCopy(suite.sql, resolved, {
      id: resolvedId,
      amountCents: PAID_CENTS,
      status: "failed",
      everSucceeded: true,
      resolvedBy: outside.id,
    });
    await copyCreatedDaysAgo(resolvedId, window + 10);
    await opFinishedDaysAgo(outside.id, window + 10);

    const failedLastTime = await lotOnStripe("refund_pending");
    const untouched = await lotOnStripe("refund_pending");
    await setStatus({ finishedHoursAgo: null, failing: [failedLastTime.paymentId] });

    await runDailyReconcile();

    expect({
      refunding: listed(refunding),
      copyInWindow: listed(copyInWindow),
      finishedInWindow: listed(finishedInWindow),
      unresolved: listed(unresolved),
      failedLastTime: listed(failedLastTime),
      copyOld: listed(copyOld),
      finishedOld: listed(finishedOld),
      resolved: listed(resolved),
      untouched: listed(untouched),
    }).toEqual({
      refunding: true,
      copyInWindow: true,
      finishedInWindow: true,
      unresolved: true,
      failedLastTime: true,
      copyOld: false,
      finishedOld: false,
      resolved: false,
      untouched: false,
    });
  });

  // §5.3: on a refund_pending lot every failed or canceled refund nobody has
  // answered for counts, whether or not it ever succeeded.
  it("a refund_pending lot sent back on a failed refund, everything older than the window, is still read from Stripe", async () => {
    const window = getCreditRefundConfig().reconcileWindowDays;
    const failedId = reId("sent_back");
    const lot = await lotOnStripe("refund_pending", [refundObject(failedId, "failed", PAID_CENTS)]);
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "succeeded", result: "sent_back" });
    await opFinishedDaysAgo(approve.id, window + 10);
    await seedCopy(suite.sql, lot, {
      id: failedId,
      amountCents: PAID_CENTS,
      status: "failed",
      everSucceeded: false,
      operationId: approve.id,
    });
    await copyCreatedDaysAgo(failedId, window + 10);

    await runDailyReconcile();

    expect(listed(lot)).toBe(true);
  });

  // v9 §5.3, §7.2: the definition of an unresolved failed refund lives only
  // in the view; the reconcile selects those payments from it rather than
  // repeating the condition. Proven by widening the view for one payment the
  // condition itself would never select (an active lot), then restoring it.
  it("selects the unresolved part from the view credit_refunds_unresolved_failed, not from its own copy of the condition", async () => {
    const window = getCreditRefundConfig().reconcileWindowDays;
    const sentinelId = reId("view_sentinel");
    const sentinel = await lotOnStripe("active", [refundObject(sentinelId, "failed", 100)]);
    await seedCopy(suite.sql, sentinel, { id: sentinelId, amountCents: 100, status: "failed", everSucceeded: true });
    await copyCreatedDaysAgo(sentinelId, window + 10);
    await setStatus({ finishedHoursAgo: null });

    const [{ def } = { def: "" }] = await suite.sql<{ def: string }[]>`
      SELECT pg_get_viewdef('credit_refunds_unresolved_failed'::regclass) AS def
    `;
    const original = def.trim().replace(/;$/, "");
    const columns = await suite.sql<{ name: string; type: string }[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      WHERE a.attrelid = 'credit_refunds_unresolved_failed'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `;
    const copyColumns = new Set(["lot_id", "payment_id", "stripe_refund_id", "amount_cents", "currency", "status"]);
    const sentinelRow = columns
      .map((c) => `${copyColumns.has(c.name) ? `r.${c.name}` : "NULL"}::${c.type} AS ${c.name}`)
      .join(", ");
    try {
      await suite.sql.unsafe(`
        CREATE OR REPLACE VIEW credit_refunds_unresolved_failed AS
        SELECT * FROM (${original}) o
        UNION ALL
        SELECT ${sentinelRow} FROM credit_refunds r WHERE r.stripe_refund_id = '${sentinelId}'
      `);

      await runDailyReconcile();
    } finally {
      await suite.sql.unsafe(`CREATE OR REPLACE VIEW credit_refunds_unresolved_failed AS ${original}`);
    }

    expect(listed(sentinel)).toBe(true);
  });

  it("what Stripe lists is copied: a refund made outside the product appears, a status change lands", async () => {
    const own = reId("own");
    const external = reId("external");
    const lot = await lotOnStripe("refunded", [
      refundObject(own, "failed", PAID_CENTS),
      refundObject(external, "pending", 200),
    ]);
    await seedCopy(suite.sql, lot, { id: own, amountCents: PAID_CENTS, status: "succeeded" });

    await runDailyReconcile();

    expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded]).sort()).toEqual(
      [
        [external, "pending", false],
        [own, "failed", true],
      ].sort(),
    );
  });
});

// ── bookkeeping ──────────────────────────────────────────────────────

describe("what a pass records", () => {
  it("a clean pass: last_ok_at written, no failures, error and retry cleared", async () => {
    await lotOnStripe("refunding");
    await suite.sql`
      INSERT INTO credit_refund_reconcile_status (name, last_error, next_retry_at, last_finished_at)
      VALUES ('daily', 'old failure', now() - interval '1 minute', now() - interval '2 hours')
    `;
    const before = await dbClockUs(suite.sql);

    await runDailyReconcile();
    const after = await dbClockUs(suite.sql);

    const row = (await readStatus())!;
    expect(row).toMatchObject({ failing: [], last_error: null, next_retry_us: null });
    expect(row.last_ok_us).toBeGreaterThanOrEqual(before);
    expect(row.last_ok_us).toBeLessThanOrEqual(after);
    expect(row.last_finished_us).toBeGreaterThanOrEqual(before);
  });

  it("one payment fails: the others are still reconciled, the failure is recorded, a retry is set an hour out, and the retry is a full pass", async () => {
    const goodRefund1 = reId("good1");
    const goodRefund2 = reId("good2");
    const good1 = await lotOnStripe("refunding", [refundObject(goodRefund1, "pending", 300)]);
    const bad = await lotOnStripe("refunding", [refundObject(reId("bad"), "pending", 300)]);
    const good2 = await lotOnStripe("refunding", [refundObject(goodRefund2, "pending", 300)]);
    fakeStripe.failListFor(bad.paymentIntentId, stripeError(500));
    const before = await dbClockUs(suite.sql);

    await runDailyReconcile();
    const after = await dbClockUs(suite.sql);

    expect((await copiesOf(suite.sql, good1.lotId)).map((c) => c.stripe_refund_id)).toEqual([goodRefund1]);
    expect((await copiesOf(suite.sql, good2.lotId)).map((c) => c.stripe_refund_id)).toEqual([goodRefund2]);
    expect(await copiesOf(suite.sql, bad.lotId)).toEqual([]);
    const failed = (await readStatus())!;
    expect(failed.failing).toContain(bad.paymentId);
    expect(failed.failing).not.toContain(good1.paymentId);
    expect(failed.failing).not.toContain(good2.paymentId);
    expect(failed.last_ok_us).toBeNull();
    expect(failed.last_error).toEqual(expect.any(String));
    expect(failed.last_error!.length).toBeGreaterThan(0);
    expect(failed.last_finished_us).toBeGreaterThanOrEqual(before);
    expect(failed.last_finished_us).toBeLessThanOrEqual(after);
    expect(failed.next_retry_us).toBeGreaterThanOrEqual(before + HOUR_US);
    expect(failed.next_retry_us).toBeLessThanOrEqual(after + HOUR_US);

    // Before the retry time, with the last pass just finished: no pass.
    fakeStripe.listCalls.length = 0;
    await getRedis().del(lockKey());
    await runDailyReconcile();
    expect(fakeStripe.listCalls).toEqual([]);

    // At the retry time: a full pass again, and it comes out clean.
    fakeStripe.failListFor(bad.paymentIntentId, null);
    await suite.sql`
      UPDATE credit_refund_reconcile_status SET next_retry_at = now() - interval '1 second' WHERE name = 'daily'
    `;
    await getRedis().del(lockKey());
    await runDailyReconcile();

    expect(listed(good1)).toBe(true);
    expect(listed(bad)).toBe(true);
    expect(listed(good2)).toBe(true);
    expect((await copiesOf(suite.sql, bad.lotId))).toHaveLength(1);
    const clean = (await readStatus())!;
    expect(clean).toMatchObject({ failing: [], last_error: null, next_retry_us: null });
    expect(clean.last_ok_us).not.toBeNull();
  });

  it("a payment whose Stripe read fails is logged with Stripe's failure, its message and HTTP status, beside the error (round 10 [3])", async () => {
    const bad = await lotOnStripe("refunding");
    fakeStripe.failListFor(bad.paymentIntentId, stripeError(403));

    await runDailyReconcile();

    expect(logged.error).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: bad.paymentId,
        err: expect.any(Error),
        failure: expect.objectContaining({ message: "synthetic 403", httpStatus: 403, type: "invalid_request_error" }),
      }),
      "refund_reconcile_payment_failed",
    );
    expect((await readStatus())!.last_error).toContain("synthetic 403");
  });

  it("a payment that keeps failing stays listed while the others keep being reconciled", async () => {
    const bad = await lotOnStripe("refunding");
    const good = await lotOnStripe("refunding");
    fakeStripe.failListFor(bad.paymentIntentId, stripeError(500));

    await runDailyReconcile();
    await suite.sql`
      UPDATE credit_refund_reconcile_status
      SET last_finished_at = now() - interval '25 hours', next_retry_at = NULL
      WHERE name = 'daily'
    `;
    await getRedis().del(lockKey());
    fakeStripe.listCalls.length = 0;
    await runDailyReconcile();

    expect(listed(good)).toBe(true);
    expect(listed(bad)).toBe(true);
    const row = (await readStatus())!;
    expect(row.failing).toContain(bad.paymentId);
    expect(row.failing).not.toContain(good.paymentId);
  });

  // `listRefundsForPayment` answers a payment with no intent with no refunds:
  // nothing can have been refunded through Stripe without one.
  it("a payment in scope with no payment intent is not a failure: nothing is read for it and the pass is clean", async () => {
    const lot = await lotOnStripe("refunding");
    await suite.sql`UPDATE payments SET stripe_payment_intent_id = NULL WHERE id = ${lot.paymentId}`;
    try {
      await runDailyReconcile();

      expect(listed(lot)).toBe(false);
      const row = (await readStatus())!;
      expect(row.failing).not.toContain(lot.paymentId);
      expect(row).toMatchObject({ failing: [], last_error: null, next_retry_us: null });
      expect(row.last_ok_us).not.toBeNull();
    } finally {
      // Other suites' passes scan the whole table; leave no intent-less row behind.
      await giveIntentlessPaymentsAnIntent(suite.sql);
    }
  });
});

// ── what a pass books ────────────────────────────────────────────────

describe("an approval a pass books", () => {
  it("the buyer mail is sent right after the booking commits (§6.5 M1)", async () => {
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

    await runDailyReconcile();

    // No refund loop runs in this suite: nothing but the send after the
    // commit can move the row.
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ operation_id: opId, kind: "refund_completed", origin: "auto" }),
    ]);
    await mailsSettled(suite.sql, lot);
  });
});

// ── the lock ─────────────────────────────────────────────────────────

describe("the reconcile lock", () => {
  // A pass does not delete the lock when it ends: deleting it without
  // checking who holds it could remove another instance's lock. It expires
  // by itself within 600 seconds, and the next pass is not due before then.
  it("is still held after a pass, with its expiry no more than 600 seconds out", async () => {
    await lotOnStripe("refunding");

    await runDailyReconcile();

    expect(await readStatus()).toMatchObject({ failing: [] });
    expect(await getRedis().exists(lockKey())).toBe(1);
    const ttl = await getRedis().ttl(lockKey());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });
});
