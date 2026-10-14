// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund copies (inner#1410 §5.3, §6.4), on real Postgres.
 *
 * `applyRefundSnapshot(tx, paymentId, refunds)` is the one writer of
 * `credit_refunds`, called with whatever Stripe's `refunds.list` returned:
 *
 * - a refund not seen before is inserted verbatim; `operation_id` is the
 *   disposition named by `metadata.refund_operation_id` when that
 *   disposition exists, otherwise empty (an external refund);
 * - a refund seen before takes Stripe's status as given, unless its copy is
 *   already `failed` or `canceled`: those are final on Stripe, so a read
 *   taken earlier and delivered late never moves the copy out of them (v6
 *   §6.4);
 * - `ever_succeeded` turns true when a `succeeded` status is seen and never
 *   turns back, also when the status itself is not taken;
 * - `pending_reason` (v9 §5.1, §6.4) is Stripe's while the refund is
 *   `pending`, null in any other status, and stays null once the copy is
 *   `failed` or `canceled`; a change of reason alone is written;
 * - then, in the same transaction, a disposition of this payment that is
 *   `awaiting_stripe` is judged once more through `transitionOperation`
 *   (approve and retry, by the settle rule). Exactly one event row lands on
 *   it. No other disposition is touched.
 *
 * The unresolved failed refunds are read the way production reads them:
 * `listUnresolvedFailed(lotId, tx)`, which queries the view
 * `credit_refunds_unresolved_failed` in the caller's transaction (v9 §5.3).
 * A `refunded` lot lists the copies that once succeeded and are now `failed`
 * or `canceled`, unanswered; a `refund_pending` or `refunding` lot lists
 * every unanswered `failed` or `canceled` copy; any other lot lists none.
 * Every combination of both views is in `credit-refund-views.integration.test.ts`.
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
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import {
  applyRefundSnapshot,
  type StripeRefundObject,
} from "@server/modules/credit-refund/refund-snapshot.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";
import { listUnresolvedFailed } from "@server/modules/credit-refund/unresolved.repo.js";
import {
  bellsOf,
  copiesOf,
  inTx,
  ledgerOf,
  pendingReasonsOf,
  readLot,
  readOp,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  worldOf,
  type CopyRow,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import { expectBooked, newEventsOn } from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-snapshot-test");

/**
 * Apply one snapshot in its own committed transaction.
 * @param lot - Whose payment.
 * @param refunds - What Stripe listed.
 */
async function apply(lot: SeededLot, refunds: StripeRefundObject[]): Promise<void> {
  await inTx((tx) => applyRefundSnapshot(tx, lot.paymentId, refunds, "webhook"));
}

/**
 * The copy of one refund.
 * @param lot - The lot.
 * @param id - The refund.
 * @returns The row, or undefined.
 */
async function copyOf(lot: SeededLot, id: string): Promise<CopyRow | undefined> {
  return (await copiesOf(suite.sql, lot.lotId)).find((c) => c.stripe_refund_id === id);
}

describe("shapes", () => {
  it("applyRefundSnapshot and refundCopyRepo.listForPayment take the caller's transaction", () => {
    expectTypeOf(applyRefundSnapshot).parameter(0).toEqualTypeOf<DbTx>();
    expectTypeOf(applyRefundSnapshot).parameter(1).toEqualTypeOf<string>();
    expectTypeOf<ReturnType<typeof refundObject>[]>().toExtend<
      Parameters<typeof applyRefundSnapshot>[2]
    >();
    expectTypeOf(refundCopyRepo.listForPayment).parameter(1).toEqualTypeOf<DbTx>();
    expectTypeOf(refundCopyRepo.listForPayment).returns.resolves.toEqualTypeOf<RefundCopy[]>();
    expect(typeof applyRefundSnapshot).toBe("function");
  });
});

describe("applyRefundSnapshot: copies (R1, R2)", () => {
  it("inserts each new refund verbatim, tying it to the disposition its metadata names", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const op = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "refunded",
    });
    const own = reId("own");
    const external = reId("ext");
    const failedExt = reId("failed_ext");

    await apply(lot, [
      refundObject(own, "succeeded", 1080, op.id),
      refundObject(external, "pending", 120),
      refundObject(failedExt, "failed", 50),
    ]);

    expect(await copiesOf(suite.sql, lot.lotId)).toEqual(
      [
        {
          stripe_refund_id: own,
          payment_id: lot.paymentId,
          lot_id: lot.lotId,
          operation_id: op.id,
          amount_cents: 1080,
          currency: "usd",
          status: "succeeded",
          failure_reason: null,
          ever_succeeded: true,
          resolved_by_operation_id: null,
        },
        {
          stripe_refund_id: external,
          payment_id: lot.paymentId,
          lot_id: lot.lotId,
          operation_id: null,
          amount_cents: 120,
          currency: "usd",
          status: "pending",
          failure_reason: null,
          ever_succeeded: false,
          resolved_by_operation_id: null,
        },
        {
          stripe_refund_id: failedExt,
          payment_id: lot.paymentId,
          lot_id: lot.lotId,
          operation_id: null,
          amount_cents: 50,
          currency: "usd",
          status: "failed",
          failure_reason: "lost_or_stolen_card",
          ever_succeeded: false,
          resolved_by_operation_id: null,
        },
      ].sort((a, b) => a.stripe_refund_id.localeCompare(b.stripe_refund_id)),
    );
  });

  it("leaves operation_id empty when the metadata names a disposition that does not exist", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const id = reId("ghost");
    await apply(lot, [refundObject(id, "pending", 1080, randomUUID())]);
    expect((await copyOf(lot, id))!.operation_id).toBeNull();
  });

  it("takes each newer status; ever_succeeded turns true and never back; a failed copy stays failed", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const id = reId("flip");

    await apply(lot, [refundObject(id, "pending", 1080)]);
    expect(await copyOf(lot, id)).toMatchObject({ status: "pending", ever_succeeded: false });

    await apply(lot, [refundObject(id, "succeeded", 1080)]);
    expect(await copyOf(lot, id)).toMatchObject({ status: "succeeded", ever_succeeded: true });

    await apply(lot, [refundObject(id, "failed", 1080)]);
    expect(await copyOf(lot, id)).toMatchObject({
      status: "failed",
      failure_reason: "lost_or_stolen_card",
      ever_succeeded: true,
    });

    // An older snapshot delivered late moves neither the status nor the memory.
    await apply(lot, [refundObject(id, "pending", 1080)]);
    expect(await copyOf(lot, id)).toMatchObject({
      status: "failed",
      failure_reason: "lost_or_stolen_card",
      ever_succeeded: true,
    });
  });

  it("a canceled copy stays canceled whatever a late read says", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const id = reId("canceled");

    await apply(lot, [refundObject(id, "requires_action", 300)]);
    await apply(lot, [refundObject(id, "canceled", 300)]);
    await apply(lot, [refundObject(id, "requires_action", 300)]);
    await apply(lot, [refundObject(id, "succeeded", 300)]);

    expect(await copyOf(lot, id)).toMatchObject({ status: "canceled" });
  });

  it("a snapshot saying failed, then an older one saying succeeded: the copy stays failed (ever_succeeded true) and nothing is booked (finding [13])", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const own = reId("own_failed_first");
    const waiting = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    await seedCopy(suite.sql, lot, { id: own, amountCents: 1080, status: "pending", operationId: waiting.id });

    // The webhook's newer read commits first …
    await apply(lot, [refundObject(own, "failed", 1080, waiting.id)]);
    expect(await readOp(suite.sql, waiting.id)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
    });
    const before = await worldOf(suite.sql, lot);

    // … then a read taken before the failure is delivered.
    await apply(lot, [refundObject(own, "succeeded", 1080, waiting.id)]);

    expect(await copyOf(lot, own)).toMatchObject({ status: "failed", ever_succeeded: true });
    const after = await worldOf(suite.sql, lot);
    expect(after.lot).toEqual(before.lot);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.ops).toEqual(before.ops);
    expect(after.bells).toEqual(before.bells);
    expect(after.mails).toEqual(before.mails);
  });

  it("does not touch a copy the snapshot does not list, nor its resolution", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const resolver = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
    });
    const kept = reId("kept");
    await seedCopy(suite.sql, lot, {
      id: kept,
      amountCents: 1080,
      status: "failed",
      everSucceeded: true,
      resolvedBy: resolver.id,
    });
    const before = await copyOf(lot, kept);

    await apply(lot, [refundObject(reId("other"), "succeeded", 1)]);
    await apply(lot, [refundObject(kept, "failed", 1080)]);

    expect(await copyOf(lot, kept)).toEqual(before);
  });

  it("writes inside the caller's transaction: a rollback leaves no copy", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const id = reId("rolled_back");
    await expect(
      db.transaction(async (tx) => {
        await applyRefundSnapshot(tx, lot.paymentId, [refundObject(id, "succeeded", 1080)], "webhook");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await copyOf(lot, id)).toBeUndefined();
  });

  it("writes no event row and moves no disposition when none of this payment is awaiting Stripe", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const done = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "refunded",
    });
    const refundId = reId("done");
    await seedCopy(suite.sql, lot, {
      id: refundId,
      amountCents: 1080,
      status: "succeeded",
      operationId: done.id,
    });
    const before = await worldOf(suite.sql, lot);

    // The refund the lot was booked on fails later (#10).
    await apply(lot, [refundObject(refundId, "failed", 1080, done.id)]);

    const after = await worldOf(suite.sql, lot);
    expect(after.ops).toEqual(before.ops);
    expect(after.events).toEqual(before.events);
    expect(after.lot).toEqual(before.lot);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.bells).toEqual(before.bells);
    expect(after.mails).toEqual(before.mails);
    expect(await copyOf(lot, refundId)).toMatchObject({ status: "failed", ever_succeeded: true });
  });

  it("does not re-judge a started disposition (its executor owns it)", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const started = await seedOperation(suite.sql, lot, { kind: "approve", status: "started" });
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(reId("own"), "succeeded", 1080, started.id)]);

    const after = await worldOf(suite.sql, lot);
    expect(after.ops).toEqual(before.ops);
    expect(after.events).toEqual(before.events);
    expect(after.ledger).toEqual(before.ledger);
  });
});

describe("applyRefundSnapshot: re-judging an awaiting_stripe approve or retry (§6.4, §5.4)", () => {
  /**
   * A refunding lot whose approval waits on Stripe.
   * @param stripeRefundId - What it waits on; null after a 5xx.
   * @param confirmed - Refund ids confirmed on the confirmation page.
   * @returns The lot and the disposition.
   */
  async function waitingApprove(
    stripeRefundId: string | null,
    confirmed: string[] = [],
  ): Promise<{ lot: SeededLot; opId: string }> {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const op = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId,
      confirmedRefundIds: confirmed,
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    return { lot, opId: op.id };
  }

  it("books the lot when its refund succeeded and covers the payment: ledger, bell, mail, one event", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(own, "succeeded", 1080, opId)]);

    await expectBooked(suite.sql, lot, opId, {
      refundId: own,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "refund_succeeded", from_status: "awaiting_stripe", to_status: "succeeded" },
    ]);
  });

  it("after a 5xx, finds its refund by metadata, records the id and books", async () => {
    const { lot, opId } = await waitingApprove(null);
    const own = reId("found");

    await apply(lot, [refundObject(own, "succeeded", 1080, opId)]);

    await expectBooked(suite.sql, lot, opId, {
      refundId: own,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
    expect((await readOp(suite.sql, opId)).stripe_refund_id).toBe(own);
  });

  it("books when a confirmed external refund and its own refund together cover the payment", async () => {
    const external = reId("ext");
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own, [external]);

    await apply(lot, [
      refundObject(external, "succeeded", 300),
      refundObject(own, "succeeded", 780, opId),
    ]);

    await expectBooked(suite.sql, lot, opId, {
      refundId: own,
      settledCents: 1080,
      notify: true,
      amountCents: 1080,
    });
  });

  it("stays awaiting while another refund of the payment is still pending (E3)", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [
      refundObject(own, "succeeded", 1000, opId),
      refundObject(reId("ext_pending"), "pending", 80),
    ]);

    expect(await readOp(suite.sql, opId)).toMatchObject({ status: "awaiting_stripe", result: null });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await ledgerOf(suite.sql, lot.lotId)).toHaveLength(before.ledger.length);
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      {
        event: "refund_succeeded_others_pending",
        from_status: "awaiting_stripe",
        to_status: "awaiting_stripe",
      },
    ]);
  });

  it("stays awaiting while its own refund is still pending (E5)", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(own, "pending", 1080, opId)]);

    expect((await readOp(suite.sql, opId)).status).toBe("awaiting_stripe");
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "refund_pending", from_status: "awaiting_stripe", to_status: "awaiting_stripe" },
    ]);
  });

  it("needs attention (partial_refund) when its refund succeeded short of the payment (E4)", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);

    await apply(lot, [refundObject(own, "succeeded", 1000, opId)]);

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "partial_refund",
    });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await bellsOf(suite.sql, lot.userId)).toEqual([]);
  });

  it("needs attention (unexpected_external_refund) when an unconfirmed external refund succeeded (E4)", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own, []);

    await apply(lot, [
      refundObject(own, "succeeded", 780, opId),
      refundObject(reId("ext_new"), "succeeded", 300),
    ]);

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "unexpected_external_refund",
    });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(
      (await ledgerOf(suite.sql, lot.lotId)).filter((r) => r.entry_type === "refund"),
    ).toEqual([]);
  });

  it("needs attention (stripe_refund_failed_later) when its refund failed (E6), lot stays refunding", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(own, "failed", 1080, opId)]);

    expect(await readOp(suite.sql, opId)).toMatchObject({
      status: "needs_attention",
      attention_reason: "stripe_refund_failed_later",
    });
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "refund_declined", from_status: "awaiting_stripe", to_status: "needs_attention" },
    ]);
  });

  it("re-judges only its own payment's disposition", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    const bystander = await waitingApprove(reId("bystander"));
    const bystanderBefore = await worldOf(suite.sql, bystander.lot);

    await apply(lot, [refundObject(own, "succeeded", 1080, opId)]);

    expect((await readOp(suite.sql, opId)).status).toBe("succeeded");
    expect(await worldOf(suite.sql, bystander.lot)).toEqual(bystanderBefore);
  });

  it("booking answers for a refund that had already failed (§5.5)", async () => {
    const own = reId("own");
    const failedExt = reId("failed_ext");
    const { lot, opId } = await waitingApprove(own);

    await apply(lot, [refundObject(own, "succeeded", 1080, opId), refundObject(failedExt, "failed", 200)]);

    await expectBooked(suite.sql, lot, opId, { refundId: own, settledCents: 1080, notify: true, amountCents: 1080 });
    expect((await copyOf(lot, failedExt))!.resolved_by_operation_id).toBe(opId);
    expect((await copyOf(lot, own))!.resolved_by_operation_id).toBeNull();
    expect(await inTx((tx) => listUnresolvedFailed(lot.lotId, tx))).toEqual([]);
  });

  it("a list read before the refund it waits on existed: copies are written, the disposition is left as it was, no event", async () => {
    const own = reId("own_not_listed_yet");
    const { lot, opId } = await waitingApprove(own);
    const external = reId("ext");
    const opBefore = await readOp(suite.sql, opId);
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(external, "succeeded", 300)]);

    expect(await copyOf(lot, external)).toMatchObject({ status: "succeeded", ever_succeeded: true, operation_id: null });
    expect(await readOp(suite.sql, opId)).toEqual(opBefore);
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([]);
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
  });

  it("a lot no longer refunding (a hand edit): needs_attention state_mismatch, the lot untouched, the copies kept", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    await suite.sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lot.lotId}`;
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(own, "succeeded", 1080, opId)]);

    const op = await readOp(suite.sql, opId);
    expect(op).toMatchObject({ status: "needs_attention", attention_reason: "state_mismatch", result: null });
    expect(op.attention_detail).toContain("refund_pending");
    expect(await worldOf(suite.sql, lot).then((w) => [w.lot, w.ledger, w.bells, w.mails])).toEqual([
      before.lot,
      before.ledger,
      before.bells,
      before.mails,
    ]);
    expect(await copyOf(lot, own)).toMatchObject({ status: "succeeded", ever_succeeded: true, operation_id: opId });
    expect(await newEventsOn(suite.sql, lot, before, opId)).toEqual([
      { event: "refund_succeeded", from_status: "awaiting_stripe", to_status: "needs_attention" },
    ]);
  });

  it("does it in the caller's transaction: a rollback leaves the disposition waiting and the lot unbooked", async () => {
    const own = reId("own");
    const { lot, opId } = await waitingApprove(own);
    const before = await worldOf(suite.sql, lot);

    await expect(
      db.transaction(async (tx) => {
        await applyRefundSnapshot(tx, lot.paymentId, [refundObject(own, "succeeded", 1080, opId)], "webhook");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");

    expect(await worldOf(suite.sql, lot)).toEqual(before);
  });
});

describe("applyRefundSnapshot: pending_reason (v9 §5.1, §6.4)", () => {
  it("writes Stripe's pending_reason with a new pending refund, and null with any other status", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const waiting = reId("short_balance");
    const charge = reId("charge_pending");
    const done = reId("done");

    await apply(lot, [
      refundObject(waiting, "pending", 600, undefined, "insufficient_funds"),
      refundObject(charge, "pending", 200, undefined, "charge_pending"),
      refundObject(done, "succeeded", 280),
    ]);

    expect(await pendingReasonsOf(suite.sql, lot.lotId)).toEqual({
      [waiting]: "insufficient_funds",
      [charge]: "charge_pending",
      [done]: null,
    });
  });

  it("a change of reason alone is written: processing, then insufficient_funds, status still pending", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const id = reId("reason_moves");

    await apply(lot, [refundObject(id, "pending", 1080, undefined, "processing")]);
    expect((await pendingReasonsOf(suite.sql, lot.lotId))[id]).toBe("processing");

    await apply(lot, [refundObject(id, "pending", 1080, undefined, "insufficient_funds")]);

    expect((await pendingReasonsOf(suite.sql, lot.lotId))[id]).toBe("insufficient_funds");
    expect(await copyOf(lot, id)).toMatchObject({ status: "pending" });
  });

  it("is cleared when the refund leaves pending", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const id = reId("leaves_pending");

    await apply(lot, [refundObject(id, "pending", 1080, undefined, "insufficient_funds")]);
    await apply(lot, [refundObject(id, "succeeded", 1080)]);

    expect((await pendingReasonsOf(suite.sql, lot.lotId))[id]).toBeNull();
  });

  it("stays null once the copy is failed: an older read that says pending changes neither status nor reason", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const id = reId("frozen");

    await apply(lot, [refundObject(id, "pending", 1080, undefined, "insufficient_funds")]);
    await apply(lot, [refundObject(id, "failed", 1080)]);
    expect((await pendingReasonsOf(suite.sql, lot.lotId))[id]).toBeNull();

    await apply(lot, [refundObject(id, "pending", 1080, undefined, "insufficient_funds")]);

    expect(await copyOf(lot, id)).toMatchObject({ status: "failed" });
    expect((await pendingReasonsOf(suite.sql, lot.lotId))[id]).toBeNull();
  });

  it("an awaiting approval whose refund Stripe holds for insufficient_funds stays awaiting_stripe (E5), nothing booked", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const own = reId("held");
    const op = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
      attemptCount: 1,
    });
    const before = await worldOf(suite.sql, lot);

    await apply(lot, [refundObject(own, "pending", 1080, op.id, "insufficient_funds")]);

    expect(await readOp(suite.sql, op.id)).toMatchObject({ status: "awaiting_stripe", result: null, attention_reason: null });
    expect((await pendingReasonsOf(suite.sql, lot.lotId))[own]).toBe("insufficient_funds");
    expect((await readLot(suite.sql, lot.lotId)).lifecycle).toBe("refunding");
    expect(await newEventsOn(suite.sql, lot, before, op.id)).toEqual([
      { event: "refund_pending", from_status: "awaiting_stripe", to_status: "awaiting_stripe" },
    ]);
  });
});

describe("unresolved failed refunds, read as production reads them (v9 §5.3: the view)", () => {
  it("lists exactly the once-succeeded, now failed or canceled, unanswered refunds of a refunded lot", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const approve = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "succeeded",
      result: "refunded",
    });
    const resolver = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
    });
    const failedOwn = reId("a_failed_own");
    const canceledExt = reId("b_canceled_ext");
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
    // Each of these misses exactly one part of the definition.
    await seedCopy(suite.sql, lot, { id: reId("never"), amountCents: 5, status: "failed", everSucceeded: false });
    await seedCopy(suite.sql, lot, { id: reId("ok"), amountCents: 6, status: "succeeded" });
    await seedCopy(suite.sql, lot, { id: reId("again"), amountCents: 7, status: "requires_action", everSucceeded: true });
    await seedCopy(suite.sql, lot, {
      id: reId("answered"),
      amountCents: 8,
      status: "failed",
      everSucceeded: true,
      resolvedBy: resolver.id,
    });
    const other = await seedRefundLot(suite.sql, "refunded");
    await seedCopy(suite.sql, other, { id: reId("other_lot"), amountCents: 9, status: "failed", everSucceeded: true });

    const listed = await inTx((tx) => listUnresolvedFailed(lot.lotId, tx));

    expect(listed).toEqual([
      { stripeRefundId: failedOwn, amountCents: 880, status: "failed" },
      { stripeRefundId: canceledExt, amountCents: 200, status: "canceled" },
    ]);
  });

  it("lists nothing while the lot is active", async () => {
    const lot = await seedRefundLot(suite.sql, "active");
    await seedCopy(suite.sql, lot, {
      id: reId("failed"),
      amountCents: 1080,
      status: "failed",
      everSucceeded: true,
    });
    expect(await inTx((tx) => listUnresolvedFailed(lot.lotId, tx))).toEqual([]);
  });

  it.each(["refund_pending", "refunding"] as const)(
    "lists every unanswered failed or canceled refund while the lot is %s, succeeded once or not",
    async (state) => {
      const lot = await seedRefundLot(suite.sql, state);
      const resolver = await seedOperation(suite.sql, lot, {
        kind: "send_back",
        status: "succeeded",
        result: "sent_back",
      });
      const once = reId("a_once");
      const never = reId("b_never");
      const canceled = reId("c_canceled");
      await seedCopy(suite.sql, lot, { id: once, amountCents: 500, status: "failed", everSucceeded: true });
      await seedCopy(suite.sql, lot, { id: never, amountCents: 300, status: "failed", everSucceeded: false });
      await seedCopy(suite.sql, lot, { id: canceled, amountCents: 20, status: "canceled", everSucceeded: false });
      await seedCopy(suite.sql, lot, { id: reId("d_answered"), amountCents: 1, status: "failed", resolvedBy: resolver.id });
      await seedCopy(suite.sql, lot, { id: reId("e_ok"), amountCents: 2, status: "succeeded" });
      await seedCopy(suite.sql, lot, { id: reId("f_open"), amountCents: 3, status: "pending" });

      const listed = await inTx((tx) => listUnresolvedFailed(lot.lotId, tx));

      expect(listed.map((r) => r.stripeRefundId).sort()).toEqual([once, never, canceled].sort());
    },
  );

  it("sees the caller's uncommitted snapshot", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const id = reId("fresh");
    const seen = await inTx(async (tx) => {
      await applyRefundSnapshot(tx, lot.paymentId, [refundObject(id, "succeeded", 1080)], "webhook");
      await applyRefundSnapshot(tx, lot.paymentId, [refundObject(id, "failed", 1080)], "webhook");
      return listUnresolvedFailed(lot.lotId, tx);
    });
    expect(seen.map((r) => r.stripeRefundId)).toEqual([id]);
    expect(seen[0]!.amountCents).toBe(1080);
  });

  it("stops listing a refund once a disposition answers for it", async () => {
    const lot = await seedRefundLot(suite.sql, "refunded");
    const id = reId("answered_later");
    await seedCopy(suite.sql, lot, { id, amountCents: 1080, status: "failed", everSucceeded: true });
    expect((await inTx((tx) => listUnresolvedFailed(lot.lotId, tx))).map((r) => r.stripeRefundId)).toEqual([id]);

    const resolver = await seedOperation(suite.sql, lot, {
      kind: "resolve_outside",
      status: "succeeded",
      result: "resolved_outside",
    });
    await suite.sql`
      UPDATE credit_refunds SET resolved_by_operation_id = ${resolver.id} WHERE stripe_refund_id = ${id}
    `;
    expect(await inTx((tx) => listUnresolvedFailed(lot.lotId, tx))).toEqual([]);
  });
});
