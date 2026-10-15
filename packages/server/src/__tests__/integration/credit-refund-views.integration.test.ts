// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two views migration 0094 defines (inner#1410 v9 §5.3), read on real
 * Postgres for every combination that decides membership.
 *
 * `credit_refunds_unresolved_failed` — one row per unresolved failed refund:
 * a copy `failed` or `canceled`, `resolved_by_operation_id` empty, whose lot
 * is `refund_pending` or `refunding`, or `refunded` and the copy
 * `ever_succeeded`. Columns: lot_id, payment_id, stripe_refund_id,
 * amount_cents, currency, status.
 *
 * `credit_lot_refund_failures` — one row per lot on the "refund failed"
 * list: a lot with a row in the first view; or a `refunding` lot with no
 * disposition in flight that has ever had a disposition with
 * `attention_reason = 'stripe_declined'` (Stripe refused before any refund
 * existed, so there is no copy to list).
 */

import { describe, expect, it } from "vitest";
import {
  inFailureList,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  unresolvedViewOf,
  useRefundSuite,
  type LotState,
  type RefundStatus,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useRefundSuite("credit-refund-views-test");

/**
 * A lot with one copy on it.
 * @param state - The lot's lifecycle.
 * @param copy - The copy's status, memory and whether it was answered for.
 * @param copy.status - Stripe's status.
 * @param copy.everSucceeded - Whether it once succeeded.
 * @param copy.resolved - Whether a disposition answered for it.
 * @returns The lot and the refund id.
 */
async function lotWithCopy(
  state: LotState,
  copy: { status: RefundStatus; everSucceeded: boolean; resolved?: boolean },
): Promise<{ lot: SeededLot; refundId: string }> {
  const lot = await seedRefundLot(suite.sql, state);
  const resolver = copy.resolved
    ? (await seedOperation(suite.sql, lot, { kind: "resolve_outside", status: "succeeded", result: "resolved_outside", createdSecondsAgo: 900 })).id
    : null;
  const refundId = reId("view");
  await seedCopy(suite.sql, lot, { id: refundId, amountCents: 300, status: copy.status, everSucceeded: copy.everSucceeded, resolvedBy: resolver });
  return { lot, refundId };
}

describe("credit_refunds_unresolved_failed", () => {
  const cases: [LotState, RefundStatus, boolean, boolean, boolean][] = [
    // lot, status, ever_succeeded, resolved, listed
    ["refunded", "failed", true, false, true],
    ["refunded", "canceled", true, false, true],
    ["refunded", "failed", false, false, false],
    ["refunded", "canceled", false, false, false],
    ["refunded", "failed", true, true, false],
    ["refund_pending", "failed", false, false, true],
    ["refund_pending", "canceled", false, false, true],
    ["refund_pending", "failed", true, false, true],
    ["refund_pending", "failed", false, true, false],
    ["refunding", "failed", false, false, true],
    ["refunding", "canceled", true, false, true],
    ["refunding", "failed", true, true, false],
    ["active", "failed", true, false, false],
    ["active", "canceled", false, false, false],
    ["refunding", "succeeded", true, false, false],
    ["refunding", "pending", false, false, false],
    ["refund_pending", "requires_action", false, false, false],
    ["refunded", "succeeded", true, false, false],
  ];

  it.each(cases)(
    "a %s lot, a %s copy (ever_succeeded %s, resolved %s) → listed %s",
    async (state, status, everSucceeded, resolved, listed) => {
      const { lot, refundId } = await lotWithCopy(state, { status, everSucceeded, resolved });

      const rows = await unresolvedViewOf(suite.sql, lot.lotId);

      expect(rows).toEqual(
        listed
          ? [{ lot_id: lot.lotId, payment_id: lot.paymentId, stripe_refund_id: refundId, amount_cents: 300, currency: "usd", status }]
          : [],
      );
    },
  );

  it("a depleted lot lists nothing", async () => {
    const { lot } = await lotWithCopy("active", { status: "failed", everSucceeded: false });
    await suite.sql`UPDATE credit_lots SET lifecycle = 'depleted', remaining_credits = 0 WHERE id = ${lot.lotId}`;
    expect(await unresolvedViewOf(suite.sql, lot.lotId)).toEqual([]);
  });

  it("lists each copy of a lot on its own row and only that lot's", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    const a = reId("a");
    const b = reId("b");
    await seedCopy(suite.sql, lot, { id: a, amountCents: 100, status: "failed", everSucceeded: false });
    await seedCopy(suite.sql, lot, { id: b, amountCents: 200, status: "canceled", everSucceeded: false });
    const other = await seedRefundLot(suite.sql, "refunding");
    await seedCopy(suite.sql, other, { id: reId("other"), amountCents: 5, status: "failed", everSucceeded: false });

    expect((await unresolvedViewOf(suite.sql, lot.lotId)).map((r) => [r.stripe_refund_id, r.amount_cents]).sort()).toEqual(
      [
        [a, 100],
        [b, 200],
      ].sort(),
    );
  });
});

describe("credit_lot_refund_failures", () => {
  it("a lot with an unresolved failed copy is in", async () => {
    const { lot } = await lotWithCopy("refund_pending", { status: "failed", everSucceeded: false });
    expect(await inFailureList(suite.sql, lot.lotId)).toBe(true);
  });

  it("a refunded lot whose refund failed after it once succeeded is in; one whose failed refund never succeeded is out", async () => {
    const once = await lotWithCopy("refunded", { status: "failed", everSucceeded: true });
    const never = await lotWithCopy("refunded", { status: "failed", everSucceeded: false });
    expect(await inFailureList(suite.sql, once.lot.lotId)).toBe(true);
    expect(await inFailureList(suite.sql, never.lot.lotId)).toBe(false);
  });

  it("a refunding lot Stripe declined with no refund copy at all is in", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined" });
    expect(await inFailureList(suite.sql, lot.lotId)).toBe(true);
  });

  it("a refunding lot declined once, whose later retry ran out of attempts, stays in (the history counts)", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined", createdSecondsAgo: 900 });
    await seedOperation(suite.sql, lot, { kind: "retry", status: "needs_attention", attentionReason: "attempts_exhausted", createdSecondsAgo: 60 });
    expect(await inFailureList(suite.sql, lot.lotId)).toBe(true);
  });

  it("a refunding lot that stopped on stripe_request_invalid is out", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_request_invalid" });
    expect(await inFailureList(suite.sql, lot.lotId)).toBe(false);
  });

  it.each(["started", "awaiting_stripe"] as const)(
    "a refunding lot declined once but with a retry %s is out while the retry is in flight",
    async (status) => {
      const lot = await seedRefundLot(suite.sql, "refunding");
      await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined", createdSecondsAgo: 900 });
      await seedOperation(suite.sql, lot, { kind: "retry", status, createdSecondsAgo: 60 });
      expect(await inFailureList(suite.sql, lot.lotId)).toBe(false);
    },
  );

  it("a lot declined once and since restored (active) is out", async () => {
    const lot = await seedRefundLot(suite.sql, "active");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined", createdSecondsAgo: 900 });
    await seedOperation(suite.sql, lot, { kind: "restore_credits", status: "succeeded", result: "restored", createdSecondsAgo: 60 });
    expect(await inFailureList(suite.sql, lot.lotId)).toBe(false);
  });

  it("a refunded lot declined once whose failed refunds are all answered for is out", async () => {
    const { lot } = await lotWithCopy("refunded", { status: "failed", everSucceeded: true, resolved: true });
    await seedOperation(suite.sql, lot, { kind: "retry", status: "needs_attention", attentionReason: "stripe_declined", createdSecondsAgo: 800 });
    expect(await inFailureList(suite.sql, lot.lotId)).toBe(false);
  });

  it.each(["active", "refund_pending", "refunding", "refunded"] as const)(
    "a %s lot with nothing failed and no decline is out",
    async (state) => {
      const lot = await seedRefundLot(suite.sql, state);
      expect(await inFailureList(suite.sql, lot.lotId)).toBe(false);
    },
  );

  it("a lot appears once however many failed copies it has", async () => {
    const lot = await seedRefundLot(suite.sql, "refunding");
    await seedOperation(suite.sql, lot, { kind: "approve", status: "needs_attention", attentionReason: "stripe_declined" });
    await seedCopy(suite.sql, lot, { id: reId("x"), amountCents: 1, status: "failed", everSucceeded: false });
    await seedCopy(suite.sql, lot, { id: reId("y"), amountCents: 2, status: "canceled", everSucceeded: false });
    const [row] = await suite.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_lot_refund_failures WHERE lot_id = ${lot.lotId}
    `;
    expect(row!.n).toBe(1);
  });
});
