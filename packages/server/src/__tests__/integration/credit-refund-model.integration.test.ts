// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Random sequences of dispositions, Stripe answers and Stripe-side changes
 * on one lot, with the §9 invariants checked after every step (inner#1410),
 * on real Postgres.
 *
 * The harness plays three parts:
 *
 * - **the back office and the endpoints**: an E1 is only issued when the
 *   request would pass its preconditions (§5.2, §5.3) against Stripe's
 *   current state, and, as the endpoint does, it first hands Stripe's list
 *   to `applyRefundSnapshot` in the same transaction;
 * - **the executor and the loop**: a started disposition gets one of the
 *   §5.4 answers, classified here from the fake Stripe's state, and passed
 *   to `transitionOperation` with its lease; leases run out and old holders
 *   answer late; awaiting dispositions get looked up;
 * - **Stripe**: refunds are created at most once per disposition, change
 *   status on their own (including succeeded → failed), appear from outside
 *   the product, and every change is delivered as a snapshot (a webhook).
 *
 * After each step:
 *
 * 1. at most one `started` or `awaiting_stripe` disposition;
 * 2. a `refunding` lot has one in flight, or its latest disposition is an
 *    open `needs_attention`;
 * 3. at most one `refund` ledger row, present exactly when the lot is
 *    `refunded`; the balance equals the ledger sum; a `refunded` lot holds 0
 *    and gets no ledger row after it was booked;
 * 4. every approve / retry booked with a succeeded sum of at least what was
 *    paid; every settle too unless it was sent with `acceptPartial`;
 * 5. exactly one `auto` mail and one bell per disposition finished
 *    `rejected`, or `refunded` with notify, of the matching kinds; none for
 *    any other;
 * 6. the event rows grew by exactly the transitions taken: one per
 *    `transitionOperation` call, one per awaiting disposition re-judged by a
 *    snapshot, one per needs_attention closed; every disposition starts with
 *    one `requested` row from no status;
 * 7. `ever_succeeded` is true for every refund ever delivered as succeeded,
 *    and never turns back;
 * 8. a finished refund_again has resolved each refund it covered;
 * 9. an open refund_again needs_attention implies an unresolved failed
 *    refund; `unresolvedFailedRefunds` agrees with the §5.3 definition.
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
import fc from "fast-check";
import type { DbTx } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import {
  transitionOperation,
  type NewOperation,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import {
  applyRefundSnapshot,
  unresolvedFailedRefunds,
} from "@server/modules/credit-refund/refund-snapshot.js";
import {
  PAID_CENTS,
  inTx,
  refundObject,
  reId,
  seedRefundLot,
  useRefundSuite,
  type OpKind,
  type RefundStatus,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import { failure } from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-model-test");

const ACTIONS = [
  "approve",
  "reject",
  "settle",
  "send_back",
  "retry",
  "refund_again",
  "resolve_outside",
  "answer",
  "claim_late",
  "await_tick",
  "await_read_failed",
  "external",
  "stripe_change",
  "redeliver",
  "ask",
] as const;
type Action = (typeof ACTIONS)[number];

interface Choice {
  /** Taken when enabled; otherwise `pick` chooses among the enabled ones. */
  want: Action;
  pick: number;
  variant: number;
  amount: number;
  notify: boolean;
  acceptPartial: boolean;
}

/** One refund as Stripe holds it. */
interface FakeRefund {
  id: string;
  amount: number;
  status: RefundStatus;
  opId?: string;
}

interface OpView {
  id: string;
  kind: OpKind;
  status: string;
  result: string | null;
  notify: boolean;
  open: boolean;
  attention_reason: string | null;
  lease_token: string | null;
  stripe_refund_id: string | null;
  confirmed_refund_ids: string[];
  failed_refund_ids: string[];
  refund_amount_cents: number | null;
  settled_succeeded_cents: number | null;
}

interface View {
  lifecycle: string;
  ops: OpView[];
  inflight: OpView | undefined;
  latest: OpView | undefined;
  unresolved: { id: string; amount: number }[];
}

/** Counters that must grow by exactly what a step did. */
interface Counts {
  events: number;
  closed: number;
  ledgerRows: number;
}

/**
 * The lot and its dispositions as the harness needs them.
 * @param lot - The lot.
 * @returns The view.
 */
async function view(lot: SeededLot): Promise<View> {
  const sql = suite.sql;
  const [l] = await sql<{ lifecycle: string }[]>`
    SELECT lifecycle FROM credit_lots WHERE id = ${lot.lotId}
  `;
  const ops = await sql<(Omit<OpView, "refund_amount_cents" | "settled_succeeded_cents"> & {
    refund_amount_cents: string | null;
    settled_succeeded_cents: string | null;
  })[]>`
    SELECT id, kind, status, result, notify, attention_closed_at IS NULL AS open,
           attention_reason, lease_token, stripe_refund_id, confirmed_refund_ids,
           failed_refund_ids, refund_amount_cents::text AS refund_amount_cents,
           settled_succeeded_cents::text AS settled_succeeded_cents
    FROM credit_refund_operations WHERE lot_id = ${lot.lotId}
    ORDER BY created_at, id
  `;
  const typed = ops.map((o) => ({
    ...o,
    refund_amount_cents: o.refund_amount_cents === null ? null : Number(o.refund_amount_cents),
    settled_succeeded_cents:
      o.settled_succeeded_cents === null ? null : Number(o.settled_succeeded_cents),
  }));
  // §5.3, written out here independently of the code under test.
  const unresolved = await sql<{ id: string; amount: string }[]>`
    SELECT r.stripe_refund_id AS id, r.amount_cents::text AS amount
    FROM credit_refunds r JOIN credit_lots l ON l.id = r.lot_id
    WHERE r.lot_id = ${lot.lotId} AND l.lifecycle = 'refunded' AND r.ever_succeeded
      AND r.status IN ('failed', 'canceled') AND r.resolved_by_operation_id IS NULL
    ORDER BY r.stripe_refund_id
  `;
  return {
    lifecycle: l!.lifecycle,
    ops: typed,
    inflight: typed.find((o) => o.status === "started" || o.status === "awaiting_stripe"),
    latest: typed.at(-1),
    unresolved: unresolved.map((u) => ({ id: u.id, amount: Number(u.amount) })),
  };
}

/**
 * The counters of a lot.
 * @param lot - The lot.
 * @returns Event rows, closed attentions, ledger rows.
 */
async function counts(lot: SeededLot): Promise<Counts> {
  const [row] = await suite.sql<{ events: string; closed: string; ledger: string }[]>`
    SELECT
      (SELECT COUNT(*) FROM credit_refund_operation_events e
         JOIN credit_refund_operations o ON o.id = e.operation_id
         WHERE o.lot_id = ${lot.lotId})::text AS events,
      (SELECT COUNT(*) FROM credit_refund_operations
         WHERE lot_id = ${lot.lotId} AND attention_closed_at IS NOT NULL)::text AS closed,
      (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = ${lot.lotId})::text AS ledger
  `;
  return { events: Number(row!.events), closed: Number(row!.closed), ledgerRows: Number(row!.ledger) };
}

const isOpen = (r: FakeRefund) => r.status === "pending" || r.status === "requires_action";
const sumWhere = (rs: FakeRefund[], f: (r: FakeRefund) => boolean) =>
  rs.filter(f).reduce((n, r) => n + r.amount, 0);

/** What Stripe allows a refund to become next. */
const NEXT: Partial<Record<RefundStatus, RefundStatus[]>> = {
  pending: ["succeeded", "failed", "canceled", "requires_action"],
  requires_action: ["succeeded", "canceled"],
  succeeded: ["failed"],
};

/** One run's harness state and tallies. */
class Harness {
  readonly stripe: FakeRefund[] = [];
  readonly everSucceeded = new Set<string>();
  readonly acceptedPartial = new Set<string>();
  everTrue = new Set<string>();
  /** Ledger rows when the lot was booked; nothing may follow. */
  rowsAtBooking: number | null = null;

  constructor(
    readonly lot: SeededLot,
    readonly tally: Map<string, number>,
  ) {}

  /** @returns Stripe's list, as `refunds.list` would give it. */
  list() {
    return this.stripe.map((r) => refundObject(r.id, r.status, r.amount, r.opId));
  }

  /**
   * Deliver Stripe's list inside `tx`.
   * @param tx - The transaction.
   */
  async snapshot(tx: DbTx): Promise<void> {
    for (const r of this.stripe) if (r.status === "succeeded") this.everSucceeded.add(r.id);
    await applyRefundSnapshot(tx, this.lot.paymentId, this.list());
  }

  count(name: string): void {
    this.tally.set(name, (this.tally.get(name) ?? 0) + 1);
  }

  /**
   * The actions whose preconditions hold now.
   * @param v - The current view.
   * @param c - The step's choice.
   * @returns Enabled actions.
   */
  enabled(v: View, c: Choice): Action[] {
    const succ = sumWhere(this.stripe, (r) => r.status === "succeeded");
    const anyOpen = this.stripe.some(isOpen);
    const anySucceeded = this.stripe.some((r) => r.status === "succeeded");
    const refundable = PAID_CENTS - succ - sumWhere(this.stripe, isOpen);
    const idle = v.inflight === undefined;
    const on: Record<Action, boolean> = {
      approve: v.lifecycle === "refund_pending" && idle && !anyOpen && succ < PAID_CENTS,
      reject: v.lifecycle === "refund_pending" && idle && !anyOpen && !anySucceeded,
      settle:
        (v.lifecycle === "refunding" || v.lifecycle === "refund_pending") &&
        idle &&
        !anyOpen &&
        (succ >= PAID_CENTS || (c.acceptPartial && succ > 0)),
      send_back: v.lifecycle === "refunding" && idle && !anyOpen && !anySucceeded,
      retry:
        v.lifecycle === "refunding" &&
        idle &&
        v.latest?.status === "needs_attention" &&
        v.latest.open &&
        !anyOpen &&
        succ < PAID_CENTS,
      refund_again: v.lifecycle === "refunded" && idle && v.unresolved.length > 0 && !anyOpen,
      resolve_outside: v.lifecycle === "refunded" && idle && v.unresolved.length > 0 && !anyOpen,
      answer: v.inflight?.status === "started",
      claim_late: v.inflight?.status === "started",
      await_tick: v.inflight?.status === "awaiting_stripe" && v.inflight.stripe_refund_id === null,
      await_read_failed: v.inflight?.status === "awaiting_stripe",
      external: refundable > 0,
      stripe_change: this.stripe.some((r) => NEXT[r.status] !== undefined),
      redeliver: this.stripe.length > 0,
      ask: v.lifecycle === "active",
    };
    return ACTIONS.filter((a) => on[a]);
  }

  /**
   * Run one action.
   * @param action - Which.
   * @param v - The view before it.
   * @param c - The step's choice.
   * @returns Direct `transitionOperation` calls made, and whether a snapshot was delivered.
   */
  async run(action: Action, v: View, c: Choice): Promise<{ direct: number; snapshot: boolean }> {
    this.count(action);
    const lot = this.lot;
    const succeededIds = this.stripe.filter((r) => r.status === "succeeded").map((r) => r.id);
    const succ = sumWhere(this.stripe, (r) => r.status === "succeeded");
    const create = (kind: OpKind, extra: Partial<NewOperation>): OperationEvent => ({
      type: "E1",
      create: {
        kind,
        lotId: lot.lotId,
        paymentId: lot.paymentId,
        idempotencyKey: `model-${randomUUID()}`,
        requestHash: "e".repeat(64),
        requestedBy: "admin_model",
        reason: `model ${action}`,
        ...extra,
      },
    });
    const e1 = async (event: OperationEvent) => {
      const op = await inTx(async (tx) => {
        await this.snapshot(tx);
        return transitionOperation(tx, null, event);
      });
      return op!;
    };

    switch (action) {
      case "approve":
      case "retry":
        await e1(create(action, { confirmedRefundIds: succeededIds }));
        return { direct: 1, snapshot: true };
      case "reject":
      case "send_back":
        await e1(create(action, {}));
        return { direct: 1, snapshot: true };
      case "settle": {
        const op = await e1(
          create("settle", { notify: c.notify, confirmedSucceededCents: succ }),
        );
        if (succ < PAID_CENTS) this.acceptedPartial.add(op.id);
        return { direct: 1, snapshot: true };
      }
      case "refund_again":
        await e1(
          create("refund_again", {
            notify: c.notify,
            failedRefundIds: v.unresolved.map((u) => u.id),
            refundAmountCents: v.unresolved.reduce((n, u) => n + u.amount, 0),
          }),
        );
        return { direct: 1, snapshot: true };
      case "resolve_outside":
        await e1(create("resolve_outside", { failedRefundIds: v.unresolved.map((u) => u.id) }));
        return { direct: 1, snapshot: true };
      case "answer":
        return this.answer(v.inflight!, c);
      case "claim_late": {
        const op = v.inflight!;
        await suite.sql`
          UPDATE credit_refund_operations SET locked_until = now() - interval '1 second'
          WHERE id = ${op.id}
        `;
        await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13" }));
        await inTx((tx) =>
          transitionOperation(tx, { id: op.id }, {
            type: "E7",
            failure: failure(409),
            leaseToken: op.lease_token!,
          }),
        );
        return { direct: 2, snapshot: false };
      }
      case "await_tick": {
        const op = v.inflight!;
        if (c.variant % 2 === 1) {
          await suite.sql`
            UPDATE credit_refund_operations SET first_called_at = now() - interval '25 hours'
            WHERE id = ${op.id}
          `;
          await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E12" }));
        } else {
          await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E10" }));
        }
        return { direct: 1, snapshot: false };
      }
      case "await_read_failed":
        await inTx((tx) =>
          transitionOperation(tx, { id: v.inflight!.id }, { type: "E16", failure: failure(503) }),
        );
        return { direct: 1, snapshot: false };
      case "external": {
        const refundable = PAID_CENTS - succ - sumWhere(this.stripe, isOpen);
        const status = (["pending", "succeeded", "failed"] as const)[c.variant % 3]!;
        this.stripe.push({ id: reId("ext"), amount: 1 + (c.amount % refundable), status });
        await inTx((tx) => this.snapshot(tx));
        return { direct: 0, snapshot: true };
      }
      case "stripe_change": {
        const changeable = this.stripe.filter((r) => NEXT[r.status] !== undefined);
        const r = changeable[c.amount % changeable.length]!;
        const nexts = NEXT[r.status]!;
        r.status = nexts[c.variant % nexts.length]!;
        await inTx((tx) => this.snapshot(tx));
        return { direct: 0, snapshot: true };
      }
      case "redeliver":
        await inTx((tx) => this.snapshot(tx));
        return { direct: 0, snapshot: true };
      case "ask":
        await creditLotService.requestRefund({ lotId: lot.lotId, requestingUserId: lot.userId });
        return { direct: 0, snapshot: false };
    }
  }

  /**
   * The executor's phase 2 and 3 for a started disposition.
   * @param op - The started disposition.
   * @param c - The step's choice.
   * @returns One direct call; the snapshot is in the same transaction.
   */
  private async answer(op: OpView, c: Choice): Promise<{ direct: number; snapshot: boolean }> {
    const lease = op.lease_token!;
    const variant = c.variant % 9;
    const amountFor = () =>
      op.kind === "refund_again"
        ? op.refund_amount_cents!
        : PAID_CENTS -
          sumWhere(this.stripe, (r) => r.status === "succeeded") -
          sumWhere(this.stripe, isOpen);

    if (variant <= 2) {
      const target = (["succeeded", "pending", "failed"] as const)[variant]!;
      let refund = this.stripe.find((r) => r.opId === op.id);
      if (!refund) {
        const amount = amountFor();
        if (amount <= 0) {
          this.count("answer:E9");
          await inTx((tx) =>
            transitionOperation(tx, { id: op.id }, {
              type: "E9",
              failure: failure(400, { code: "charge_already_refunded" }),
              leaseToken: lease,
            }),
          );
          return { direct: 1, snapshot: false };
        }
        refund = { id: reId("own"), amount, status: target, opId: op.id };
        this.stripe.push(refund);
      }
      const object = refundObject(refund.id, refund.status, refund.amount, op.id);
      const event = this.classify(op, refund, object);
      this.count(`answer:${event.type}`);
      await inTx(async (tx) => {
        await this.snapshot(tx);
        await transitionOperation(tx, { id: op.id }, { ...event, leaseToken: lease });
      });
      return { direct: 1, snapshot: false };
    }

    const failures: Record<number, OperationEvent> = {
      3: { type: "E7", failure: failure(429, { code: "rate_limit" }), leaseToken: lease },
      4: { type: "E8", failure: failure(500), leaseToken: lease },
      5: { type: "E11" },
      6: { type: "E9", failure: failure(400, { code: "charge_already_refunded" }), leaseToken: lease },
      7: { type: "E16", failure: failure(503), leaseToken: lease },
      8: { type: "E17", failure: failure(402), leaseToken: lease },
    };
    if (variant === 4) {
      // A 5xx says nothing about whether Stripe made the refund; sometimes it did.
      const made = c.amount % 3;
      const amount = amountFor();
      if (made > 0 && amount > 0 && !this.stripe.some((r) => r.opId === op.id)) {
        this.stripe.push({
          id: reId("own_5xx"),
          amount,
          status: made === 1 ? "pending" : "succeeded",
          opId: op.id,
        });
      }
    }
    this.count(`answer:${failures[variant]!.type}`);
    await inTx((tx) => transitionOperation(tx, { id: op.id }, failures[variant]!));
    return { direct: 1, snapshot: false };
  }

  /**
   * §5.4 for a refund object: E2 … E6, by the settle rule for approve and
   * retry, by the refund alone for refund_again.
   */
  private classify(
    op: OpView,
    refund: FakeRefund,
    object: ReturnType<typeof refundObject>,
  ): OperationEvent {
    if (refund.status === "pending" || refund.status === "requires_action") {
      return { type: "E5", refund: object };
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      return { type: "E6", refund: object };
    }
    if (op.kind === "refund_again") return { type: "E2", refund: object };
    if (this.stripe.some((r) => r.id !== refund.id && isOpen(r))) {
      return { type: "E3", refund: object };
    }
    const succ = sumWhere(this.stripe, (r) => r.status === "succeeded");
    if (succ < PAID_CENTS) return { type: "E4", refund: object, reason: "partial_refund" };
    const unconfirmed = this.stripe.some(
      (r) => r.status === "succeeded" && r.opId === undefined && !op.confirmed_refund_ids.includes(r.id),
    );
    if (unconfirmed) return { type: "E4", refund: object, reason: "unexpected_external_refund" };
    return { type: "E2", refund: object };
  }

  /**
   * Every §9 invariant this harness can see.
   * @param before - Counters before the step.
   * @param step - What the step did.
   * @param step.direct - Direct transition calls.
   * @param step.snapshot - Whether a snapshot was delivered.
   * @param awaitingBefore - Whether a disposition was awaiting Stripe before it.
   */
  async check(
    before: Counts,
    step: { direct: number; snapshot: boolean },
    awaitingBefore: boolean,
  ): Promise<void> {
    const sql = suite.sql;
    const lot = this.lot;
    const v = await view(lot);
    const after = await counts(lot);

    // 1. At most one in flight.
    expect(v.ops.filter((o) => o.status === "started" || o.status === "awaiting_stripe").length)
      .toBeLessThanOrEqual(1);

    // 2. A refunding lot is being worked on or waits on a person.
    if (v.lifecycle === "refunding") {
      const waitsOnPerson = v.latest?.status === "needs_attention" && v.latest.open;
      expect(v.inflight !== undefined || waitsOnPerson).toBe(true);
    }

    // 3. Ledger.
    const [ledger] = await sql<{ refunds: string; balanced: boolean; remaining: string }[]>`
      SELECT
        (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id AND entry_type = 'refund')::text
          AS refunds,
        l.remaining_credits =
          (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE lot_id = l.id) AS balanced,
        l.remaining_credits::text AS remaining
      FROM credit_lots l WHERE l.id = ${lot.lotId}
    `;
    expect(Number(ledger!.refunds)).toBe(v.lifecycle === "refunded" ? 1 : 0);
    expect(ledger!.balanced).toBe(true);
    if (v.lifecycle === "refunded") {
      expect(ledger!.remaining).toBe("0.000000");
      this.rowsAtBooking ??= after.ledgerRows;
      expect(after.ledgerRows).toBe(this.rowsAtBooking);
    }
    const rejected = v.ops.filter((o) => o.result === "rejected").length;
    const [rej] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM credit_ledger
      WHERE lot_id = ${lot.lotId} AND entry_type = 'refund_rejected' AND amount = 0
    `;
    expect(Number(rej!.n)).toBe(rejected);

    // 4. Booked on enough money.
    for (const o of v.ops.filter((x) => x.result === "refunded")) {
      if (o.kind === "approve" || o.kind === "retry") {
        expect(o.settled_succeeded_cents!).toBeGreaterThanOrEqual(PAID_CENTS);
      } else if (o.kind === "settle" && !this.acceptedPartial.has(o.id)) {
        expect(o.settled_succeeded_cents!).toBeGreaterThanOrEqual(PAID_CENTS);
      }
    }

    // 5. One auto mail and one bell per telling finish, none otherwise.
    const telling = v.ops.filter(
      (o) => o.result === "rejected" || (o.result === "refunded" && o.notify),
    );
    const mails = await sql<{ operation_id: string; kind: string }[]>`
      SELECT m.operation_id, m.kind FROM refund_mail_outbox m
      JOIN credit_refund_operations o ON o.id = m.operation_id
      WHERE o.lot_id = ${lot.lotId} AND m.origin = 'auto'
    `;
    expect(
      mails.map((m) => `${m.operation_id}:${m.kind}`).sort(),
    ).toEqual(
      telling
        .map((o) => `${o.id}:${o.result === "rejected" ? "refund_rejected" : "refund_completed"}`)
        .sort(),
    );
    const [bells] = await sql<{ completed: string; rejected: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE type = 'credit.refund_completed')::text AS completed,
        COUNT(*) FILTER (WHERE type = 'credit.refund_rejected')::text AS rejected
      FROM notifications WHERE user_id = ${lot.userId}
    `;
    expect(Number(bells!.completed)).toBe(telling.filter((o) => o.result === "refunded").length);
    expect(Number(bells!.rejected)).toBe(rejected);

    // 6. One event row per transition taken.
    const rejudged = step.snapshot && awaitingBefore ? 1 : 0;
    expect(after.events - before.events).toBe(step.direct + rejudged + (after.closed - before.closed));
    const firsts = await sql<{ operation_id: string; event: string; from_status: string | null }[]>`
      SELECT DISTINCT ON (e.operation_id) e.operation_id, e.event, e.from_status
      FROM credit_refund_operation_events e
      JOIN credit_refund_operations o ON o.id = e.operation_id
      WHERE o.lot_id = ${lot.lotId}
      ORDER BY e.operation_id, e.created_at, e.id
    `;
    expect(firsts).toHaveLength(v.ops.length);
    for (const f of firsts) expect({ event: f.event, from: f.from_status }).toEqual({ event: "requested", from: null });

    // 7. ever_succeeded: delivered successes are remembered, and memory stays.
    const copies = await sql<{ id: string; ever: boolean }[]>`
      SELECT stripe_refund_id AS id, ever_succeeded AS ever FROM credit_refunds
      WHERE lot_id = ${lot.lotId}
    `;
    const ever = new Map(copies.map((c) => [c.id, c.ever]));
    for (const id of this.everSucceeded) expect(ever.get(id)).toBe(true);
    for (const id of this.everTrue) expect(ever.get(id)).toBe(true);
    this.everTrue = new Set(copies.filter((c) => c.ever).map((c) => c.id));

    // 8. A finished refund_again has answered for what it covered.
    const resolved = await sql<{ id: string; by: string | null }[]>`
      SELECT stripe_refund_id AS id, resolved_by_operation_id AS by FROM credit_refunds
      WHERE lot_id = ${lot.lotId}
    `;
    const by = new Map(resolved.map((r) => [r.id, r.by]));
    for (const o of v.ops.filter((x) => x.kind === "refund_again" && x.result === "refunded")) {
      for (const id of o.failed_refund_ids) expect(by.get(id)).toBe(o.id);
    }

    // 9. An open refund_again attention has something left to answer for,
    //    and the code's list is the definition's list.
    if (v.ops.some((o) => o.kind === "refund_again" && o.status === "needs_attention" && o.open)) {
      expect(v.unresolved.length).toBeGreaterThan(0);
    }
    const listed = await inTx((tx) => unresolvedFailedRefunds(tx, lot.lotId));
    expect(listed.map((r) => r.stripeRefundId).sort()).toEqual(v.unresolved.map((u) => u.id));
  }
}

const choiceArb: fc.Arbitrary<Choice> = fc.record({
  want: fc.constantFrom(...ACTIONS),
  pick: fc.nat(),
  variant: fc.nat(),
  amount: fc.nat(),
  notify: fc.boolean(),
  acceptPartial: fc.boolean(),
});

/**
 * A step that asks for one action by name.
 * @param want - The action.
 * @param variant - Which answer or change.
 * @param amount - Which refund or how much.
 * @param flags - notify / acceptPartial.
 * @returns The choice.
 */
function step(
  want: Action,
  variant = 0,
  amount = 0,
  flags: Partial<Pick<Choice, "notify" | "acceptPartial">> = {},
): Choice {
  return { want, pick: 0, variant, amount, notify: flags.notify ?? true, acceptPartial: flags.acceptPartial ?? false };
}

/**
 * Hand-written runs that walk every exit, so a random draw that misses a
 * path cannot leave it unchecked.
 */
const EXAMPLES: [Choice[]][] = [
  // Booked, the refund fails later, refund again, that one fails later too, resolved outside.
  [[
    step("approve"), step("answer", 0), step("stripe_change"), step("refund_again"),
    step("answer", 0), step("stripe_change"), step("resolve_outside"),
  ]],
  // Pending, then a webhook says succeeded: the snapshot books.
  [[step("approve"), step("answer", 1), step("stripe_change", 0), step("redeliver")]],
  // 5xx while Stripe did make the refund: found by metadata on the next snapshot.
  [[step("approve"), step("answer", 4, 2), step("redeliver")]],
  // Reject, ask again, declined, approve, already refunded, retry, exhausted, send back.
  [[
    step("reject"), step("ask"), step("approve"), step("answer", 2), step("approve"),
    step("answer", 6), step("retry"), step("answer", 5), step("send_back"),
  ]],
  // Timeout, lease handed on and the old holder late, 5xx with nothing made,
  // 24 hours, an external partial refund, settled on purpose short.
  [[
    step("approve"), step("answer", 3), step("claim_late"), step("answer", 4, 0),
    step("await_tick", 1), step("external", 1, 0), step("settle", 0, 0, { acceptPartial: true, notify: false }),
  ]],
  // Booked, fails later, refund again declined by Stripe, resolved outside.
  [[
    step("approve"), step("answer", 0), step("stripe_change"), step("refund_again", 0, 0, { notify: false }),
    step("answer", 2), step("resolve_outside"),
  ]],
  // An external refund in flight holds the approval back (E3) until it settles.
  [[
    step("approve"), step("external", 0, 99), step("answer", 0), step("stripe_change", 0),
    step("redeliver"),
  ]],
];

describe("random disposition sequences on one lot (§9 invariants)", () => {
  it("keeps every invariant after every step", async () => {
    const tally = new Map<string, number>();
    await fc.assert(
      fc.asyncProperty(fc.array(choiceArb, { minLength: 4, maxLength: 16 }), async (choices) => {
        const lot = await seedRefundLot(suite.sql, "refund_pending");
        const h = new Harness(lot, tally);
        for (const c of choices) {
          const v = await view(lot);
          const enabled = h.enabled(v, c);
          if (enabled.length === 0) continue;
          const action = enabled.includes(c.want) ? c.want : enabled[c.pick % enabled.length]!;
          const before = await counts(lot);
          const awaitingBefore = v.inflight?.status === "awaiting_stripe";
          const did = await h.run(action, v, c);
          await h.check(before, did, awaitingBefore);
        }
      }),
      { numRuns: 25, examples: EXAMPLES },
    );

    // The hand-written runs reach every disposition kind and the answers
    // that finish them; a refactor of the harness that stops reaching one
    // turns this red instead of quietly checking less.
    for (const name of [
      "approve", "reject", "settle", "send_back", "retry", "refund_again", "resolve_outside",
      "claim_late", "await_tick", "external", "stripe_change", "redeliver", "ask",
      "answer:E2", "answer:E3", "answer:E5", "answer:E6", "answer:E7", "answer:E8",
      "answer:E9", "answer:E11",
    ]) {
      expect(tally.get(name) ?? 0, name).toBeGreaterThan(0);
    }
  });
});
