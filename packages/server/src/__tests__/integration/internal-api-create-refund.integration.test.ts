// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal endpoints that create a Stripe refund — approve, retry,
 * refund-again — and the preview that judges them (inner#1410 §4.5, §5.2,
 * acceptance #4, #8, #9, #11, #12), driven over a real socket with signed
 * requests, against real Postgres and Redis and a stateful fake Stripe.
 *
 * Each of the three runs step 0 (read Stripe, outside any transaction),
 * phase 1 (judge and insert the disposition), phase 2 (`refunds.create`
 * under `credit-refund-<id>`), phase 3 (classify the answer). A refusal at
 * the judgement table answers 409 and stores no disposition, so the key can
 * be used again; the refunds step 0 read are still copied, and a disposition
 * that copy re-judged stays re-judged (v6 §4.6, §6.4).
 *
 * Response shapes asserted here (camelCase of the §5.1 columns):
 *   disposition snapshot — `{ id, lotId, paymentId, kind, status, result,
 *     attentionReason, stripeRefundId, requestedBy, reason, notify, … }`
 *   error — `{ code, detail }`, plus `reason` for `stripe_blocks`
 *   preview — `{ lot: { id, lifecycle, refundRequestedAt, … },
 *     payment: { paidCents, currency, … }, refunds: [{ stripeRefundId,
 *     amountCents, status, madeByProduct }], operationInProgress,
 *     unresolvedFailedRefunds: [{ stripeRefundId, amountCents }],
 *     action: { kind, outcome: "create_refund", amountCents }
 *           | { kind, outcome: "blocked", code, reason? } | null }`
 */

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

/** Every `warn` and `error` line the server wrote, for the cases that assert on what was logged. */
const logged = vi.hoisted(() => [] as { level: string; ctx: unknown; line: unknown }[]);

vi.mock("@breatic/core", async (io) => {
  const orig = await io<Record<string, unknown>>();
  return {
    ...orig,
    // Forwarded through a Proxy rather than spread: pino's level methods live
    // on the prototype, so `{ ...logger }` hands back an object without them.
    logger: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          const real = orig.logger as Record<string, unknown>;
          const value = real[prop];
          if (typeof value !== "function") return value;
          if (prop !== "warn" && prop !== "error") return value.bind(real);
          return (ctx: unknown, line: unknown) => {
            logged.push({ level: prop, ctx, line });
            (value as (c: unknown, l: unknown) => void).call(real, ctx, line);
          };
        },
      },
    ),
  };
});

import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import { fakeStripe, stripeError } from "./fake-stripe-refunds.js";
import {
  ADMIN,
  call,
  errorShape,
  expectRefusedAroundInFlight,
  freshKey,
  holdersOf,
  mailsSettled,
  paths,
  useInternalApp,
} from "./internal-api-harness.js";
import {
  CREDITS,
  PAID_CENTS,
  REFUND_AGAIN_CENTS,
  bellsOf,
  copiesOf,
  eventsOf,
  ledgerOf,
  mailsOf,
  markReconcileJustFinished,
  parkInFlightOperations,
  readLot,
  readOp,
  reId,
  refundObject,
  seedCopy,
  seedOperation,
  seedRefundAgainOn,
  seedRefundLot,
  worldOf,
  type LotState,
  type RefundFixture,
  type SeededLot,
  type WorldState,
} from "./credit-refund-fixtures.js";

const suite = useInternalApp("internal-api-create-refund-test");

const MAIL_STATUSES_AFTER_FINISH = ["pending", "sending", "skipped"];
const UNKNOWN_LOT = "00000000-0000-4000-8000-0000000000aa";

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
 * Whether `value`, or anything nested in it, satisfies `match`; a log line
 * is checked this way so the field names it uses stay its own.
 * @param value - What to search.
 * @param match - The test.
 * @param seen - Objects already visited.
 * @returns True when something matched.
 */
function holds(value: unknown, match: (v: unknown) => boolean, seen = new Set<unknown>()): boolean {
  if (match(value)) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((v) => holds(v, match, seen));
}

/**
 * A test for the Stripe failure `stripeError(httpStatus)` turns into.
 * @param httpStatus - The status the fake Stripe answered with.
 * @returns True for an object carrying its message and status.
 */
function isFailureOf(httpStatus: number): (v: unknown) => boolean {
  return (v) => {
    const f = v as { message?: unknown; httpStatus?: unknown } | null;
    return typeof v === "object" && f !== null && f.message === `synthetic ${httpStatus}` && f.httpStatus === httpStatus;
  };
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
 * Everything but the refund copies — a refused create-refund request may or
 * may not keep the snapshot it read, but it must store nothing else.
 * @param w - The world.
 * @returns The world without copies.
 */
function exceptCopies(w: WorldState): Omit<WorldState, "copies"> {
  const { copies: _copies, ...rest } = w;
  return rest;
}

/** The exact options phase 2 must hand stripe-node (§5.2). */
function createOptions(opId: string) {
  return {
    idempotencyKey: `credit-refund-${opId}`,
    timeout: getCreditRefundConfig().stripeCallTimeoutMs,
    maxNetworkRetries: 0,
  };
}

/**
 * The lot booked as refunded on `refundId`: zero balance, exactly one
 * `refund` ledger row of `-remaining_credits`.
 * @param lot - The lot.
 * @param refundId - The ledger row's reference.
 */
async function expectBookedOn(lot: SeededLot, refundId: string): Promise<void> {
  expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
  const refundRows = (await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund");
  expect(refundRows).toEqual([{ entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: refundId }]);
}

/**
 * One completed bell and one automatic completed mail for this disposition.
 * @param lot - The lot and buyer.
 * @param opId - The disposition.
 */
async function expectBuyerToldRefunded(lot: SeededLot, opId: string): Promise<void> {
  const bells = await bellsOf(suite.sql, lot.userId);
  expect(bells).toHaveLength(1);
  expect(bells[0]).toMatchObject({ type: "credit.refund_completed", expires_at: null });
  expect(bells[0]!.payload.lotId).toBe(lot.lotId);
  const mails = await mailsOf(suite.sql, lot.lotId);
  expect(mails.filter((m) => m.operation_id === opId)).toEqual([
    expect.objectContaining({ operation_id: opId, kind: "refund_completed", origin: "auto", requested_by: null, idempotency_key: null }),
  ]);
  expect(MAIL_STATUSES_AFTER_FINISH).toContain(mails.find((m) => m.operation_id === opId)!.status);
}

/**
 * The disposition ids of a lot, oldest first.
 * @param lot - The lot.
 * @returns The ids.
 */
async function opIdsOf(lot: SeededLot): Promise<string[]> {
  const rows = await suite.sql<{ id: string }[]>`
    SELECT id FROM credit_refund_operations WHERE lot_id = ${lot.lotId} ORDER BY created_at, id
  `;
  return rows.map((r) => r.id);
}

describe("GET /internal/v1/credit-lots/:lotId/refund — preview judges the operation the lot's state allows", () => {
  it("refund_pending → approve; lists Stripe's refunds, writes them to the copies, and offers to refund the rest", async () => {
    const external = reId("ext");
    const lot = await lotOnStripe("refund_pending", [refundObject(external, "succeeded", 300)]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.lot).toMatchObject({ id: lot.lotId, lifecycle: "refund_pending" });
    expect(Number.isNaN(Date.parse(res.json.lot.refundRequestedAt))).toBe(false);
    expect(res.json.payment).toMatchObject({ paidCents: PAID_CENTS, currency: "usd" });
    expect(res.json.refunds).toEqual([
      expect.objectContaining({ stripeRefundId: external, amountCents: 300, status: "succeeded", madeByProduct: false }),
    ]);
    expect(res.json.operationInProgress).toBeNull();
    expect(res.json.unresolvedFailedRefunds).toEqual([]);
    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "create_refund", amountCents: PAID_CENTS - 300 });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: external, operation_id: null, amount_cents: 300, status: "succeeded", ever_succeeded: true }),
    ]);
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("refund_pending with a refund still processing on Stripe → approve blocked by refund_in_progress", async () => {
    const lot = await lotOnStripe("refund_pending", [refundObject(reId("pend"), "pending", 200)]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "blocked", code: "stripe_blocks", reason: "refund_in_progress" });
  });

  it("refunding with an open needs_attention → retry, refunding the whole remaining amount", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_result_unknown" });

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.lot).toMatchObject({ id: lot.lotId, lifecycle: "refunding" });
    expect(res.json.action).toMatchObject({ kind: "retry", outcome: "create_refund", amountCents: PAID_CENTS });
  });

  it("refunding with a disposition still waiting on Stripe → retry blocked by operation_in_progress, and the preview names it", async () => {
    const lot = await lotOnStripe("refunding");
    const inFlight = await seedOperation(suite.sql, lot, { kind: "approve", status: "awaiting_stripe" });

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.operationInProgress).toMatchObject({ id: inFlight.id, kind: "approve", status: "awaiting_stripe" });
    expect(res.json.action).toMatchObject({ kind: "retry", outcome: "blocked", code: "operation_in_progress" });
  });

  it("refunded whose whole refund succeeded and has since failed → refund_again blocked by refund_failed (Stripe keeps the failed amount); the copy keeps ever_succeeded", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "succeeded", result: "refunded" });
    const failedLater = reId("later");
    await seedCopy(suite.sql, lot, { id: failedLater, amountCents: PAID_CENTS, status: "succeeded", operationId: approve.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failedLater, "failed", PAID_CENTS, approve.id)]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.unresolvedFailedRefunds).toEqual([
      expect.objectContaining({ stripeRefundId: failedLater, amountCents: PAID_CENTS }),
    ]);
    expect(res.json.refunds).toEqual([
      expect.objectContaining({ stripeRefundId: failedLater, status: "failed", madeByProduct: true }),
    ]);
    expect(res.json.action).toMatchObject({
      kind: "refund_again",
      outcome: "blocked",
      code: "stripe_blocks",
      reason: "refund_failed",
    });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: failedLater, status: "failed", ever_succeeded: true, resolved_by_operation_id: null }),
    ]);
  });

  it("refund_pending with a failed refund on Stripe → approve offers only what Stripe can still refund, and lists the failed refund as unresolved", async () => {
    const gone = reId("gone");
    const lot = await lotOnStripe("refund_pending", [refundObject(gone, "failed", 300)]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.action).toMatchObject({ kind: "approve", outcome: "create_refund", amountCents: PAID_CENTS - 300 });
    expect(res.json.unresolvedFailedRefunds).toEqual([expect.objectContaining({ stripeRefundId: gone, amountCents: 300 })]);
  });

  it("refunding whose refund failed for the whole amount → retry blocked by refund_failed; the failed refund is listed as unresolved", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const stuck = await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_refund_failed_later" });
    const failed = reId("failed_own");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: PAID_CENTS, status: "succeeded", operationId: stuck.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", PAID_CENTS, stuck.id)]);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.action).toMatchObject({ kind: "retry", outcome: "blocked", code: "stripe_blocks", reason: "refund_failed" });
    expect(res.json.unresolvedFailedRefunds).toEqual([expect.objectContaining({ stripeRefundId: failed, amountCents: PAID_CENTS })]);
  });

  it("an active lot has no refund operation to judge: action is null", async () => {
    const lot = await lotOnStripe("active");

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect(res.json.lot).toMatchObject({ id: lot.lotId, lifecycle: "active" });
    expect(res.json.action).toBeNull();
  });

  it("an unknown lot is 404 not_found with a translated detail", async () => {
    const res = await call(suite.baseUrl, paths.preview(UNKNOWN_LOT));

    expect(res.status).toBe(404);
    expect(errorShape(res.json)).toEqual({ code: "not_found", reason: undefined, detailTranslated: true });
  });

  it("a failed Stripe read is 503 stripe_unavailable and writes no copy", async () => {
    const lot = await lotOnStripe("refund_pending", [refundObject(reId("ext"), "succeeded", 300)]);
    fakeStripe.failLists(stripeError(500));

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("a failed Stripe read at step 0 is still 503 stripe_unavailable, and an error line carries Stripe's failure and the payment id (round 7 [8])", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.failLists(stripeError(403));
    logged.length = 0;

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    const lines = logged.filter((l) => l.level === "error");
    expect(
      lines.some((l) => holds(l.ctx, (v) => v === lot.paymentId) && holds(l.ctx, isFailureOf(403))),
      `error lines: ${JSON.stringify(lines)}`,
    ).toBe(true);
  });
});

describe("POST …/refund/approve", () => {
  const body = { reason: "Within 14 days, unused.", confirmedRefundIds: [] as string[] };

  it("Stripe answers succeeded: 200 refunded; one create under credit-refund-<id> with no amount; lot booked; copy, bell and auto mail written", async () => {
    const lot = await lotOnStripe("refund_pending");
    const key = freshKey("approve");

    const res = await post(paths.approve(lot.lotId), body, key);

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    expect(res.json).toMatchObject({
      id: opId,
      lotId: lot.lotId,
      paymentId: lot.paymentId,
      kind: "approve",
      status: "succeeded",
      result: "refunded",
      attentionReason: null,
      stripeRefundId: created!.id,
      requestedBy: ADMIN,
      reason: body.reason,
      notify: true,
    });
    expect(fakeStripe.createCalls).toEqual([
      {
        params: { payment_intent: lot.paymentIntentId, metadata: { refund_operation_id: opId } },
        options: createOptions(opId),
      },
    ]);
    expect(created).toMatchObject({ amount: PAID_CENTS, status: "succeeded" });
    expect(await readOp(suite.sql, opId)).toMatchObject({
      idempotency_key: key,
      requested_by: ADMIN,
      reason: body.reason,
      settled_succeeded_cents: PAID_CENTS,
      stripe_refund_id: created!.id,
    });
    await expectBookedOn(lot, created!.id);
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: created!.id, operation_id: opId, amount_cents: PAID_CENTS, status: "succeeded", ever_succeeded: true }),
    ]);
    await expectBuyerToldRefunded(lot, opId);
  });

  it("with a confirmed external refund already on Stripe: refunds only the rest and books on the product's own refund", async () => {
    const external = reId("ext");
    const lot = await lotOnStripe("refund_pending", [refundObject(external, "succeeded", 300)]);

    const res = await post(paths.approve(lot.lotId), { ...body, confirmedRefundIds: [external] });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "succeeded", result: "refunded" });
    const opId: string = res.json.id;
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(fakeStripe.createCalls[0]!.params).toEqual({ payment_intent: lot.paymentIntentId, metadata: { refund_operation_id: opId } });
    const created = fakeStripe.refundsOf(lot.paymentIntentId).find((r) => r.id !== external)!;
    expect(created.amount).toBe(PAID_CENTS - 300);
    await expectBookedOn(lot, created.id);
    expect((await readOp(suite.sql, opId)).settled_succeeded_cents).toBe(PAID_CENTS);
    expect((await readOp(suite.sql, opId)).confirmed_refund_ids).toEqual([external]);
  });

  it("Stripe answers pending: 202 awaiting_stripe with the refund id; lot stays refunding; nothing booked, nobody told", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "refund", status: "pending" });

    const res = await post(paths.approve(lot.lotId), body);

    expect(res.status).toBe(202);
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    expect(res.json).toMatchObject({ kind: "approve", status: "awaiting_stripe", result: null, stripeRefundId: created!.id });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunding", remaining: `${CREDITS}.000000`, attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: created!.id, operation_id: res.json.id, status: "pending", ever_succeeded: false }),
    ]);
  });

  it("the first request answered 400: 200 sent_back; lot back to refund_pending; no ledger, bell or mail", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "error", error: stripeError(400, { code: "amount_too_large" }) });

    const res = await post(paths.approve(lot.lotId), body);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: "approve", status: "succeeded", result: "sent_back", stripeRefundId: null });
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refund_pending", remaining: `${CREDITS}.000000`, attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("Stripe answered 5xx: 202 awaiting_stripe with no refund id; lot stays refunding", async () => {
    const lot = await lotOnStripe("refund_pending");
    fakeStripe.nextCreate({ kind: "error", error: stripeError(500) });

    const res = await post(paths.approve(lot.lotId), body);

    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ kind: "approve", status: "awaiting_stripe", result: null, stripeRefundId: null });
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
  });

  describe("refusals store no disposition and call no create", () => {
    const refusals: {
      name: string;
      state: LotState;
      refunds: () => RefundFixture[];
      confirm?: (ids: string[]) => string[];
      expected: { code: string; reason?: string };
    }[] = [
      { name: "an active lot → lot_state_changed", state: "active", refunds: () => [], expected: { code: "lot_state_changed" } },
      { name: "a refunded lot → lot_state_changed", state: "refunded", refunds: () => [], expected: { code: "lot_state_changed" } },
      {
        name: "a refund still processing on Stripe → stripe_blocks refund_in_progress",
        state: "refund_pending",
        refunds: () => [refundObject(reId("pend"), "pending", 200)],
        expected: { code: "stripe_blocks", reason: "refund_in_progress" },
      },
      {
        name: "Stripe already refunded all of it → stripe_blocks already_refunded",
        state: "refund_pending",
        refunds: () => [refundObject(reId("full"), "succeeded", PAID_CENTS)],
        confirm: (ids) => ids,
        expected: { code: "stripe_blocks", reason: "already_refunded" },
      },
      {
        name: "a failed refund leaves Stripe nothing it will refund → stripe_blocks refund_failed",
        state: "refund_pending",
        refunds: () => [refundObject(reId("gone"), "failed", PAID_CENTS)],
        expected: { code: "stripe_blocks", reason: "refund_failed" },
      },
      {
        name: "succeeded plus failed refunds reach the paid amount → stripe_blocks refund_failed",
        state: "refund_pending",
        refunds: () => [refundObject(reId("part"), "succeeded", 500), refundObject(reId("gone"), "failed", PAID_CENTS - 500)],
        confirm: (ids) => ids,
        expected: { code: "stripe_blocks", reason: "refund_failed" },
      },
      {
        name: "a succeeded external refund the confirmation page did not show → stripe_blocks unconfirmed_external_refund",
        state: "refund_pending",
        refunds: () => [refundObject(reId("ext"), "succeeded", 300)],
        expected: { code: "stripe_blocks", reason: "unconfirmed_external_refund" },
      },
    ];

    it.each(refusals)("$name", async ({ state, refunds, confirm, expected }) => {
      const onStripe = refunds();
      const lot = await lotOnStripe(state, onStripe);
      const before = await worldOf(suite.sql, lot);

      const res = await post(paths.approve(lot.lotId), {
        ...body,
        confirmedRefundIds: confirm ? confirm(onStripe.map((r) => r.id)) : [],
      });

      expect(res.status).toBe(409);
      expect(errorShape(res.json)).toEqual({ code: expected.code, reason: expected.reason, detailTranslated: true });
      expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
      expect(fakeStripe.createCalls).toEqual([]);
    });

    it("an unknown lot is 404 not_found", async () => {
      const res = await post(paths.approve(UNKNOWN_LOT), body);

      expect(res.status).toBe(404);
      expect(errorShape(res.json)).toEqual({ code: "not_found", reason: undefined, detailTranslated: true });
      expect(fakeStripe.createCalls).toEqual([]);
    });

    it("a failed Stripe read is 503 stripe_unavailable; the key stays unused, so the same request succeeds afterwards", async () => {
      const lot = await lotOnStripe("refund_pending");
      const before = await worldOf(suite.sql, lot);
      const key = freshKey("approve");
      fakeStripe.failLists(stripeError(500));

      const res = await post(paths.approve(lot.lotId), body, key);

      expect(res.status).toBe(503);
      expect(res.json).toEqual({ code: "stripe_unavailable" });
      expect(await worldOf(suite.sql, lot)).toEqual(before);
      expect(fakeStripe.createCalls).toEqual([]);

      fakeStripe.failLists(null);
      const again = await post(paths.approve(lot.lotId), body, key);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ kind: "approve", result: "refunded" });
    });

    it.each([
      ["no reason", { confirmedRefundIds: [] }],
      ["an empty reason", { reason: "", confirmedRefundIds: [] }],
      ["a reason over 500 characters", { reason: "x".repeat(501), confirmedRefundIds: [] }],
      ["confirmedRefundIds that is not a list", { reason: "ok", confirmedRefundIds: "re_1" }],
    ])("a body with %s is 422 invalid_body", async (_name, badBody) => {
      const lot = await lotOnStripe("refund_pending");
      const before = await worldOf(suite.sql, lot);

      const res = await post(paths.approve(lot.lotId), badBody);

      expect(res.status).toBe(422);
      expect(res.json.code).toBe("invalid_body");
      expect(await worldOf(suite.sql, lot)).toEqual(before);
      expect(fakeStripe.createCalls).toEqual([]);
    });

    it.each([
      ["missing", null],
      ["outside REFKEY_PATTERN", "has a space"],
    ])("an Idempotency-Key that is %s is 422 invalid_body", async (_name, key) => {
      const lot = await lotOnStripe("refund_pending");
      const before = await worldOf(suite.sql, lot);

      const res = await call(suite.baseUrl, paths.approve(lot.lotId), { body, idempotencyKey: key });

      expect(res.status).toBe(422);
      expect(res.json.code).toBe("invalid_body");
      expect(await worldOf(suite.sql, lot)).toEqual(before);
      expect(fakeStripe.createCalls).toEqual([]);
    });

    it("a body that is not JSON is 400 invalid_body", async () => {
      const lot = await lotOnStripe("refund_pending");
      const before = await worldOf(suite.sql, lot);

      const res = await call(suite.baseUrl, paths.approve(lot.lotId), {
        rawBody: "{ not json",
        idempotencyKey: freshKey("approve"),
      });

      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_body");
      expect(await worldOf(suite.sql, lot)).toEqual(before);
    });
  });

  describe("a refused request still copies what it read (v6 §4.6, §6.4, findings [2][42])", () => {
    it("409 unconfirmed_external_refund: the succeeded external refund it read has a copy with ever_succeeded; no disposition, no key", async () => {
      const external = reId("ext_unseen");
      const lot = await lotOnStripe("refund_pending", [refundObject(external, "succeeded", 300)]);
      const before = await worldOf(suite.sql, lot);
      const key = freshKey("approve");

      const res = await post(paths.approve(lot.lotId), { ...body, confirmedRefundIds: [] }, key);

      expect(res.status).toBe(409);
      expect(errorShape(res.json)).toEqual({ code: "stripe_blocks", reason: "unconfirmed_external_refund", detailTranslated: true });
      expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
        expect.objectContaining({ stripe_refund_id: external, operation_id: null, status: "succeeded", ever_succeeded: true }),
      ]);
      expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
      expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
      expect(fakeStripe.createCalls).toEqual([]);
    });

    it("409 refund_in_progress: every refund it read is copied, the processing one and a succeeded one", async () => {
      const pending = reId("pend");
      const done = reId("done");
      const lot = await lotOnStripe("refund_pending", [
        refundObject(pending, "pending", 200),
        refundObject(done, "succeeded", 100),
      ]);
      const key = freshKey("approve");

      const res = await post(paths.approve(lot.lotId), { ...body, confirmedRefundIds: [done] }, key);

      expect(res.status).toBe(409);
      expect(res.json.reason).toBe("refund_in_progress");
      expect((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.status, c.ever_succeeded]).sort()).toEqual(
        [
          [pending, "pending", false],
          [done, "succeeded", true],
        ].sort(),
      );
      expect(await opIdsOf(lot)).toEqual([]);
      expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
    });

    it("a retry refused because its read finished the awaiting approval: the approval stays booked, the retry stores nothing", async () => {
      // The approval waits on its refund; Stripe now says it succeeded for
      // the whole payment. The retry's read re-judges the approval (E2,
      // booked), which leaves the retry nothing to do: 409.
      const own = reId("own_done");
      const lot = await seedRefundLot(suite.sql, "refunding");
      const waiting = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "awaiting_stripe",
        stripeRefundId: own,
        firstCalledHoursAgo: 1,
        attemptCount: 1,
      });
      await seedCopy(suite.sql, lot, { id: own, amountCents: PAID_CENTS, status: "pending", operationId: waiting.id });
      fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(own, "succeeded", PAID_CENTS, waiting.id)]);
      const key = freshKey("retry");

      const res = await post(paths.retry(lot.lotId), { reason: "Try again.", confirmedRefundIds: [] }, key);

      expect(res.status).toBe(409);
      expect(["lot_state_changed", "operation_in_progress"]).toContain(res.json.code);
      expect(await readOp(suite.sql, waiting.id)).toMatchObject({ status: "succeeded", result: "refunded" });
      await expectBookedOn(lot, own);
      await expectBuyerToldRefunded(lot, waiting.id);
      expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
        expect.objectContaining({ stripe_refund_id: own, status: "succeeded", ever_succeeded: true }),
      ]);
      expect(await opIdsOf(lot)).toEqual([waiting.id]);
      expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
      expect(fakeStripe.createCalls).toEqual([]);
      await mailsSettled(suite.sql, lot);
    });
  });

  it("two approvals of one lot under different keys at once: exactly one runs, one refund is created, the other is 409", async () => {
    const lot = await lotOnStripe("refund_pending");

    const answers = await Promise.all([
      post(paths.approve(lot.lotId), body, freshKey("a")),
      post(paths.approve(lot.lotId), body, freshKey("b")),
    ]);

    const statuses = answers.map((a) => a.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = answers.find((a) => a.status === 409)!;
    expect(["lot_state_changed", "operation_in_progress"]).toContain(refused.json.code);
    expect(fakeStripe.createCalls).toHaveLength(1);
    expect(await opIdsOf(lot)).toHaveLength(1);
    await expectBookedOn(lot, fakeStripe.refundsOf(lot.paymentIntentId)[0]!.id);
    await mailsSettled(suite.sql, lot);
  });
});

describe("POST …/refund/retry", () => {
  const body = { reason: "Stripe never answered; trying again.", confirmedRefundIds: [] as string[] };

  it("refunding with an open needs_attention: creates a refund for the rest, books it, tells the buyer, closes the attention", async () => {
    const lot = await lotOnStripe("refunding");
    const stuck = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_result_unknown",
      createdSecondsAgo: 60,
    });

    const res = await post(paths.retry(lot.lotId), body);

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "retry", status: "succeeded", result: "refunded", notify: true });
    expect(fakeStripe.createCalls).toEqual([
      {
        params: { payment_intent: lot.paymentIntentId, metadata: { refund_operation_id: opId } },
        options: createOptions(opId),
      },
    ]);
    const [created] = fakeStripe.refundsOf(lot.paymentIntentId);
    await expectBookedOn(lot, created!.id);
    await expectBuyerToldRefunded(lot, opId);
    const closed = await readOp(suite.sql, stuck.id);
    expect(closed.status).toBe("needs_attention");
    expect(closed.attention_closed_by).toBe(opId);
    expect(typeof closed.attention_closed_at).toBe("string");
  });

  it("refunding whose approval's refund failed for the whole amount is 409 stripe_blocks refund_failed and creates nothing", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const stuck = await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_refund_failed_later" });
    const failed = reId("failed_own");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: PAID_CENTS, status: "succeeded", operationId: stuck.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", PAID_CENTS, stuck.id)]);
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.retry(lot.lotId), body);

    expect(res.status).toBe(409);
    expect(errorShape(res.json)).toEqual({ code: "stripe_blocks", reason: "refund_failed", detailTranslated: true });
    expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("refunding with no open needs_attention is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("refunding");
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.retry(lot.lotId), body);

    expect(res.status).toBe(409);
    expect(errorShape(res.json)).toEqual({ code: "lot_state_changed", reason: undefined, detailTranslated: true });
    expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("with a disposition still in flight is 409 operation_in_progress", async () => {
    const lot = await lotOnStripe("refunding");
    const inFlight = await seedOperation(suite.sql, lot, { kind: "approve", status: "awaiting_stripe" });
    const before = await worldOf(suite.sql, lot);
    const key = freshKey();

    const res = await post(paths.retry(lot.lotId), body, key);

    await expectRefusedAroundInFlight(suite.sql, res, lot, before, inFlight.id, key);
  });

  it("a refund_pending lot is 409 lot_state_changed", async () => {
    const lot = await lotOnStripe("refund_pending");

    const res = await post(paths.retry(lot.lotId), body);

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("lot_state_changed");
    expect(await opIdsOf(lot)).toEqual([]);
  });

  it("a failed Stripe read is 503 stripe_unavailable", async () => {
    const lot = await lotOnStripe("refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_result_unknown" });
    const before = await worldOf(suite.sql, lot);
    fakeStripe.failLists(stripeError(503));

    const res = await post(paths.retry(lot.lotId), body);

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "stripe_unavailable" });
    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });
});

describe("POST …/refund/refund-again", () => {
  /**
   * A refunded lot settled short on purpose (acceptPartial) on two refunds:
   * an external one of 400 still succeeded, and one of 300 that has since
   * failed. Stripe can still refund 1080 − 400 − 300 = 380, so a refund of
   * the failed 300 fits (v6 §5.2).
   * @returns The lot and the two refund ids.
   */
  async function refundedWithFailedRefund() {
    const lot = await seedRefundLot(suite.sql, "refunded");
    await seedOperation(suite.sql, lot, {
      kind: "settle",
      status: "succeeded",
      result: "refunded",
      notify: false,
      createdSecondsAgo: 120,
    });
    const kept = reId("kept");
    const failed = reId("failed");
    await seedCopy(suite.sql, lot, { id: kept, amountCents: 400, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: failed, amountCents: 300, status: "succeeded" });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      refundObject(kept, "succeeded", 400),
      refundObject(failed, "failed", 300),
    ]);
    return { lot, kept, failed };
  }

  it("creates a refund of exactly the failed refunds' sum, answers for them, leaves the lot and ledger alone, tells the buyer", async () => {
    const { lot, kept, failed } = await refundedWithFailedRefund();
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

    const res = await post(paths.refundAgain(lot.lotId), { reason: "Card was replaced.", failedRefundIds: [failed], notify: true });

    expect(res.status).toBe(200);
    const opId: string = res.json.id;
    expect(res.json).toMatchObject({ kind: "refund_again", status: "succeeded", result: "refunded", notify: true });
    expect(fakeStripe.createCalls).toEqual([
      {
        params: { payment_intent: lot.paymentIntentId, amount: 300, metadata: { refund_operation_id: opId } },
        options: createOptions(opId),
      },
    ]);
    const created = fakeStripe.refundsOf(lot.paymentIntentId).find((r) => r.id !== kept && r.id !== failed)!;
    expect(res.json.stripeRefundId).toBe(created.id);
    expect(await readOp(suite.sql, opId)).toMatchObject({ failed_refund_ids: [failed], refund_amount_cents: 300 });
    const copies = await copiesOf(suite.sql, lot.lotId);
    expect(copies.find((c) => c.stripe_refund_id === failed)).toMatchObject({ status: "failed", ever_succeeded: true, resolved_by_operation_id: opId });
    expect(copies.find((c) => c.stripe_refund_id === kept)).toMatchObject({ resolved_by_operation_id: null });
    expect(copies.find((c) => c.stripe_refund_id === created.id)).toMatchObject({ operation_id: opId, amount_cents: 300, status: "succeeded" });
    expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    await expectBuyerToldRefunded(lot, opId);
  });

  it("failedRefundIds that differ from the unresolved set is 409 stripe_blocks failed_refunds_changed", async () => {
    const { lot, kept } = await refundedWithFailedRefund();
    const before = await worldOf(suite.sql, lot);

    const res = await post(paths.refundAgain(lot.lotId), { reason: "r", failedRefundIds: [kept], notify: true });

    expect(res.status).toBe(409);
    expect(errorShape(res.json)).toEqual({ code: "stripe_blocks", reason: "failed_refunds_changed", detailTranslated: true });
    expect(exceptCopies(await worldOf(suite.sql, lot))).toEqual(exceptCopies(before));
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("an amount above what Stripe can still refund is 409 stripe_blocks refund_failed, creates nothing, and leaves the refund unresolved (v6 §5.2)", async () => {
    // The whole payment was refunded and that refund failed later
    // (pm_card_refundFail): 1080 > 1080 − 0 − 1080.
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "succeeded", result: "refunded", createdSecondsAgo: 120 });
    const failed = reId("failed_whole");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: PAID_CENTS, status: "succeeded", operationId: approve.id });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", PAID_CENTS, approve.id)]);
    const key = freshKey("again");

    const res = await post(paths.refundAgain(lot.lotId), { reason: "Card was replaced.", failedRefundIds: [failed], notify: true }, key);

    expect(res.status).toBe(409);
    expect(errorShape(res.json)).toEqual({ code: "stripe_blocks", reason: "refund_failed", detailTranslated: true });
    expect(fakeStripe.createCalls).toEqual([]);
    expect(await opIdsOf(lot)).toEqual([approve.id]);
    expect(await holdersOf(suite.sql, key)).toEqual({ ops: 0, mails: 0 });
    expect(await copiesOf(suite.sql, lot.lotId)).toEqual([
      expect.objectContaining({ stripe_refund_id: failed, status: "failed", ever_succeeded: true, resolved_by_operation_id: null }),
    ]);

    // When the amount fits (booked short on purpose), the preview still offers it.
    const fits = await refundedWithFailedRefund();
    const preview = await call(suite.baseUrl, paths.preview(fits.lot.lotId));
    expect(preview.json.action).toMatchObject({ kind: "refund_again", outcome: "create_refund", amountCents: 300 });
  });

  it("a refunded lot with no unresolved failed refund is 409 lot_state_changed", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const ok = reId("ok");
    await seedCopy(suite.sql, lot, { id: ok, amountCents: PAID_CENTS, status: "succeeded" });
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(ok, "succeeded", PAID_CENTS)]);

    const res = await post(paths.refundAgain(lot.lotId), { reason: "r", failedRefundIds: [ok], notify: true });

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("lot_state_changed");
    expect(await opIdsOf(lot)).toEqual([]);
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("a refund still processing on Stripe is 409 stripe_blocks refund_in_progress", async () => {
    const { lot, failed } = await refundedWithFailedRefund();
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [
      ...fakeStripe.refundsOf(lot.paymentIntentId),
      refundObject(reId("pend"), "pending", 50),
    ]);

    const res = await post(paths.refundAgain(lot.lotId), { reason: "r", failedRefundIds: [failed], notify: true });

    expect(res.status).toBe(409);
    expect(errorShape(res.json)).toEqual({ code: "stripe_blocks", reason: "refund_in_progress", detailTranslated: true });
    expect(fakeStripe.createCalls).toEqual([]);
  });
});

describe("a refund_again whose Stripe result is unknown keeps the debt it pays (v8 §6.2 E11, E12, §9)", () => {
  beforeEach(async () => {
    await parkInFlightOperations(suite.sql);
    await markReconcileJustFinished(suite.sql);
  });

  /**
   * Run one loop tick while every Stripe read fails, then let reads work
   * again and send a second refund_again for the same failed refund.
   * @param lot - Its lot.
   * @param failed - The failed refund both are for.
   * @returns The second request's answer, the world before it and its key.
   */
  async function secondRefundAgainAfterFailedReads(lot: SeededLot, failed: string) {
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(failed, "failed", REFUND_AGAIN_CENTS)]);
    fakeStripe.failLists(stripeError(500));
    await runRefundLoopOnce();
    fakeStripe.failLists(null);

    const before = await worldOf(suite.sql, lot);
    const key = freshKey("again2");
    const res = await post(paths.refundAgain(lot.lotId), { reason: "Pay it again.", failedRefundIds: [failed], notify: true }, key);
    return { res, before, key };
  }

  it("attempts used up while every read fails: it stays started, and a second refund_again for the same refund is 409 operation_in_progress with no create", async () => {
    const { lot, failed, againId } = await seedRefundAgainOn(suite.sql, {
      status: "started",
      leaseExpired: true,
      attemptCount: getCreditRefundConfig().maxAttempts,
      firstCalledHoursAgo: 1,
    });

    const { res, before, key } = await secondRefundAgainAfterFailedReads(lot, failed);

    await expectRefusedAroundInFlight(suite.sql, res, lot, before, againId, key);
    expect(await readOp(suite.sql, againId)).toMatchObject({ status: "started", attention_reason: null });
    expect((await eventsOf(suite.sql, againId)).map((e) => e.event)).toEqual(["claimed", "stripe_read_failed"]);
  });

  it("awaiting_stripe with no refund id past 24 hours while every read fails: it stays awaiting_stripe, and a second refund_again for the same refund is 409 operation_in_progress with no create", async () => {
    const { lot, failed, againId } = await seedRefundAgainOn(suite.sql, {
      status: "awaiting_stripe",
      stripeRefundId: null,
      attemptCount: 1,
      firstCalledHoursAgo: 25,
    });

    const { res, before, key } = await secondRefundAgainAfterFailedReads(lot, failed);

    await expectRefusedAroundInFlight(suite.sql, res, lot, before, againId, key);
    expect(await readOp(suite.sql, againId)).toMatchObject({ status: "awaiting_stripe", attention_reason: null });
    expect((await eventsOf(suite.sql, againId)).map((e) => e.event)[0]).toBe("stripe_read_failed");
  });
});

describe("a preview does not move the loop's next look: E10 only writes its event row (v8 round 6, §6.2 awaiting × E10)", () => {
  beforeEach(async () => {
    await parkInFlightOperations(suite.sql);
    await markReconcileJustFinished(suite.sql);
  });

  it("awaiting_stripe with no refund id 25 hours after the first call, its next look due: the preview records refund_not_found and leaves next_attempt_at; the next tick ends it stripe_result_unknown", async () => {
    const lot = await lotOnStripe("refunding");
    const { id: opId } = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: null,
      attemptCount: 1,
      firstCalledHoursAgo: 25,
    });
    const { next_attempt_us: due } = await readOp(suite.sql, opId);

    const res = await call(suite.baseUrl, paths.preview(lot.lotId));

    expect(res.status).toBe(200);
    expect((await eventsOf(suite.sql, opId)).map((e) => [e.event, e.detail.actor])).toEqual([
      ["refund_not_found", "request"],
    ]);
    expect((await readOp(suite.sql, opId)).next_attempt_us).toBe(due);

    await runRefundLoopOnce();

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_result_unknown",
    });
    expect(fakeStripe.createCalls).toEqual([]);
  });
});
