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
 * | event | approve, retry                                  | refund_again                                |
 * |-------|-------------------------------------------------|---------------------------------------------|
 * | E1    | impossible                                      | impossible                                  |
 * | E2    | succeeded/refunded, booked (§5.5), bell + mail  | succeeded/refunded, no ledger, failed refunds resolved |
 * | E3    | awaiting_stripe, refund id kept                 | impossible                                  |
 * | E4    | needs_attention (reason given)                  | impossible                                  |
 * | E5    | awaiting_stripe, refund id kept                 | same                                        |
 * | E6    | succeeded/sent_back, lot back to refund_pending | needs_attention stripe_declined, lot stays  |
 * | E7    | stays, attempt + 1, backoff, lease released     | same                                        |
 * | E8    | awaiting_stripe, no refund id                   | same                                        |
 * | E9    | needs_attention already_refunded_elsewhere      | same                                        |
 * | E10   | impossible                                      | impossible                                  |
 * | E11   | needs_attention attempts_exhausted              | same                                        |
 * | E12   | stays                                           | stays                                       |
 * | E13   | stays, new lease                                | same                                        |
 * | E14   | impossible                                      | impossible                                  |
 * | E15   | discarded                                       | discarded                                   |
 * | E16   | stays, attempt + 1, backoff, lease released, last_error kept | same                           |
 * | E17   | stays, attempt + 1, backoff, lease released     | same                                        |
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
  CREDITS,
  bellsOf,
  copiesOf,
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
  autoMail,
  eventOf,
  expectBooked,
  expectClosedBy,
  expectCompletedBell,
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

/**
 * A refunded lot whose approval's refund later failed, and the refund_again
 * started for it.
 * @param notify - The refund_again's notify.
 * @returns The lot, the failed refund id, and the started refund_again.
 */
async function startedRefundAgain(
  notify = true,
): Promise<StartedCase & { failed: string; approve: string }> {
  const lot = await seedRefundLot(suite.sql, "refunded");
  const approve = await seedOperation(suite.sql, lot, {
    kind: "approve",
    status: "succeeded",
    result: "refunded",
    createdSecondsAgo: 600,
  });
  const failed = reId("failed_later");
  await seedCopy(suite.sql, lot, {
    id: failed,
    amountCents: 1080,
    status: "failed",
    everSucceeded: true,
    operationId: approve.id,
  });
  const op = await seedOperation(suite.sql, lot, {
    kind: "refund_again",
    status: "started",
    notify,
    failedRefundIds: [failed],
    refundAmountCents: 1080,
  });
  return { lot, failed, approve: approve.id, op: { id: op.id, leaseToken: op.leaseToken! } };
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

  it("refund_again: no ledger row, the failed refunds it covers are resolved by it, bell and mail", async () => {
    const { lot, op, failed } = await startedRefundAgain(true);
    const fresh = reId("again");
    await seedCopy(suite.sql, lot, {
      id: fresh,
      amountCents: 1080,
      status: "succeeded",
      operationId: op.id,
    });
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E2",
        refund: refundObject(fresh, "succeeded", 1080, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    const row = await readOp(suite.sql, op.id);
    expect(row).toMatchObject({ status: "succeeded", result: "refunded", stripe_refund_id: fresh });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refunded",
      remaining: "0.000000",
      attempts: 0,
    });
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    const byId = new Map((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c]));
    expect(byId.get(failed)!.resolved_by_operation_id).toBe(op.id);
    expect(byId.get(fresh)!.resolved_by_operation_id).toBeNull();
    await expectCompletedBell(suite.sql, lot, 1080);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([autoMail(op.id, "refund_completed")]);
    expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
      { event: "refund_succeeded", from_status: "started", to_status: "succeeded" },
    ]);
  });

  it("refund_again with notify false: resolved, but no bell and no mail", async () => {
    const { lot, op, failed } = await startedRefundAgain(false);
    const fresh = reId("again_quiet");

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E2",
        refund: refundObject(fresh, "succeeded", 1080, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    expect((await readOp(suite.sql, op.id)).result).toBe("refunded");
    const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failed);
    expect(copy!.resolved_by_operation_id).toBe(op.id);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("refund_again closes an earlier refund_again's open needs_attention on the same lot", async () => {
    const { lot, op, failed } = await startedRefundAgain(true);
    const earlier = await seedOperation(suite.sql, lot, {
      kind: "refund_again",
      status: "needs_attention",
      attentionReason: "already_refunded_elsewhere",
      failedRefundIds: [failed],
      refundAmountCents: 1080,
      createdSecondsAgo: 120,
    });
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E2",
        refund: refundObject(reId("again"), "succeeded", 1080, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    await expectClosedBy(suite.sql, lot, before, earlier.id, op.id);
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

  it("refund_again × E5 → awaiting_stripe with the refund id", async () => {
    const { lot, op } = await startedRefundAgain();
    const refundId = reId("again_pending");
    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E5",
        refund: refundObject(refundId, "pending", 1080, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );
    expect(await readOp(suite.sql, op.id)).toMatchObject({
      status: "awaiting_stripe",
      stripe_refund_id: refundId,
    });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunded");
  });

  it("refund_again × E3 is impossible: it does not use the settle rule", async () => {
    const { lot, op } = await startedRefundAgain();
    await expectImpossible(suite.sql, lot, { id: op.id }, "started", eventOf("E3"));
  });
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

  it("refund_again × E4 is impossible", async () => {
    const { lot, op } = await startedRefundAgain();
    await expectImpossible(suite.sql, lot, { id: op.id }, "started", eventOf("E4"));
  });
});

describe("started × E6: the first definite answer is that Stripe did not refund (#9)", () => {
  it("approve → succeeded/sent_back, lot back to refund_pending, credits and ledger untouched, nobody told", async () => {
    const { lot, op } = await startedApprove();
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E6",
        refund: refundObject(reId("declined"), "failed", 1080, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    const row = await readOp(suite.sql, op.id);
    expect(row).toMatchObject({ status: "succeeded", result: "sent_back" });
    expect(row.finished_at).not.toBeNull();
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refund_pending",
      remaining: `${CREDITS}.000000`,
      attempts: 0,
    });
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
      { event: "refund_declined", from_status: "started", to_status: "succeeded" },
    ]);
  });

  it("approve × E6 with no refund object (a first-request 400) behaves the same", async () => {
    const { lot, op } = await startedApprove();
    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E6",
        failure: failure(400, { code: "parameter_invalid_integer" }),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );
    expect(await readOp(suite.sql, op.id)).toMatchObject({ status: "succeeded", result: "sent_back" });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refund_pending");
  });

  it("retry → succeeded/sent_back, lot back to refund_pending, and the open approval is closed", async () => {
    const { lot, op, open } = await startedRetry();
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E6",
        refund: refundObject(reId("declined"), "canceled", 780, op.id),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    expect(await readOp(suite.sql, op.id)).toMatchObject({ status: "succeeded", result: "sent_back" });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refund_pending");
    await expectClosedBy(suite.sql, lot, before, open, op.id);
  });

  it("refund_again → needs_attention stripe_declined, lot stays refunded, the failed refund stays unresolved", async () => {
    const { lot, op, failed } = await startedRefundAgain();
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, {
        type: "E6",
        failure: failure(400, { code: "amount_too_large" }),
        leaseToken: op.leaseToken,
        actor: "loop",
      }),
    );

    expect(await readOp(suite.sql, op.id)).toMatchObject({
      status: "needs_attention",
      result: null,
      attention_reason: "stripe_declined",
    });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refunded",
      remaining: "0.000000",
      attempts: 0,
    });
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failed);
    expect(copy!.resolved_by_operation_id).toBeNull();
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
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
      for (const make of [startedApprove, startedRefundAgain]) {
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
        expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe(
          make === startedApprove ? "refunding" : "refunded",
        );
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
  it.each([startedApprove, startedRefundAgain])(
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
  it.each([startedApprove, startedRefundAgain])(
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

describe("started × E11: attempts used up", () => {
  it.each([startedApprove, startedRefundAgain])(
    "→ needs_attention attempts_exhausted, lot where it was (%#)",
    async (make) => {
      const { lot, op } = await make();
      const lifecycle = (await readLot(suite.sql, lot.lotId)).lifecycle;
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E11", actor: "loop" }));

      expect(await readOp(suite.sql, op.id)).toMatchObject({
        status: "needs_attention",
        attention_reason: "attempts_exhausted",
        result: null,
      });
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe(lifecycle);
      expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
        { event: "attempts_exhausted", from_status: "started", to_status: "needs_attention" },
      ]);
    },
  );
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
