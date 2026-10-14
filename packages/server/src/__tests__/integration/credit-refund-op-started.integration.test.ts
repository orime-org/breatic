// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `transitionOperation` on the `started` line of the disposition table
 * (inner#1410 §6.2), one case per cell, on real Postgres.
 *
 * A `started` disposition holds a lease: the executor that holds it passes
 * its `leaseToken` with every answer, and an answer whose token the row no
 * longer holds is E15 — discarded, one `late_answer` event row, nothing else.
 *
 * | event | approve, retry (v9)                                                       |
 * |-------|---------------------------------------------------------------------------|
 * | E1    | impossible                                                                |
 * | E2    | succeeded/refunded, booked (§5.5), bell + mail                            |
 * | E3    | awaiting_stripe, refund id kept                                           |
 * | E4    | needs_attention (reason given)                                            |
 * | E5    | awaiting_stripe, refund id kept                                           |
 * | E6    | needs_attention, the lot neither read nor changed: stripe_refund_failed_later when the refund's copy ever succeeded; stripe_request_invalid for a first-request 401/403/404; stripe_declined otherwise |
 * | E7    | stays, attempt + 1, backoff, lease released                               |
 * | E8    | awaiting_stripe, no refund id                                             |
 * | E9    | needs_attention already_refunded_elsewhere                                |
 * | E10   | impossible                                                                |
 * | E11   | needs_attention: stripe_declined when a create answer in this disposition's event rows is a Stripe refusal (isStripeRefusal, §5.4), attempts_exhausted otherwise |
 * | E12   | stays                                                                     |
 * | E13   | stays, new lease                                                          |
 * | E14   | impossible                                                                |
 * | E15   | discarded                                                                 |
 * | E16   | stays, attempt + 1, backoff, lease released, last_error kept              |
 * | E17   | stays, attempt + 1, backoff, lease released                               |
 *
 * A retry that finishes `succeeded` closes the approval's open
 * needs_attention it was started from (E14).
 */

import { describe, it, expect, vi } from "vitest";

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

import { randomUUID } from "node:crypto";
import { transitionOperation } from "@server/modules/credit-refund/operation-transitions.js";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import {
  bellsOf,
  dbClockUs,
  expectLeaseReleased,
  inTx,
  ledgerOf,
  mailsOf,
  readLot,
  readOp,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  setLastError,
  useRefundSuite,
  worldOf,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import {
  eventOf,
  expectBooked,
  expectClosedBy,
  expectImpossible,
  expectStays,
  failure,
  newEventsOn,
} from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-op-started-test");

interface StartedCase {
  lot: SeededLot;
  op: { id: string; leaseToken: string };
}

/**
 * A refunding lot with an approval in flight.
 * @returns The lot and the started approval with its lease.
 */
async function startedApprove(): Promise<StartedCase> {
  const lot = await seedRefundLot(suite.sql, "refunding");
  const op = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
  return { lot, op: { id: op.id, leaseToken: op.leaseToken! } };
}

/**
 * A refunding lot whose approval needs attention, and the retry started on it.
 * @returns The lot, the open approval, and the started retry.
 */
async function startedRetry(): Promise<StartedCase & { open: string }> {
  const lot = await seedRefundLot(suite.sql, "refunding");
  const open = await seedOperation(suite.sql, lot, {
    kind: "approve",
    status: "needs_attention",
    attentionReason: "partial_refund",
    createdSecondsAgo: 300,
  });
  const op = await seedOperation(suite.sql, lot, { kind: "retry", status: "started" });
  return { lot, open: open.id, op: { id: op.id, leaseToken: op.leaseToken! } };
}

describe("started × E1: impossible", () => {
  it("refuses a second E1 on the same row and writes nothing", async () => {
    const { lot, op } = await startedApprove();
    await expectImpossible(suite.sql, lot, { id: op.id }, "started", {
      type: "E1",
      create: {
        kind: "approve",
        lotId: lot.lotId,
        paymentId: lot.paymentId,
        idempotencyKey: `idem-${randomUUID()}`,
        requestHash: "b".repeat(64),
        requestedBy: "admin_7",
        reason: "again",
      },
      actor: "request",
    });
  });
});

describe("started × E2: the refund succeeded and the lot can be booked", () => {
  it("approve: books the lot on its refund, tells the buyer, appends one event", async () => {
    const { lot, op } = await startedApprove();
    const refundId = reId("own");
    await seedCopy(suite.sql, lot, {
      id: refundId,
      amountCents: 1080,
      status: "succeeded",
      operationId: op.id,
    });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E2",
        refund: refundObject(refundId, "succeeded", 1080, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    expect(returned).toMatchObject({ id: op.id, status: "succeeded", result: "refunded" });
    await expectBooked(suite.sql, lot, op.id, {
      refundId,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
    expect((await readOp(suite.sql, op.id)).stripe_refund_id).toBe(refundId);
    expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
      { event: "refund_succeeded", from_status: "started", to_status: "succeeded" },
    ]);
  });

  it("retry: books the lot and closes the approval's open needs_attention", async () => {
    const { lot, op, open } = await startedRetry();
    const external = reId("ext_confirmed");
    const own = reId("own_rest");
    await seedCopy(suite.sql, lot, { id: external, amountCents: 300, status: "succeeded" });
    await seedCopy(suite.sql, lot, {
      id: own,
      amountCents: 780,
      status: "succeeded",
      operationId: op.id,
    });
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E2",
        refund: refundObject(own, "succeeded", 780, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    await expectBooked(suite.sql, lot, op.id, {
      refundId: own,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
    await expectClosedBy(suite.sql, lot, before, open, op.id);
  });
});

describe("started × E3 / E5: Stripe holds the refund open", () => {
  it.each(["E3", "E5"] as const)(
    "approve × %s → awaiting_stripe with the refund id, nothing booked",
    async (type) => {
      const { lot, op } = await startedApprove();
      const refundId = reId(type);
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: op.id }, {
          type,
          refund: refundObject(refundId, type === "E3" ? "succeeded" : "pending", 1080, op.id),
          leaseToken: op.leaseToken,
          actor: "loop",
        }),
      );

      const row = await readOp(suite.sql, op.id);
      expect(row).toMatchObject({ status: "awaiting_stripe", result: null, stripe_refund_id: refundId });
      expect(row.next_attempt_us).not.toBeNull();
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
      expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
      expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
        {
          event: type === "E3" ? "refund_succeeded_others_pending" : "refund_pending",
          from_status: "started",
          to_status: "awaiting_stripe",
        },
      ]);
    },
  );
});

describe("started × E4: the refund succeeded but the payment is not covered as confirmed", () => {
  it.each(["partial_refund", "unexpected_external_refund"] as const)(
    "approve → needs_attention (%s), lot stays refunding, nothing booked or told",
    async (reason) => {
      const { lot, op } = await startedApprove();
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: op.id }, {
          type: "E4",
          refund: refundObject(reId("short"), "succeeded", 700, op.id),
          reason,
          leaseToken: op.leaseToken,
          actor: "loop",
        }),
      );

      const row = await readOp(suite.sql, op.id);
      expect(row).toMatchObject({
        status: "needs_attention",
        result: null,
        attention_reason: reason,
        attention_closed_at: null,
      });
      expect(row.finished_at).not.toBeNull();
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
      expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
      expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
      expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
        {
          event: "refund_succeeded_unsettleable",
          from_status: "started",
          to_status: "needs_attention",
        },
      ]);
    },
  );
});

describe("started × E6: Stripe did not refund — a person decides, the lot is left as it is (v9 §6.2, #9)", () => {
  /**
   * The cell's v9 outcome: needs_attention with `reason`, open, and every
   * other row of the lot exactly as before (lot, ledger, copies, bells,
   * mails), save the disposition's own row and its one new event row.
   * @param c - The started case.
   * @param before - The world before the event.
   * @param reason - The expected attention reason.
   * @param refundId - The refund id the row must record, or null.
   */
  async function expectDeclined(
    c: StartedCase,
    before: Awaited<ReturnType<typeof worldOf>>,
    reason: string,
    refundId: string | null,
  ): Promise<void> {
    const row = await readOp(suite.sql, c.op.id);
    expect(row).toMatchObject({
      status: "needs_attention",
      result: null,
      attention_reason: reason,
      attention_closed_at: null,
      stripe_refund_id: refundId,
      lease_token: null,
    });
    expect(row.finished_at).not.toBeNull();
    const after = await worldOf(suite.sql, c.lot);
    expect(after.lot).toEqual(before.lot);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.copies).toEqual(before.copies);
    expect(after.bells).toEqual(before.bells);
    expect(after.mails).toEqual(before.mails);
    expect(await newEventsOn(suite.sql, c.lot, before, c.op.id)).toEqual([
      { event: "refund_declined", from_status: "started", to_status: "needs_attention" },
    ]);
  }

  it("approve, its refund object failed and never succeeded → stripe_declined, lot stays refunding, nobody told", async () => {
    const c = await startedApprove();
    const refundId = reId("declined");
    const before = await worldOf(suite.sql, c.lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, {
        type: "E6",
        refund: refundObject(refundId, "failed", 1080, c.op.id),
        leaseToken: c.op.leaseToken,
        actor: "loop",
      }),
    );

    await expectDeclined(c, before, "stripe_declined", refundId);
    expect((await readLot(suite.sql, c.lot.lotId)).lifecycle).toBe("refunding");
    expect(await bellsOf(suite.sql, c.lot.userId)).toEqual([]);
  });

  it("retry, its refund object canceled → stripe_declined, lot stays refunding", async () => {
    const c = await startedRetry();
    const refundId = reId("canceled");
    const before = await worldOf(suite.sql, c.lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, {
        type: "E6",
        refund: refundObject(refundId, "canceled", 780, c.op.id),
        leaseToken: c.op.leaseToken,
        actor: "loop",
      }),
    );

    await expectDeclined(c, before, "stripe_declined", refundId);
    expect((await readLot(suite.sql, c.lot.lotId)).lifecycle).toBe("refunding");
  });

  it("a first-request 400 (no refund object) → stripe_declined; attention_detail is the first line of Stripe's message", async () => {
    const c = await startedApprove();
    const fail = failure(400, { code: "charge_disputed", type: "invalid_request_error" });
    const before = await worldOf(suite.sql, c.lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, { type: "E6", failure: fail, leaseToken: c.op.leaseToken, actor: "loop" }),
    );

    await expectDeclined(c, before, "stripe_declined", null);
    expect((await readOp(suite.sql, c.op.id)).attention_detail).toBe(fail.message.split("\n")[0]);
  });

  it.each([401, 403, 404])(
    "a first-request %i (our key, permission or payment id is wrong) → stripe_request_invalid, lot stays refunding",
    async (httpStatus) => {
      const c = await startedApprove();
      const fail = failure(httpStatus, { type: httpStatus === 404 ? "invalid_request_error" : "authentication_error" });
      const before = await worldOf(suite.sql, c.lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: c.op.id }, { type: "E6", failure: fail, leaseToken: c.op.leaseToken, actor: "loop" }),
      );

      await expectDeclined(c, before, "stripe_request_invalid", null);
    },
  );

  it("its refund failed after its copy once succeeded → stripe_refund_failed_later, lot stays refunding", async () => {
    const c = await startedApprove();
    const refundId = reId("back_again");
    await seedCopy(suite.sql, c.lot, { id: refundId, amountCents: 1080, status: "failed", everSucceeded: true, operationId: c.op.id });
    const before = await worldOf(suite.sql, c.lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, {
        type: "E6",
        refund: refundObject(refundId, "failed", 1080, c.op.id),
        leaseToken: c.op.leaseToken,
        actor: "loop",
      }),
    );

    await expectDeclined(c, before, "stripe_refund_failed_later", refundId);
  });

  it("never reads the lot: a lot moved out of refunding by hand stays where it is, and the reason still follows Stripe's answer (no state_mismatch)", async () => {
    const c = await startedApprove();
    await suite.sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${c.lot.lotId}`;
    const before = await worldOf(suite.sql, c.lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, {
        type: "E6",
        failure: failure(400, { code: "parameter_invalid" }),
        leaseToken: c.op.leaseToken,
        actor: "loop",
      }),
    );

    await expectDeclined(c, before, "stripe_declined", null);
    expect((await readLot(suite.sql, c.lot.lotId)).lifecycle).toBe("refund_pending");
  });
});

describe("started × E7 / E16 / E17: try again later with the same key", () => {
  const EARLIER_CREATE_ERROR = "synthetic 429 from an earlier create";

  it.each([
    ["E7", failure(429, { code: "rate_limit" })],
    ["E16", failure(503)],
    ["E17", failure(402, { code: "card_declined" })],
  ] as const)(
    "%s stays started, counts the attempt, records only a create error, releases the lease, and pushes next_attempt_at out",
    async (type, fail) => {
      for (const make of [startedApprove, startedRetry]) {
        const { lot, op } = await make();
        await setLastError(suite.sql, op.id, EARLIER_CREATE_ERROR);
        const before = await worldOf(suite.sql, lot);
        const clock = await dbClockUs(suite.sql);
        const { backoffMaxSeconds } = getCreditRefundConfig();

        await inTx((tx) =>
          transitionOperation(tx, { id: op.id }, { type, failure: fail, leaseToken: op.leaseToken, actor: "loop" }),
        );

        const row = await readOp(suite.sql, op.id);
        expect(row).toMatchObject({ status: "started", result: null, attempt_count: 1 });
        // last_error holds refunds.create errors only; a failed read's text
        // is in its event row (v8 round 5, §5.1).
        if (type === "E16") expect(row.last_error).toBe(EARLIER_CREATE_ERROR);
        else expect(row.last_error).toContain(fail.message.split("\n")[0]);
        // The attempt is over: the lease ends now, its token stays so a late
        // answer of the same executor is still recognised (v8 round 5, §6.2).
        await expectLeaseReleased(suite.sql, op.id, op.leaseToken);
        expect(row.next_attempt_us!).toBeGreaterThan(clock);
        expect(row.next_attempt_us!).toBeLessThanOrEqual(
          (await dbClockUs(suite.sql)) + backoffMaxSeconds * 1_000_000,
        );
        expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
        expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
        const added = await newEventsOn(suite.sql, lot, before, op.id);
        expect(added).toEqual([
          {
            event: { E7: "retryable_error", E16: "stripe_read_failed", E17: "unclassified_error" }[type],
            from_status: "started",
            to_status: "started",
          },
        ]);
      }
    },
  );

  it("records the Stripe answer in the event detail", async () => {
    const { lot, op } = await startedApprove();
    const fail = failure(409, { code: "lock_timeout", type: "api_error" });
    const before = await worldOf(suite.sql, lot);
    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, { type: "E7", failure: fail, leaseToken: op.leaseToken, actor: "loop" }),
    );
    const after = await worldOf(suite.sql, lot);
    const added = after.events.slice(before.events.length);
    expect(added).toHaveLength(1);
    expect(added[0]!.detail).toMatchObject({
      httpStatus: 409,
      code: "lock_timeout",
      type: "api_error",
      message: fail.message,
    });
  });
});

describe("started × E8: a 5xx — outcome unknown", () => {
  it.each([startedApprove, startedRetry])(
    "→ awaiting_stripe with no refund id, the error kept, a next look scheduled (%#)",
    async (make) => {
      const { lot, op } = await make();
      const lifecycle = (await readLot(suite.sql, lot.lotId)).lifecycle;
      const fail = failure(500, { type: "api_error" });
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: op.id }, { type: "E8", failure: fail, leaseToken: op.leaseToken, actor: "loop" }),
      );

      const row = await readOp(suite.sql, op.id);
      expect(row).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null, result: null });
      expect(row.last_error).toContain(fail.message.split("\n")[0]);
      expect(row.next_attempt_us).not.toBeNull();
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe(lifecycle);
      expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
        { event: "stripe_server_error", from_status: "started", to_status: "awaiting_stripe" },
      ]);
    },
  );
});

describe("started × E9: charge_already_refunded and no refund of ours", () => {
  it.each([startedApprove, startedRetry])(
    "→ needs_attention already_refunded_elsewhere with the first line of Stripe's message (%#)",
    async (make) => {
      const { lot, op } = await make();
      const lifecycle = (await readLot(suite.sql, lot.lotId)).lifecycle;
      const fail = failure(400, { code: "charge_already_refunded", type: "invalid_request_error" });
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: op.id }, { type: "E9", failure: fail, leaseToken: op.leaseToken, actor: "loop" }),
      );

      const row = await readOp(suite.sql, op.id);
      expect(row).toMatchObject({
        status: "needs_attention",
        attention_reason: "already_refunded_elsewhere",
        attention_detail: fail.message.split("\n")[0],
      });
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe(lifecycle);
      expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
      const after = await worldOf(suite.sql, lot);
      const added = after.events.slice(before.events.length);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        event: "charge_already_refunded",
        from_status: "started",
        to_status: "needs_attention",
      });
      expect(added[0]!.detail).toMatchObject({ code: "charge_already_refunded", httpStatus: 400 });
    },
  );
});

describe("started × E10 / E14: impossible", () => {
  it.each(["E10", "E14"] as const)("%s is refused and writes nothing", async (type) => {
    const { lot, op } = await startedApprove();
    await expectImpossible(suite.sql, lot, { id: op.id }, "started", eventOf(type));
  });
});

describe("started × E11: attempts used up — the reason follows the create answers in the event rows (v9 §5.4, §6.2)", () => {
  type Step = (c: StartedCase) => Promise<unknown>;
  type Fail = ReturnType<typeof failure>;

  /** A create answer from the second attempt on, under the held lease: E17, stays started. */
  const later = (fail: Fail): Step => (c) =>
    inTx((tx) => transitionOperation(tx, { id: c.op.id }, { type: "E17", failure: fail, leaseToken: c.op.leaseToken, actor: "loop" }));
  /** A retryable create answer: E7, stays started. */
  const retryable = (fail: Fail): Step => (c) =>
    inTx((tx) => transitionOperation(tx, { id: c.op.id }, { type: "E7", failure: fail, leaseToken: c.op.leaseToken, actor: "loop" }));
  /** A create answer whose list read after it failed: E16 carrying the create's failure. */
  const readFailedAfter = (createFailure: Fail): Step => (c) =>
    inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, {
        type: "E16",
        failure: failure(503),
        createFailure,
        leaseToken: c.op.leaseToken,
        actor: "loop",
      }),
    );
  /** A create answer under a lease the row no longer holds: a late_answer row. */
  const late = (fail: Fail): Step => (c) =>
    inTx((tx) => transitionOperation(tx, { id: c.op.id }, { type: "E17", failure: fail, leaseToken: randomUUID(), actor: "loop" }));

  const refusal400 = (): Fail => failure(400, { code: "charge_disputed", type: "invalid_request_error" });
  const timeout = (): Fail => ({ message: "Request timed out\nsecond line" });

  it.each<[string, string, () => Step[]]>([
    ["a later 400 refusal (E17)", "stripe_declined", () => [later(refusal400())]],
    ["a refusal, then a timeout (E17, then E7)", "stripe_declined", () => [later(refusal400()), retryable(timeout())]],
    ["a refusal carried in an E16 createFailure", "stripe_declined", () => [readFailedAfter(refusal400())]],
    ["a refusal in a late_answer row", "stripe_declined", () => [late(refusal400())]],
    ["no create answer at all", "attempts_exhausted", () => []],
    ["a timeout and a 429", "attempts_exhausted", () => [retryable(timeout()), retryable(failure(429, { code: "rate_limit" }))]],
    ["a 402 and a 400 rate_limit", "attempts_exhausted", () => [later(failure(402, { code: "card_declined" })), later(failure(400, { code: "rate_limit" }))]],
    ["a 400 lock_timeout, a 400 charge_already_refunded and a 400 idempotency_error", "attempts_exhausted", () => [
        later(failure(400, { code: "lock_timeout" })),
        later(failure(400, { code: "charge_already_refunded" })),
        later(failure(400, { type: "idempotency_error" })),
      ]],
    ["a 400 with Stripe-Should-Retry: true", "attempts_exhausted", () => [later(failure(400, { shouldRetry: true }))]],
    ["a 5xx inside an E16 createFailure", "attempts_exhausted", () => [readFailedAfter(failure(502, { type: "api_error" }))]],
  ])("%s → needs_attention %s, lot where it was", async (_name, reason, steps) => {
    for (const make of [startedApprove, startedRetry]) {
      const c = await make();
      for (const step of steps()) await step(c);
      const lotBefore = await readLot(suite.sql, c.lot.lotId);
      const before = await worldOf(suite.sql, c.lot);

      await inTx((tx) => transitionOperation(tx, { id: c.op.id }, { type: "E11", actor: "loop" }));

      expect(await readOp(suite.sql, c.op.id)).toMatchObject({
        status: "needs_attention",
        attention_reason: reason,
        result: null,
      });
      expect(await readLot(suite.sql, c.lot.lotId)).toEqual(lotBefore);
      expect(await newEventsOn(suite.sql, c.lot, before, c.op.id)).toEqual([
        { event: "attempts_exhausted", from_status: "started", to_status: "needs_attention" },
      ]);
    }
  });

  it("a refusal recorded on another disposition of the same lot does not count", async () => {
    const c = await startedRetry();
    const other = await seedOperation(suite.sql, c.lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "attempts_exhausted",
      createdSecondsAgo: 900,
    });
    await suite.sql`
      INSERT INTO credit_refund_operation_events (operation_id, event, from_status, to_status, detail)
      VALUES (${other.id}, 'unclassified_error', 'started', 'started',
              ${suite.sql.json({ message: "refused", httpStatus: 400, code: "charge_disputed", actor: "loop" })})
    `;

    await inTx((tx) => transitionOperation(tx, { id: c.op.id }, { type: "E11", actor: "loop" }));

    expect((await readOp(suite.sql, c.op.id)).attention_reason).toBe("attempts_exhausted");
  });

  // attention_detail is the reason's own original text, first line (§5.1,
  // acceptance #9). last_error is overwritten by every later attempt and a
  // late answer never writes it, so stripe_declined reads the refusal itself.
  const REFUSAL_LINE = "A previous attempt to refund charge ch_x to card failed";
  const refusalWithText = (): Fail => ({
    message: `${REFUSAL_LINE}\nsecond line`,
    httpStatus: 400,
    type: "invalid_request_error",
  });
  /** A 400 refusal (E6) under a lease the row no longer holds: a late_answer row. */
  const lateRefusalE6: Step = (c) =>
    inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, { type: "E6", failure: refusalWithText(), leaseToken: randomUUID(), actor: "loop" }),
    );
  /** A failed refund object (E6) under a lease the row no longer holds: a late_answer row. */
  const lateFailedRefund: Step = (c) =>
    inTx((tx) =>
      transitionOperation(tx, { id: c.op.id }, {
        type: "E6",
        refund: { ...refundObject(reId("late_failed"), "failed", 1080), failure_reason: "expired_or_canceled_card" },
        leaseToken: randomUUID(),
        actor: "loop",
      }),
    );

  it.each<[string, string, string, () => Step[]]>([
    ["a 400 refusal (E17), then a timeout (E7)", "stripe_declined", REFUSAL_LINE, () => [later(refusalWithText()), retryable(timeout())]],
    ["a timeout (E7), then the refusal only in a late_answer (E6)", "stripe_declined", REFUSAL_LINE, () => [retryable(timeout()), lateRefusalE6]],
    ["a timeout (E7), then the refusal only in a late_answer (E17)", "stripe_declined", REFUSAL_LINE, () => [retryable(timeout()), late(refusalWithText())]],
    ["a timeout (E7), then a late_answer with a failed refund object", "stripe_declined", "expired_or_canceled_card", () => [retryable(timeout()), lateFailedRefund]],
    ["no refusal anywhere: a timeout", "attempts_exhausted", "Request timed out", () => [retryable(timeout())]],
  ])("F15: %s → needs_attention %s, attention_detail %j", async (_name, reason, detail, steps) => {
    for (const make of [startedApprove, startedRetry]) {
      const c = await make();
      for (const step of steps()) await step(c);
      expect((await readOp(suite.sql, c.op.id)).last_error).toMatch(/^Request timed out/);

      await inTx((tx) => transitionOperation(tx, { id: c.op.id }, { type: "E11", actor: "loop" }));

      expect(await readOp(suite.sql, c.op.id)).toMatchObject({
        status: "needs_attention",
        attention_reason: reason,
        attention_detail: detail,
      });
    }
  });
});

describe("started × E12: 24 hours since the first call — the attempt cap governs started", () => {
  it("stays started and changes nothing else", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const op = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "started",
      firstCalledHoursAgo: 25,
      attemptCount: 3,
    });
    await expectStays(suite.sql, lot, op.id, "started", { type: "E12", actor: "loop" });
  });
});

describe("started × E13: the lease ran out", () => {
  it("stays started under a new lease the claimer can use", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const op = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "started",
      leaseExpired: true,
    });
    const { leaseSeconds } = getCreditRefundConfig();
    const before = await worldOf(suite.sql, lot);
    const clockBefore = await dbClockUs(suite.sql);

    const returned = await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13", actor: "loop" }));

    const clockAfter = await dbClockUs(suite.sql);
    const row = await readOp(suite.sql, op.id);
    expect(row.status).toBe("started");
    expect(row.lease_token).not.toBeNull();
    expect(row.lease_token).not.toBe(op.leaseToken);
    expect(returned!.leaseToken).toBe(row.lease_token);
    expect(row.locked_until_us!).toBeGreaterThanOrEqual(clockBefore + leaseSeconds * 1_000_000);
    expect(row.locked_until_us!).toBeLessThanOrEqual(clockAfter + leaseSeconds * 1_000_000);
    expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
      { event: "claimed", from_status: "started", to_status: "started" },
    ]);
  });
});

describe("started × E15: an answer under a lease the row no longer holds", () => {
  it("is discarded: nothing booked, one late_answer row", async () => {
    const { lot, op } = await startedApprove();
    const refundId = reId("late");
    await seedCopy(suite.sql, lot, {
      id: refundId,
      amountCents: 1080,
      status: "succeeded",
      operationId: op.id,
    });
    await expectStays(
      suite.sql,
      lot,
      op.id,
      "started",
      {
        type: "E2",
        refund: refundObject(refundId, "succeeded", 1080, op.id),
        leaseToken: randomUUID(),
        actor: "loop",
      },
      "late_answer",
    );
  });

  it("an old holder's answer after E13 handed the lease on is discarded too", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const op = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "started",
      leaseExpired: true,
    });
    await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13", actor: "loop" }));
    await expectStays(
      suite.sql,
      lot,
      op.id,
      "started",
      { type: "E7", failure: failure(409), leaseToken: op.leaseToken!, actor: "loop" },
      "late_answer",
    );
  });
});
