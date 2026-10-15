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
 * | retry                                        | started, with lease | unchanged                   |
 * | reject                                       | succeeded/rejected  | refund_pending → active     |
 * | settle                                       | succeeded/refunded  | → refunded, booked (§5.5)   |
 * | send_back                                    | succeeded/sent_back | refunding → refund_pending  |
 * | resolve_outside                              | succeeded/resolved  | refunded lot: unchanged, copies resolved; refund_pending / refunding: → refunded, booked (§5.5) |
 * | restore_credits (v9)                         | succeeded/restored  | refunded / refunding / refund_pending → active, refund_reversed row (§5.3, §6.3 L9) |
 *
 * `notify` is fixed for six kinds (§5.1): approve, retry, reject,
 * restore_credits always true, send_back and resolve_outside always false;
 * settle takes the request's. A disposition that finishes `succeeded` closes every
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
import { sql } from "drizzle-orm";
import { db, type DbTx } from "@breatic/core";
import { assessRefundCreate } from "@server/modules/credit-refund/assess.js";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
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
  PAID_CENTS,
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
  expectRestored,
  failure,
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
    actor: "request",
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
      actor: "loop",
    });
  });
});

describe("(no row) × E14: nothing to close", () => {
  it("answers null and writes nothing", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const before = await worldOf(suite.sql, lot);
    const returned = await inTx((tx) =>
      transitionOperation(tx, null, { type: "E14", closedBy: randomUUID(), actor: "request" }),
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

describe("(no row) × E1, restore_credits → succeeded/restored (v9 §5.3, §6.3 L9, §8)", () => {
  it("a refunded lot whose refund failed later: credits back by a refund_reversed row of the booked amount, the failed refund answered for, bell and auto mail, notify fixed true", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "refunded",
      createdSecondsAgo: 600,
    });
    const failed = reId("failed_later");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: 1080, status: "failed", everSucceeded: true, operationId: approve.id });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "restore_credits", { failedRefundIds: [failed], notify: false })),
    );

    expect(returned).toMatchObject({ status: "succeeded", result: "restored" });
    await expectRestored(suite.sql, lot, returned!.id, { wasBooked: true, resolved: [failed] });
    expect((await readOp(suite.sql, returned!.id)).failed_refund_ids).toEqual([failed]);
    expect(await newEventsOn(suite.sql, lot, before, returned!.id)).toEqual([
      { event: "requested", from_status: null, to_status: "succeeded" },
    ]);
  });

  it("a refunding lot Stripe declined (no copy): a zero refund_reversed row, the open needs_attention closed", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      createdSecondsAgo: 60,
    });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) => transitionOperation(tx, null, e1(lot, "restore_credits", { failedRefundIds: [] })));

    await expectRestored(suite.sql, lot, returned!.id, { wasBooked: false, resolved: [] });
    await expectClosedBy(suite.sql, lot, before, open.id, returned!.id);
  });

  it("a refund_pending lot with an unresolved failed refund: a zero refund_reversed row, the refund answered for, refund_attempts unchanged", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    await suite.sql`UPDATE credit_lots SET refund_attempts = 1 WHERE id = ${lot.lotId}`;
    const failed = reId("failed_ext");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: 1080, status: "failed", everSucceeded: false });

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "restore_credits", { failedRefundIds: [failed] })),
    );

    await expectRestored(suite.sql, lot, returned!.id, { wasBooked: false, resolved: [failed], attempts: 1 });
  });
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
  it("marks exactly the named failed refunds resolved, leaves lot and ledger, tells nobody, closes the open attention", async () => {
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
      kind: "retry",
      status: "needs_attention",
      attentionReason: "stripe_declined",
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

describe("(no row) × E1: a lot's dispositions are ordered as they were inserted under the lot lock (F12)", () => {
  it("a request whose transaction began first but inserted second is created after, listed after, and is the latest the retry table reads", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      createdSecondsAgo: 600,
    });

    // A: begins, fixes its now(), then waits while B (send_back) runs and
    // commits on another connection; only then does A take the lot lock and
    // insert its approval on the refund_pending lot B left.
    const [s, p] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT now()`);
      const sendBack = await inTx((other) => transitionOperation(other, null, e1(lot, "send_back")));
      const approve = await transitionOperation(tx, null, e1(lot, "approve"));
      return [sendBack!, approve!] as const;
    });

    const [order] = await suite.sql<{ later: boolean }[]>`
      SELECT (SELECT created_at FROM credit_refund_operations WHERE id = ${p.id})
           > (SELECT created_at FROM credit_refund_operations WHERE id = ${s.id}) AS later
    `;
    expect(order!.later).toBe(true);
    const listed = await inTx((tx) => operationRepo.listForLot(lot.lotId, tx));
    expect(listed.map((o) => o.id).filter((id) => id === s.id || id === p.id)).toEqual([s.id, p.id]);

    // Stripe refuses the approval: it needs attention and the lot stays refunding.
    await inTx((tx) =>
      transitionOperation(tx, { id: p.id }, {
        type: "E6",
        failure: failure(400, { type: "invalid_request_error" }),
        leaseToken: p.leaseToken!,
        actor: "loop",
      }),
    );
    expect(await readOp(suite.sql, p.id)).toMatchObject({ status: "needs_attention", attention_closed_at: null });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");

    // The retry table reads the lot's latest disposition: the open approval, not the send-back.
    const ops = await inTx((tx) => operationRepo.listForLot(lot.lotId, tx));
    expect(
      assessRefundCreate({
        kind: "retry",
        lot: { lifecycle: "refunding", remainingCredits: CREDITS, ledgerSum: CREDITS },
        payment: { status: "completed", stripePaymentIntentId: lot.paymentIntentId, paidCents: PAID_CENTS },
        ops,
        refunds: [],
        confirmedRefundIds: [],
      }),
    ).toEqual({ outcome: "create_refund", amountCents: PAID_CENTS });
  });
});

/**
 * Run work in one committed transaction that has already been open a while,
 * so its now() is visibly earlier than the wall clock at the work.
 * @param run - The work.
 * @returns What it returned.
 */
async function afterAWait<T>(run: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_sleep(0.05)`);
    return run(tx);
  });
}

/**
 * How far one disposition's later stamps sit past its own created_at, in
 * microseconds; null where the stamp is unset.
 * @param id - The disposition.
 * @returns finished_at and updated_at minus created_at.
 */
async function stampsPastCreated(id: string): Promise<{ finished: number | null; updated: number }> {
  const [row] = await suite.sql<{ finished: string | null; updated: string }[]>`
    SELECT (extract(epoch FROM finished_at - created_at) * 1000000)::bigint::text AS finished,
           (extract(epoch FROM updated_at - created_at) * 1000000)::bigint::text AS updated
    FROM credit_refund_operations WHERE id = ${id}
  `;
  return { finished: row!.finished === null ? null : Number(row!.finished), updated: Number(row!.updated) };
}

describe("(no row) × E1: a disposition's own stamps never run backwards (G1)", () => {
  it("a one-shot finished in a transaction that waited first: finished_at and updated_at are not before created_at", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");

    const returned = await afterAWait((tx) => transitionOperation(tx, null, e1(lot, "reject")));

    const stamps = await stampsPastCreated(returned!.id);
    expect(stamps.finished!).toBeGreaterThanOrEqual(0);
    expect(stamps.updated).toBeGreaterThanOrEqual(0);
  });

  it("an approve inserted after a wait: updated_at is not before created_at, then or after a later event moves it", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");

    const approve = await afterAWait((tx) => transitionOperation(tx, null, e1(lot, "approve")));
    expect((await stampsPastCreated(approve!.id)).updated).toBeGreaterThanOrEqual(0);

    await inTx((tx) =>
      transitionOperation(tx, { id: approve!.id }, {
        type: "E6",
        failure: failure(400, { type: "invalid_request_error" }),
        leaseToken: approve!.leaseToken!,
        actor: "loop",
      }),
    );
    expect(await readOp(suite.sql, approve!.id)).toMatchObject({ status: "needs_attention" });
    expect((await stampsPastCreated(approve!.id)).updated).toBeGreaterThanOrEqual(0);
  });

  it("an open needs_attention closed by a one-shot that waited first: attention_closed_at is not before the closer's created_at", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_declined",
      createdSecondsAgo: 60,
    });

    const closer = await afterAWait((tx) =>
      transitionOperation(tx, null, e1(lot, "restore_credits", { failedRefundIds: [] })),
    );

    const [row] = await suite.sql<{ gap: string | null }[]>`
      SELECT (extract(epoch FROM o.attention_closed_at - c.created_at) * 1000000)::bigint::text AS gap
      FROM credit_refund_operations o, credit_refund_operations c
      WHERE o.id = ${open.id} AND c.id = ${closer!.id} AND o.attention_closed_by = c.id
    `;
    expect(row).toBeDefined();
    expect(Number(row!.gap)).toBeGreaterThanOrEqual(0);
  });

  it("a row inserted after its finisher's transaction began: the finish stamps finished_at and updated_at from the clock, not the transaction start (H5)", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");

    // T's now() is fixed at BEGIN (postgres-js runs begin before the callback);
    // the approve is inserted and committed on another connection after that,
    // so now() in T is before its created_at.
    const approveId = await db.transaction(async (tx) => {
      const approve = await inTx((other) => transitionOperation(other, null, e1(lot, "approve")));
      await transitionOperation(tx, { id: approve!.id }, {
        type: "E6",
        failure: failure(400, { type: "invalid_request_error" }),
        leaseToken: approve!.leaseToken!,
        actor: "loop",
      });
      return approve!.id;
    });

    expect(await readOp(suite.sql, approveId)).toMatchObject({ status: "needs_attention" });
    const stamps = await stampsPastCreated(approveId);
    expect(stamps.finished!).toBeGreaterThanOrEqual(0);
    expect(stamps.updated).toBeGreaterThanOrEqual(0);
  });

  describe("progress writes outside transitionOperation, with the app clock an hour behind the database (H1)", () => {
    const BEHIND_MS = 60 * 60 * 1000;

    /**
     * Run work with only `Date` faked an hour behind the real clock, so the
     * postgres driver's timers keep running; the clock is restored after.
     * @param run - The work.
     */
    async function withAppClockBehind(run: () => Promise<void>): Promise<void> {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - BEHIND_MS);
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    }

    /**
     * Assert updated_at did not run backwards past created_at or its earlier
     * value. Neither write touches created_at, so both are offsets from it.
     * @param id - The disposition.
     * @param before - updated_at past created_at, read just before the write.
     */
    async function expectUpdatedNotBackwards(id: string, before: number): Promise<void> {
      const after = (await stampsPastCreated(id)).updated;
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBeGreaterThanOrEqual(before);
    }

    it("markFirstCalled on a started approve holding its lease", async () => {
      const lot = await seedRefundLot(suite.sql, "refunding");
      const op = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
      const before = (await stampsPastCreated(op.id)).updated;

      await withAppClockBehind(async () => {
        expect(await operationRepo.markFirstCalled(op.id, op.leaseToken!, 1000)).toBe(true);
      });

      await expectUpdatedNotBackwards(op.id, before);
    });

    it("scheduleNextLook on an awaiting_stripe disposition", async () => {
      const lot = await seedRefundLot(suite.sql, "refunding");
      const op = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "awaiting_stripe",
        stripeRefundId: reId("waiting"),
        firstCalledHoursAgo: 1,
        attemptCount: 1,
      });
      const before = (await stampsPastCreated(op.id)).updated;

      await withAppClockBehind(() => inTx((tx) => operationRepo.scheduleNextLook(op.id, 60, tx)));

      expect((await readOp(suite.sql, op.id)).status).toBe("awaiting_stripe");
      await expectUpdatedNotBackwards(op.id, before);
    });
  });
});
