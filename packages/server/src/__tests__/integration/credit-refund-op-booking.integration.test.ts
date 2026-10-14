// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The money rules of booking a lot (inner#1410 §5.3, §5.5, §6.1), at
 * `transitionOperation`, on real Postgres.
 *
 * 1. Booking answers for the refunds that had already failed. Every booking
 *    — approve and retry E2, settle, resolve_outside on a lot not yet
 *    refunded — writes `resolved_by_operation_id` = the booking disposition
 *    on every copy that is `failed` or `canceled` and unanswered at that
 *    moment: the operator booked on Stripe's state as it then stood. A copy
 *    some disposition already answered for keeps its first answer. So after
 *    booking, only refunds that fail later are unresolved.
 * 2. resolve_outside on a `refund_pending` or `refunding` lot books it:
 *    `refunded`, nothing left, one `refund` ledger row of minus what was
 *    left, referencing the largest succeeded refund, or the disposition
 *    itself when none succeeded; `succeeded/resolved_outside` with
 *    `settled_succeeded_cents` = the succeeded sum; nobody is told; the open
 *    needs_attention is closed.
 * 3. state_mismatch: when approve or retry would book (E2) a lot that is no
 *    longer `refunding` — only a hand edit of the row does that — the
 *    disposition turns `needs_attention/state_mismatch`, `attention_detail`
 *    names the state found, the lot is not touched, one event row is
 *    appended, and the transaction commits instead of throwing. E6 never
 *    reads the lot (v9 §6.2) and is covered in the `started` suite.
 *
 * The unresolved failed refunds are read from the view
 * `credit_refunds_unresolved_failed` (v9 §5.3), the one definition.
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
import {
  transitionOperation,
  type NewOperation,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import {
  CREDITS,
  EVENT_NAME,
  PAID_CENTS,
  bellsOf,
  copiesOf,
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
  unresolvedViewOf,
  useRefundSuite,
  worldOf,
  type LotState,
  type OpKind,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import { expectBooked, expectClosedBy, newEventsOn } from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-op-booking-test");

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
      requestHash: "c".repeat(64),
      requestedBy: "admin_7",
      reason: "booking rule",
      ...extra,
    },
    actor: "request",
  };
}

/**
 * `resolved_by_operation_id` of each copy of the lot.
 * @param lot - The lot.
 * @returns Refund id → resolver.
 */
async function resolvers(lot: SeededLot): Promise<Map<string, string | null>> {
  return new Map((await copiesOf(suite.sql, lot.lotId)).map((c) => [c.stripe_refund_id, c.resolved_by_operation_id]));
}

/**
 * The unresolved failed refunds of a lot, read from the view production
 * reads (v9 §5.3).
 * @param lot - The lot.
 * @returns Their ids, sorted.
 */
async function unresolvedIds(lot: SeededLot): Promise<string[]> {
  return (await unresolvedViewOf(suite.sql, lot.lotId)).map((r) => r.stripe_refund_id).sort();
}

describe("booking answers for the refunds that had already failed (§5.5)", () => {
  it("approve × E2 under started: every failed or canceled copy unanswered at booking is resolved by the approval", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
    const earlier = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      createdSecondsAgo: 900,
    });
    const own = reId("own");
    const failedExt = reId("failed_ext");
    const canceledExt = reId("canceled_ext");
    const answered = reId("answered");
    await seedCopy(suite.sql, lot, { id: own, amountCents: 1080, status: "succeeded", operationId: approve.id });
    await seedCopy(suite.sql, lot, { id: failedExt, amountCents: 200, status: "failed", everSucceeded: false });
    await seedCopy(suite.sql, lot, { id: canceledExt, amountCents: 50, status: "canceled" });
    await seedCopy(suite.sql, lot, { id: answered, amountCents: 30, status: "failed", everSucceeded: true, resolvedBy: earlier.id });

    await inTx((tx) =>
      transitionOperation(tx, { id: approve.id }, {
        type: "E2",
        refund: refundObject(own, "succeeded", 1080, approve.id),
        leaseToken: approve.leaseToken!,
        actor: "loop",
      }),
    );

    await expectBooked(suite.sql, lot, approve.id, { refundId: own, settledCents: 1080, notify: true, amountCents: 1080 });
    const by = await resolvers(lot);
    expect(by.get(failedExt)).toBe(approve.id);
    expect(by.get(canceledExt)).toBe(approve.id);
    expect(by.get(answered)).toBe(earlier.id);
    expect(by.get(own)).toBeNull();
    expect(await unresolvedIds(lot)).toEqual([]);
  });

  it("retry × E2 under awaiting_stripe: the approval's refund that failed before is resolved by the retry", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const approve = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_refund_failed_later",
      createdSecondsAgo: 600,
    });
    const approveRefund = reId("approve_failed");
    const external = reId("ext");
    const retryRefund = reId("retry_own");
    const retry = await seedOperation(suite.sql, lot, {
      kind: "retry",
      status: "awaiting_stripe",
      stripeRefundId: retryRefund,
      confirmedRefundIds: [external],
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    await seedCopy(suite.sql, lot, { id: approveRefund, amountCents: 500, status: "failed", everSucceeded: true, operationId: approve.id });
    await seedCopy(suite.sql, lot, { id: external, amountCents: 300, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: retryRefund, amountCents: 780, status: "succeeded", operationId: retry.id });

    await inTx((tx) =>
      transitionOperation(tx, { id: retry.id }, { type: "E2", refund: refundObject(retryRefund, "succeeded", 780, retry.id), actor: "loop" }),
    );

    await expectBooked(suite.sql, lot, retry.id, { refundId: retryRefund, settledCents: 1080, notify: true, amountCents: 1080 });
    expect((await resolvers(lot)).get(approveRefund)).toBe(retry.id);
    expect(await unresolvedIds(lot)).toEqual([]);
  });

  it("settle: the refund that failed before booking is resolved by the settle and is not offered again", async () => {
    // The approval's refund succeeded, then failed; an external refund of
    // the whole payment succeeded; the operator settles on it.
    const lot = await seedRefundLot(suite.sql, "refunding");
    const approve = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_refund_failed_later",
      createdSecondsAgo: 600,
    });
    const earlier = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      createdSecondsAgo: 900,
    });
    const approveRefund = reId("approve_failed");
    const external = reId("ext_partial");
    const answered = reId("answered");
    await seedCopy(suite.sql, lot, { id: approveRefund, amountCents: 680, status: "failed", everSucceeded: true, operationId: approve.id });
    await seedCopy(suite.sql, lot, { id: external, amountCents: PAID_CENTS, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: answered, amountCents: 1, status: "canceled", everSucceeded: true, resolvedBy: earlier.id });
    const before = await worldOf(suite.sql, lot);

    const settled = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "settle", { notify: false, confirmedSucceededCents: PAID_CENTS })),
    );

    await expectBooked(suite.sql, lot, settled!.id, { refundId: external, settledCents: PAID_CENTS, notify: false, amountCents: PAID_CENTS });
    const by = await resolvers(lot);
    expect(by.get(approveRefund)).toBe(settled!.id);
    expect(by.get(answered)).toBe(earlier.id);
    expect(by.get(external)).toBeNull();
    expect(await unresolvedIds(lot)).toEqual([]);
    await expectClosedBy(suite.sql, lot, before, approve.id, settled!.id);
  });
});

describe("resolve_outside books a lot that is not yet refunded (§5.3, §5.5)", () => {
  it("a refunding lot whose refund failed: booked on the disposition itself, the failed refund answered for, the attention closed, nobody told", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const approve = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_refund_failed_later",
      createdSecondsAgo: 120,
    });
    const failed = reId("failed_own");
    await seedCopy(suite.sql, lot, { id: failed, amountCents: 1080, status: "failed", everSucceeded: true, operationId: approve.id });
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "resolve_outside", { failedRefundIds: [failed], notify: true })),
    );

    const opId = returned!.id;
    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
      notify: false,
      settled_succeeded_cents: 0,
      failed_refund_ids: [failed],
    });
    expect(op.finished_at).not.toBeNull();
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: opId },
    ]);
    expect((await resolvers(lot)).get(failed)).toBe(opId);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
    await expectClosedBy(suite.sql, lot, before, approve.id, opId);
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "requested", from_status: null, to_status: "succeeded" },
    ]);
    expect(await unresolvedIds(lot)).toEqual([]);
  });

  it("a refund_pending lot partly refunded outside: booked on the largest succeeded refund, with the succeeded sum", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const small = reId("small");
    const big = reId("big");
    const failed = reId("failed_never");
    await seedCopy(suite.sql, lot, { id: small, amountCents: 300, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: big, amountCents: 500, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: failed, amountCents: 280, status: "failed", everSucceeded: false });

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "resolve_outside", { failedRefundIds: [failed] })),
    );

    const opId = returned!.id;
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "succeeded",
      result: "resolved_outside",
      settled_succeeded_cents: 800,
    });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: big },
    ]);
    const by = await resolvers(lot);
    expect(by.get(failed)).toBe(opId);
    expect(by.get(big)).toBeNull();
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("a refund_pending lot with nothing on Stripe: booked on the disposition itself, succeeded sum 0", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");

    const returned = await inTx((tx) =>
      transitionOperation(tx, null, e1(lot, "resolve_outside", { failedRefundIds: [] })),
    );

    const opId = returned!.id;
    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "succeeded",
      result: "resolved_outside",
      settled_succeeded_cents: 0,
    });
    expect(await readLot(suite.sql, lot.lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", attempts: 0 });
    expect((await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund")).toEqual([
      { entry_type: "refund", amount: `-${CREDITS}.000000`, reference_id: opId },
    ]);
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
    expect(await mailsOf(suite.sql, lot.lotId)).toEqual([]);
  });
});

describe("state_mismatch: approve or retry booking a lot that is not refunding (§5.5, §6.1)", () => {
  interface MismatchCase {
    kind: "approve" | "retry";
    status: "started" | "awaiting_stripe";
    type: "E2";
    lifecycle: Exclude<LotState, "refunding">;
  }
  const cases: MismatchCase[] = [
    { kind: "approve", status: "started", type: "E2", lifecycle: "refund_pending" },
    { kind: "approve", status: "started", type: "E2", lifecycle: "refunded" },
    { kind: "retry", status: "started", type: "E2", lifecycle: "active" },
    { kind: "approve", status: "awaiting_stripe", type: "E2", lifecycle: "refunded" },
    { kind: "retry", status: "awaiting_stripe", type: "E2", lifecycle: "refund_pending" },
  ];

  it.each(cases)(
    "$kind $status × $type on a $lifecycle lot → needs_attention state_mismatch, lot untouched, one event, committed",
    async ({ kind, status, type, lifecycle }) => {
      const lot = await seedRefundLot(suite.sql, lifecycle);
      const own = reId("own");
      const seeded = await seedOperation(suite.sql, lot, {
        kind,
        status,
        stripeRefundId: status === "awaiting_stripe" ? own : null,
        firstCalledHoursAgo: 1,
        attemptCount: 1,
      });
      await seedCopy(suite.sql, lot, { id: own, amountCents: 1080, status: "succeeded", operationId: seeded.id });
      const before = await worldOf(suite.sql, lot);
      const lease = seeded.leaseToken ? { leaseToken: seeded.leaseToken } : {};
      const event: OperationEvent = { type, refund: refundObject(own, "succeeded", 1080, seeded.id), ...lease, actor: "loop" };

      const returned = await inTx((tx) => transitionOperation(tx, { id: seeded.id }, event));

      expect(returned).toMatchObject({ id: seeded.id, status: "needs_attention", attentionReason: "state_mismatch" });
      const op = await readOp(suite.sql, seeded.id);
      expect(op).toMatchObject({ status: "needs_attention", attention_reason: "state_mismatch", result: null, lease_token: null });
      expect(op.attention_detail).toContain(lifecycle);
      expect(op.finished_at).not.toBeNull();
      const after = await worldOf(suite.sql, lot);
      expect(after.lot).toEqual(before.lot);
      expect(after.ledger).toEqual(before.ledger);
      expect(after.copies).toEqual(before.copies);
      expect(after.bells).toEqual(before.bells);
      expect(after.mails).toEqual(before.mails);
      expect(await newEventsOn(suite.sql, lot, before, seeded.id)).toEqual([
        { event: EVENT_NAME[type], from_status: status, to_status: "needs_attention" },
      ]);
    },
  );
});
