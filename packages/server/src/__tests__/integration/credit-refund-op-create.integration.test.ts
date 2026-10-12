// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `transitionOperation` on the "(no row)" line of the disposition table
 * (inner#1410 §6.2), on real Postgres.
 *
 * `transitionOperation(tx, op, event)` is the one writer of
 * `credit_refund_operations` and its event rows (§9). `op` only names the
 * row — the function re-reads it under lock — and is null when there is no
 * row yet. E1 creates the row:
 *
 * | kind                                         | lands in            | lot                         |
 * |----------------------------------------------|---------------------|-----------------------------|
 * | approve                                      | started, with lease | refund_pending → refunding  |
 * | retry, refund_again                          | started, with lease | unchanged                   |
 * | reject                                       | succeeded/rejected  | refund_pending → active     |
 * | settle                                       | succeeded/refunded  | → refunded, booked (§5.5)   |
 * | send_back                                    | succeeded/sent_back | refunding → refund_pending  |
 * | resolve_outside                              | succeeded/resolved  | unchanged, copies resolved  |
 *
 * `notify` is fixed for five kinds (§5.1): approve, retry, reject always
 * true, send_back and resolve_outside always false; settle and refund_again
 * take the request's. A disposition that finishes `succeeded` closes every
 * open `needs_attention` of the same lot (E14) and of no other lot.
 *
 * Every other event with no row is impossible, except E14 which has
 * nothing to close and writes nothing.
 */

import { describe, it, expect, expectTypeOf, vi } from "vitest";

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
import type { DbTx } from "@breatic/core";
import {
  transitionOperation,
  ImpossibleTransitionError,
  type CreditRefundOperation,
  type NewOperation,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import {
  CREDITS,
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
  expectClosedBy,
  expectImpossible,
  newEventsOn,
  type EventType,
} from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-op-create-test");

/**
 * The E1 event for one kind on one lot.
 * @param lot - The lot.
 * @param kind - The disposition kind.
 * @param extra - Request fields beyond the common ones.
 * @returns The event.
 */
function e1(lot: SeededLot, kind: OpKind, extra: Partial<NewOperation> = {}): OperationEvent {
  return {
    type: "E1",
    create: {
      kind,
      lotId: lot.lotId,
      paymentId: lot.paymentId,
      idempotencyKey: `idem-${randomUUID()}`,
      requestHash: "a".repeat(64),
      requestedBy: "admin_7",
      reason: "buyer wrote in",
      ...extra,
    },
  };
}

describe("transitionOperation's shape (§9)", () => {
  it("takes the caller's transaction, a row reference or null, and an event", () => {
    expectTypeOf(transitionOperation).parameter(0).toEqualTypeOf<DbTx>();
    expectTypeOf<{ id: string }>().toExtend<Parameters<typeof transitionOperation>[1]>();
    expectTypeOf<null>().toExtend<Parameters<typeof transitionOperation>[1]>();
    expectTypeOf<OperationEvent>().toEqualTypeOf<Parameters<typeof transitionOperation>[2]>();
    expectTypeOf(transitionOperation).returns.resolves.toEqualTypeOf<CreditRefundOperation | null>();
    expect(typeof transitionOperation).toBe("function");
    expect(new ImpossibleTransitionError(null, "E7")).toBeInstanceOf(Error);
    expect(new ImpossibleTransitionError("started", "E10")).toMatchObject({
      from: "started",
      event: "E10",
    });
  });
});

describe("(no row) × every event but E1 and E14: impossible", () => {
  it.each<Exclude<EventType, "E1" | "E14">>([
    "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9",
    "E10", "E11", "E12", "E13", "E16", "E17",
  ])("(no row) × %s is refused and writes nothing", async (type) => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await expectImpossible(suite.sql, lot, null, null, eventOf(type));
  });

  it("(no row) × E15 — an answer carrying a lease — is refused and writes nothing", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await expectImpossible(suite.sql, lot, null, null, {
      type: "E2",
      refund: refundObject(reId("late"), "succeeded", 1080),
      leaseToken: randomUUID(),
    });
  });
});

describe("(no row) × E14: nothing to close", () => {
  it("answers null and writes nothing", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const before = await worldOf(suite.sql, lot);
    const returned = await inTx((tx) =>
      transitionOperation(tx, null, { type: "E14", closedBy: randomUUID() }),
    );
    expect(returned).toBeNull();
    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });
});

describe("(no row) × E1, approve → started (§5.2 phase 1)", () => {
  it("records the request, takes a lease, moves the lot to refunding, and appends `requested`", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);
    const idempotencyKey = `idem-${randomUUID()}`;
    const event = e1(lot, "approve", {
      idempotencyKey,
      confirmedRefundIds: ["re_ext_seen"],
      notify: false,
    });
    const { leaseSeconds } = getCreditRefundConfig();

    const before = await dbClockUs(suite.sql);
    const returned = await inTx((tx) => transitionOperation(tx, null, event));
    const after = await dbClockUs(suite.sql);

    expect(returned).not.toBeNull();
    expect(returned!.status).toBe("started");
    expect(returned!.kind).toBe("approve");
    expect(returned!.leaseToken).toMatch(/^[0-9a-f-]{36}$/);

    const op = await readOp(suite.sql, returned!.id);
    expect(op).toMatchObject({
      kind: "approve",
      status: "started",
      result: null,
      attention_reason: null,
      // Fixed for approve, whatever the request says.
      notify: true,
      confirmed_refund_ids: ["re_ext_seen"],
      idempotency_key: idempotencyKey,
      request_hash: "a".repeat(64),
      requested_by: "admin_7",
      reason: "buyer wrote in",
      attempt_count: 0,
      stripe_refund_id: null,
      lease_token: returned!.leaseToken,
      finished_at: null,
    });
    expect(op.locked_until_us!).toBeGreaterThanOrEqual(before + leaseSeconds * 1_000_000);
    expect(op.locked_until_us!).toBeLessThanOrEqual(after + leaseSeconds * 1_000_000);
    expect(op.next_attempt_us!).toBeGreaterThanOrEqual(before);
    expect(op.next_attempt_us!).toBeLessThanOrEqual(after);

    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refunding",
      remaining: `${CREDITS}.000000`,
      attempts: 0,
    });
    expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    expect(
      (await eventsOf(suite.sql, returned!.id)).map(({ event, from_status, to_status }) => ({
        event,
        from_status,
        to_status,
      })),
    ).toEqual([{ event: "requested", from_status: null, to_status: "started" }]);
  });
});

describe("(no row) × E1, retry → started", () => {
  it("leaves the refunding lot and the open needs_attention alone until it finishes", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "partial_refund",
      createdSecondsAgo: 60,
    });
    const before = await worldOf(suite.sql, lot);
    const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "retry", { confirmedRefundIds: [], notify: false })),
    );

    const op = await readOp(suite.sql, returned!.id);
    expect(op).toMatchObject({ kind: "retry", status: "started", notify: true, result: null });
    expect(op.lease_token).not.toBeNull();
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
    expect((await readOp(suite.sql, open.id)).attention_closed_at).toBeNull();
    expect(await newEventsOn(suite.sql, lot, before, open.id)).toEqual([]);
    expect(await newEventsOn(suite.sql, lot, before, returned!.id)).toEqual([
      { event: "requested", from_status: null, to_status: "started" },
    ]);
  });
});

describe("(no row) × E1, refund_again → started (§5.2)", () => {
  it.each([true, false])(
    "keeps the failed refunds and the amount, notify %s as asked, lot and ledger untouched",
    async (notify) => {
      const lot = await seedRefundLot(suite.sql, "refunded");
      const earlier = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "succeeded",
        result: "refunded",
        createdSecondsAgo: 600,
      });
      const failed = reId("failed");
      await seedCopy(suite.sql, lot, {
        id: failed,
        amountCents: 1080,
        status: "failed",
        everSucceeded: true,
        operationId: earlier.id,
      });
      const ledgerBefore = await ledgerOf(suite.sql, lot.lotId);
      const copiesBefore = await copiesOf(suite.sql, lot.lotId);

      const returned = await inTx((tx) =>
        transitionOperation(
          tx,
          null,
          e1(lot, "refund_again", { failedRefundIds: [failed], refundAmountCents: 1080, notify }),
        ),
      );

      const op = await readOp(suite.sql, returned!.id);
      expect(op).toMatchObject({
        kind: "refund_again",
        status: "started",
        notify,
        failed_refund_ids: [failed],
        refund_amount_cents: 1080,
      });
      expect(op.lease_token).not.toBeNull();
      expect(await readLot(suite.sql, lot.lotId)).toEqual({
        lifecycle: "refunded",
        remaining: "0.000000",
        attempts: 0,
      });
      expect(await ledgerOf(suite.sql, lot.lotId)).toEqual(ledgerBefore);
      expect(await copiesOf(suite.sql, lot.lotId)).toEqual(copiesBefore);
    },
  );
});

describe("(no row) × E1, reject → succeeded/rejected (§5.3, §8)", () => {
  it("returns the lot to active, writes the zero row, the rejected bell and the auto mail in one go", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "reject", { notify: false })),
    );

    expect(returned).toMatchObject({ status: "succeeded", result: "rejected" });
    const op = await readOp(suite.sql, returned!.id);
    expect(op).toMatchObject({
      status: "succeeded",
      result: "rejected",
      notify: true,
      lease_token: null,
    });
    expect(op.finished_at).not.toBeNull();
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "active",
      remaining: `${CREDITS}.000000`,
      attempts: 1,
    });
    expect(
      (await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund_rejected"),
    ).toEqual([{ entry_type: "refund_rejected", amount: "0.000000", reference_id: returned!.id }]);

    const bells = await bellsOf(suite.sql, lot.userId);
    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({
      type: "credit.refund_rejected",
      expires_at: null,
      project_id: null,
    });
    expect(Object.keys(bells[0]!.payload).sort()).toEqual(["credits", "lotId"]);
    expect(bells[0]!.payload.lotId).toBe(lot.lotId);
    expect(Number(bells[0]!.payload.credits)).toBe(CREDITS);

    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([
      autoMail(returned!.id, "refund_rejected"),
    ]);
    expect(
      (await eventsOf(suite.sql, returned!.id)).map(({ event, from_status, to_status }) => ({
        event,
        from_status,
        to_status,
      })),
    ).toEqual([{ event: "requested", from_status: null, to_status: "succeeded" }]);
  });
});

describe("(no row) × E1, settle → succeeded/refunded (§5.3, §5.5)", () => {
  it("books a refunding lot on the product's own refund, tells the buyer, and closes the open needs_attention", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_result_unknown",
      createdSecondsAgo: 60,
    });
    const own = reId("own");
    await seedCopy(suite.sql, lot, {
      id: own,
      amountCents: 1080,
      status: "succeeded",
      operationId: open.id,
    });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(
        tx,
        null,
        e1(lot, "settle", { notify: true, confirmedSucceededCents: 1080 }),
      ),
    );

    await expectBooked(suite.sql, lot, returned!.id, {
      refundId: own,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
    expect((await readOp(suite.sql, returned!.id)).confirmed_succeeded_cents).toBe(1080);
    await expectClosedBy(suite.sql, lot, before, open.id, returned!.id);
    expect(await newEventsOn(suite.sql, lot, before, returned!.id)).toEqual([
      { event: "requested", from_status: null, to_status: "succeeded" },
    ]);
  });

  it("books a refund_pending lot on the largest external refund when none is the product's, silent when notify is false", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const small = reId("small");
    const big = reId("big");
    await seedCopy(suite.sql, lot, { id: small, amountCents: 300, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: big, amountCents: 780, status: "succeeded" });

    const returned = await inTx((tx) =>
      transitionOperation(
        tx,
        null,
        e1(lot, "settle", { notify: false, confirmedSucceededCents: 1080 }),
      ),
    );

    await expectBooked(suite.sql, lot, returned!.id, {
      refundId: big,
      settledCents: 1080,
      notify: false,
      amountCents: 1080,
    });
    expect((await readOp(suite.sql, returned!.id)).notify).toBe(false);
  });

  it("prefers the product's own succeeded refund over a larger external one", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const sentBack = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "sent_back",
      createdSecondsAgo: 120,
    });
    const own = reId("own_small");
    const external = reId("ext_large");
    await seedCopy(suite.sql, lot, {
      id: own,
      amountCents: 500,
      status: "succeeded",
      operationId: sentBack.id,
    });
    await seedCopy(suite.sql, lot, { id: external, amountCents: 580, status: "succeeded" });

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "settle", { notify: false, confirmedSucceededCents: 1080 })),
    );

    const refunds = (await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund");
    expect(refunds).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: own },
    ]);
    expect((await readOp(suite.sql, returned!.id)).settled_succeeded_cents).toBe(1080);
  });

  it("records a partial settlement's succeeded sum, and still takes every credit off", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const partial = reId("partial");
    await seedCopy(suite.sql, lot, { id: partial, amountCents: 500, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: reId("gone"), amountCents: 580, status: "failed" });

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "settle", { notify: true, confirmedSucceededCents: 500 })),
    );

    await expectBooked(suite.sql, lot, returned!.id, {
      refundId: partial,
      settledCents: 500,
      notify: true,
      amountCents: 500,
    });
  });
});

describe("(no row) × E1, send_back → succeeded/sent_back (§5.3)", () => {
  it("returns the lot to refund_pending, tells nobody, and closes the open needs_attention", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "attempts_exhausted",
      createdSecondsAgo: 60,
    });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "send_back", { notify: true })),
    );

    const op = await readOp(suite.sql, returned!.id);
    expect(op).toMatchObject({ status: "succeeded", result: "sent_back", notify: false });
    expect(op.finished_at).not.toBeNull();
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refund_pending",
      remaining: `${CREDITS}.000000`,
      attempts: 0,
    });
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    await expectClosedBy(suite.sql, lot, before, open.id, returned!.id);
  });
});

describe("(no row) × E1, resolve_outside → succeeded/resolved_outside (§5.3)", () => {
  it("marks exactly the named failed refunds resolved, leaves lot and ledger, tells nobody, closes refund_again's attention", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "refunded",
      createdSecondsAgo: 600,
    });
    const failedOwn = reId("failed_own");
    const canceledExt = reId("canceled_ext");
    const untouched = reId("succeeded_ext");
    await seedCopy(suite.sql, lot, {
      id: failedOwn,
      amountCents: 880,
      status: "failed",
      everSucceeded: true,
      operationId: approve.id,
    });
    await seedCopy(suite.sql, lot, {
      id: canceledExt,
      amountCents: 200,
      status: "canceled",
      everSucceeded: true,
    });
    await seedCopy(suite.sql, lot, { id: untouched, amountCents: 1, status: "succeeded" });
    const declined = await seedOperation(suite.sql, lot, {
      kind: "refund_again",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      failedRefundIds: [failedOwn, canceledExt],
      refundAmountCents: 1080,
      createdSecondsAgo: 60,
    });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(
        tx,
        null,
        e1(lot, "resolve_outside", { failedRefundIds: [failedOwn, canceledExt], notify: true }),
      ),
    );

    const op = await readOp(suite.sql, returned!.id);
    expect(op).toMatchObject({
      status: "succeeded",
      result: "resolved_outside",
      notify: false,
      failed_refund_ids: [failedOwn, canceledExt],
    });
    const byId = new Map((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c]));
    expect(byId.get(failedOwn)!.resolved_by_operation_id).toBe(returned!.id);
    expect(byId.get(canceledExt)!.resolved_by_operation_id).toBe(returned!.id);
    expect(byId.get(untouched)!.resolved_by_operation_id).toBeNull();
    expect(await readLot(suite.sql, lot.lotId)).toEqual({
      lifecycle: "refunded",
      remaining: "0.000000",
      attempts: 0,
    });
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    await expectClosedBy(suite.sql, lot, before, declined.id, returned!.id);
  });
});

describe("E14 reach: a finishing disposition closes its own lot's open needs_attention only", () => {
  it("leaves another lot's open needs_attention and an already closed one on this lot untouched", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const other = await seedRefundLot(suite.sql, "refunding");
    const otherOpen = await seedOperation(suite.sql, other, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "partial_refund",
    });
    const closedEarlier = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "partial_refund",
      createdSecondsAgo: 900,
    });
    const closer = await seedOperation(suite.sql, lot, {
      kind: "send_back",
      status: "succeeded",
      result: "sent_back",
      createdSecondsAgo: 800,
    });
    await suite.sql`
      UPDATE credit_refund_operations
      SET attention_closed_at = now() - interval '800 seconds', attention_closed_by = ${closer.id}
      WHERE id = ${closedEarlier.id}
    `;
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "unexpected_external_refund",
      createdSecondsAgo: 60,
    });
    const earlierBefore = await readOp(suite.sql, closedEarlier.id);
    const otherWorld = await worldOf(suite.sql, other);
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) => transitionOperation(tx, null, e1(lot, "send_back")));

    await expectClosedBy(suite.sql, lot, before, open.id, returned!.id);
    expect(await readOp(suite.sql, closedEarlier.id)).toEqual(earlierBefore);
    expect(await newEventsOn(suite.sql, lot, before, closedEarlier.id)).toEqual([]);
    expect(await newEventsOn(suite.sql, lot, before, closer.id)).toEqual([]);
    expect(await worldOf(suite.sql, other)).toEqual(otherWorld);
    expect((await readOp(suite.sql, otherOpen.id)).attention_closed_at).toBeNull();
  });
});

describe("E1 while another disposition is in flight (§5.1 one-in-flight)", () => {
  it("is refused by the database and leaves no trace once the transaction is gone", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
    const before = await worldOf(suite.sql, lot);

    await expect(
      inTx((tx) => transitionOperation(tx, null, e1(lot, "retry", { confirmedRefundIds: [] }))),
    ).rejects.toThrow();

    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });
});
