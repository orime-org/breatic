// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `transitionOperation` on the `awaiting_stripe` line of the disposition
 * table (inner#1410 §6.2), one case per cell, on real Postgres.
 *
 * `awaiting_stripe` only looks Stripe up, never creates, and holds no lease;
 * the refund id is set after a pending answer and empty after a 5xx.
 *
 * | event | approve, retry                                         | refund_again                                |
 * |-------|--------------------------------------------------------|---------------------------------------------|
 * | E1    | impossible                                             | impossible                                  |
 * | E2    | succeeded/refunded, booked, bell + mail                | succeeded/refunded, no ledger, resolved     |
 * | E3    | stays, refund id kept                                  | impossible                                  |
 * | E4    | needs_attention (reason given)                         | impossible                                  |
 * | E5    | stays, refund id kept                                  | same                                        |
 * | E6    | needs_attention stripe_refund_failed_later, lot stays  | same, lot stays refunded                    |
 * | E7–E9 | impossible                                             | impossible                                  |
 * | E10   | id empty: stays, backoff, no attempt counted; id set: impossible |                                   |
 * | E11   | impossible                                             | impossible                                  |
 * | E12   | id empty: needs_attention stripe_result_unknown; id set: stays |                                     |
 * | E13   | stays (no lease to lose)                               | same                                        |
 * | E14   | impossible                                             | impossible                                  |
 * | E15   | discarded                                              | discarded                                   |
 * | E16   | stays, last_error kept, backoff, no attempt counted    | same                                        |
 * | E17   | impossible                                             | impossible                                  |
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
import {
  bellsOf,
  copiesOf,
  dbClockUs,
  eventsOf,
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
  useRefundSuite,
  worldOf,
  type OpKind,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import {
  autoMail,
  eventOf,
  expectBooked,
  expectCompletedBell,
  expectImpossible,
  expectStays,
  failure,
  newEventsOn,
} from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-op-awaiting-test");

interface AwaitingCase {
  lot: SeededLot;
  opId: string;
  /** refund_again only: the failed refund it covers. */
  failed?: string;
}

/**
 * A disposition waiting on Stripe.
 * @param kind - approve, retry or refund_again.
 * @param stripeRefundId - The refund it waits on; null after a 5xx.
 * @param firstCalledHoursAgo - When it first called Stripe.
 * @returns The lot and the disposition.
 */
async function awaiting(
  kind: Extract<OpKind, "approve" | "retry" | "refund_again">,
  stripeRefundId: string | null,
  firstCalledHoursAgo = 1,
): Promise<AwaitingCase> {
  if (kind === "refund_again") {
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
      kind,
      status: "awaiting_stripe",
      stripeRefundId,
      failedRefundIds: [failed],
      refundAmountCents: 1080,
      notify: true,
      firstCalledHoursAgo,
      attemptCount: 1,
    });
    return { lot, opId: op.id, failed };
  }
  const lot = await seedRefundLot(suite.sql, "refunding");
  if (kind === "retry") {
    await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "attempts_exhausted",
      createdSecondsAgo: 600,
    });
  }
  const op = await seedOperation(suite.sql, lot, {
    kind,
    status: "awaiting_stripe",
    stripeRefundId,
    firstCalledHoursAgo,
    attemptCount: 1,
  });
  return { lot, opId: op.id };
}

describe("awaiting_stripe × E1, E7, E8, E9, E11, E14, E17: impossible", () => {
  it("E1 is refused and writes nothing", async () => {
    const { lot, opId } = await awaiting("approve", reId("p"));
    await expectImpossible(suite.sql, lot, { id: opId }, "awaiting_stripe", {
      type: "E1",
      create: {
        kind: "retry",
        lotId: lot.lotId,
        paymentId: lot.paymentId,
        idempotencyKey: `idem-${randomUUID()}`,
        requestHash: "c".repeat(64),
        requestedBy: "admin_7",
        reason: "again",
      },
      actor: "request",
    });
  });

  it.each(["E7", "E8", "E9", "E11", "E14", "E17"] as const)(
    "%s is refused and writes nothing",
    async (type) => {
      const { lot, opId } = await awaiting("approve", null);
      await expectImpossible(suite.sql, lot, { id: opId }, "awaiting_stripe", eventOf(type));
    },
  );

  it.each(["E3", "E4"] as const)("refund_again × %s is refused and writes nothing", async (type) => {
    const { lot, opId } = await awaiting("refund_again", reId("p"));
    await expectImpossible(suite.sql, lot, { id: opId }, "awaiting_stripe", eventOf(type));
  });

  it("E10 with a refund id is refused: looking it up by id always finds it", async () => {
    const { lot, opId } = await awaiting("approve", reId("p"));
    await expectImpossible(suite.sql, lot, { id: opId }, "awaiting_stripe", eventOf("E10"));
  });
});

describe("awaiting_stripe × E2: the refund it waited on succeeded and the lot can be booked", () => {
  it.each(["approve", "retry"] as const)(
    "%s: books the lot on that refund, tells the buyer, one event",
    async (kind) => {
      const refundId = reId("waited");
      const { lot, opId } = await awaiting(kind, refundId);
      await seedCopy(suite.sql, lot, {
        id: refundId,
        amountCents: 1080,
        status: "succeeded",
        operationId: opId,
      });
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: opId }, {
          type: "E2",
          refund: refundObject(refundId, "succeeded", 1080, opId),
          actor: "loop",
        }),
      );

      await expectBooked(suite.sql, lot, opId, {
        refundId,
        settledCents: 1080,
        notify: true,
        amountCents: 1080,
      });
      expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
        { event: "refund_succeeded", from_status: "awaiting_stripe", to_status: "succeeded" },
      ]);
    },
  );

  it("approve after a 5xx (no id yet): books on the refund found and records its id", async () => {
    const { lot, opId } = await awaiting("approve", null);
    const refundId = reId("found_later");
    await seedCopy(suite.sql, lot, {
      id: refundId,
      amountCents: 1080,
      status: "succeeded",
      operationId: opId,
    });

    await inTx((tx) =>
      transitionOperation(tx, { id: opId }, {
        type: "E2",
        refund: refundObject(refundId, "succeeded", 1080, opId),
        actor: "loop",
      }),
    );

    await expectBooked(suite.sql, lot, opId, {
      refundId,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
    expect((await readOp(suite.sql, opId)).stripe_refund_id).toBe(refundId);
  });

  it("refund_again: no ledger row, the failed refund is resolved by it, bell and mail", async () => {
    const refundId = reId("again");
    const { lot, opId, failed } = await awaiting("refund_again", refundId);
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) =>
      transitionOperation(tx, { id: opId }, {
        type: "E2",
        refund: refundObject(refundId, "succeeded", 1080, opId),
        actor: "loop",
      }),
    );

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "succeeded", result: "refunded" });
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refunded",
      remaining: "0.000000",
      attempts: 0,
    });
    const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failed);
    expect(copy!.resolved_by_operation_id).toBe(opId);
    await expectCompletedBell(suite.sql, lot, 1080);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([autoMail(opId, "refund_completed")]);
  });
});

describe("awaiting_stripe × E3 / E5: still open at Stripe", () => {
  it.each(["E3", "E5"] as const)(
    "approve × %s stays awaiting_stripe and records the refund id it now knows",
    async (type) => {
      const { lot, opId } = await awaiting("approve", null);
      const refundId = reId(type);
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: opId }, {
          type,
          refund: refundObject(refundId, type === "E3" ? "succeeded" : "pending", 1080, opId),
          actor: "loop",
        }),
      );

      expect(await readOp(suite.sql, opId)).toMatchObject({
        status: "awaiting_stripe",
        stripe_refund_id: refundId,
        result: null,
      });
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
      expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
      expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
        {
          event: type === "E3" ? "refund_succeeded_others_pending" : "refund_pending",
          from_status: "awaiting_stripe",
          to_status: "awaiting_stripe",
        },
      ]);
    },
  );

  it("refund_again × E5 stays awaiting_stripe", async () => {
    const refundId = reId("again_pending");
    const { lot, opId } = await awaiting("refund_again", refundId);
    await expectStays(suite.sql, lot, opId, "awaiting_stripe", {
      type: "E5",
      refund: refundObject(refundId, "pending", 1080, opId),
      actor: "loop",
    });
  });
});

describe("awaiting_stripe × E4: succeeded, but the payment is not covered as confirmed", () => {
  it.each(["partial_refund", "unexpected_external_refund"] as const)(
    "approve → needs_attention %s, lot stays refunding, nothing booked",
    async (reason) => {
      const refundId = reId("waited");
      const { lot, opId } = await awaiting("approve", refundId);
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: opId }, {
          type: "E4",
          refund: refundObject(refundId, "succeeded", 1080, opId),
          reason,
          actor: "loop",
        }),
      );

      expect(await readOp(suite.sql, opId)).toMatchObject({
        status: "needs_attention",
        attention_reason: reason,
        attention_closed_at: null,
      });
      expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
      expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
      expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
        {
          event: "refund_succeeded_unsettleable",
          from_status: "awaiting_stripe",
          to_status: "needs_attention",
        },
      ]);
    },
  );
});

describe("awaiting_stripe × E6: Stripe took the refund, then it failed (#10)", () => {
  it.each(["approve", "retry", "refund_again"] as const)(
    "%s → needs_attention stripe_refund_failed_later, the lot does not move, nothing is told",
    async (kind) => {
      const refundId = reId("failed_later");
      const { lot, opId, failed } = await awaiting(kind, refundId);
      const lotBefore = await readLot(suite.sql, lot.lotId);
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) =>
        transitionOperation(tx, { id: opId }, {
          type: "E6",
          refund: refundObject(refundId, "failed", 1080, opId),
          actor: "loop",
        }),
      );

      expect(await readOp(suite.sql, opId)).toMatchObject({
        status: "needs_attention",
        attention_reason: "stripe_refund_failed_later",
        result: null,
      });
      expect(await readLot(suite.sql, lot.lotId)).toEqual(lotBefore);
      expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
      expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
      expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
      if (failed) {
        const copy = (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === failed);
        expect(copy!.resolved_by_operation_id).toBeNull();
      }
      expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
        { event: "refund_declined", from_status: "awaiting_stripe", to_status: "needs_attention" },
      ]);
    },
  );
});

describe("awaiting_stripe × E10: the lookup after a 5xx found nothing", () => {
  it("stays, does not count an attempt, and pushes the next look out", async () => {
    const { lot, opId } = await awaiting("approve", null);
    const clock = await dbClockUs(suite.sql);
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) => transitionOperation(tx, { id: opId }, { type: "E10", actor: "loop" }));

    const row = await readOp(suite.sql, opId);
    expect(row).toMatchObject({ status: "awaiting_stripe", stripe_refund_id: null, attempt_count: 1 });
    expect(row.next_attempt_us!).toBeGreaterThan(clock);
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "refund_not_found", from_status: "awaiting_stripe", to_status: "awaiting_stripe" },
    ]);
  });
});

describe("awaiting_stripe × E12: 24 hours since the first call", () => {
  it("with no refund id → needs_attention stripe_result_unknown, lot stays refunding", async () => {
    const { lot, opId } = await awaiting("approve", null, 25);
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) => transitionOperation(tx, { id: opId }, { type: "E12", actor: "loop" }));

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_result_unknown",
    });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "deadline_reached", from_status: "awaiting_stripe", to_status: "needs_attention" },
    ]);
  });

  it("with a refund id stays: Stripe may hold a refund open for long", async () => {
    const refundId = reId("slow");
    const { lot, opId } = await awaiting("approve", refundId, 25);
    const before = await worldOf(suite.sql, lot);

    await inTx((tx) => transitionOperation(tx, { id: opId }, { type: "E12", actor: "loop" }));

    // next_attempt_at may move: the loop keeps looking on its backoff.
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "awaiting_stripe",
      stripe_refund_id: refundId,
      attention_reason: null,
      result: null,
    });
    const after = await worldOf(suite.sql, lot);
    expect(after.lot).toEqual(before.lot);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.bells).toEqual(before.bells);
    expect(after.mails).toEqual(before.mails);
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "deadline_reached", from_status: "awaiting_stripe", to_status: "awaiting_stripe" },
    ]);
  });
});

describe("awaiting_stripe × E13: no lease to lose", () => {
  it("leaves everything as it was", async () => {
    const { lot, opId } = await awaiting("approve", reId("p"));
    await expectStays(suite.sql, lot, opId, "awaiting_stripe", { type: "E13", actor: "loop" });
    expect((await readOp(suite.sql, opId)).lease_token).toBeNull();
  });
});

describe("awaiting_stripe × E15: a late executor's answer", () => {
  it("is discarded even when it says succeeded", async () => {
    const refundId = reId("late");
    const { lot, opId } = await awaiting("approve", refundId);
    await seedCopy(suite.sql, lot, {
      id: refundId,
      amountCents: 1080,
      status: "succeeded",
      operationId: opId,
    });
    await expectStays(
      suite.sql,
      lot,
      opId,
      "awaiting_stripe",
      {
        type: "E2",
        refund: refundObject(refundId, "succeeded", 1080, opId),
        leaseToken: randomUUID(),
        actor: "loop",
      },
      "late_answer",
    );
  });

  it("is discarded rather than refused when its type is impossible here (E7)", async () => {
    const { lot, opId } = await awaiting("approve", null);
    await expectStays(
      suite.sql,
      lot,
      opId,
      "awaiting_stripe",
      { type: "E7", failure: failure(409), leaseToken: randomUUID(), actor: "loop" },
      "late_answer",
    );
  });
});

describe("awaiting_stripe × E16: reading Stripe failed", () => {
  it.each(["approve", "refund_again"] as const)(
    "%s stays, leaves last_error to the create error, does not count an attempt, pushes the next look out",
    async (kind) => {
      const { lot, opId } = await awaiting(kind, reId("p"));
      const createError = "synthetic 500 from the create";
      await suite.sql`UPDATE credit_refund_operations SET last_error = ${createError} WHERE id = ${opId}`;
      const fail = failure(503);
      const clock = await dbClockUs(suite.sql);
      const before = await worldOf(suite.sql, lot);

      await inTx((tx) => transitionOperation(tx, { id: opId }, { type: "E16", failure: fail, actor: "loop" }));

      const row = await readOp(suite.sql, opId);
      expect(row).toMatchObject({ status: "awaiting_stripe", attempt_count: 1 });
      // last_error holds refunds.create errors only (v8 round 5, §5.1).
      expect(row.last_error).toBe(createError);
      expect(row.next_attempt_us!).toBeGreaterThan(clock);
      expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
        { event: "stripe_read_failed", from_status: "awaiting_stripe", to_status: "awaiting_stripe" },
      ]);
      expect((await eventsOf(suite.sql, opId)).at(-1)!.detail).toMatchObject({ message: fail.message });
    },
  );
});
