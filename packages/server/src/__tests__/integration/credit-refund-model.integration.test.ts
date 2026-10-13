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
 *   production judges (`assessRefundCreate`, `assessOneShot`) pass it
 *   against Stripe's current state, read the way the endpoint reads it, and,
 *   as the endpoint does, it first hands Stripe's list to
 *   `applyRefundSnapshot` in the same transaction; it also repeats an
 *   earlier request's Idempotency-Key, and reuses one on another target,
 *   through the endpoint's service (§4.6);
 * - **the executor and the loop**: a started disposition gets one of the
 *   §5.4 answers, classified here from the fake Stripe's state, and passed
 *   to `transitionOperation` with its lease; leases run out, the loop takes
 *   them over (E13), and the old executor wakes with its stale row and runs
 *   `executeRefund`, then the old holder answers late. The two steps that can
 *   end a disposition without Stripe's refund run the production code
 *   itself: the awaiting lookup is a real loop tick (`runRefundLoopOnce`:
 *   recheck, snapshot, E12), and the answer "attempts used up" claims the
 *   row and runs `executeRefund`; both read Stripe through `listRefunds` /
 *   `listRefundsForPayment`, mocked to answer with this harness's list, and
 *   production's `createRefund` is mocked to make the refund on this
 *   harness's Stripe under `credit-refund-<id>`;
 * - **Stripe**: refunds are created at most once per disposition, change
 *   status on their own (including succeeded → failed), appear from outside
 *   the product, and every change is delivered as a snapshot (a webhook).
 *   What Stripe will still refund is paid − succeeded − processing − failed:
 *   a failed refund's amount does not come back (§5.2, verified), so a
 *   create beyond it is refused.
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
 *    refund; production's read (`pickUnresolvedFailedRefunds` over the
 *    payment's copies) agrees with the §5.3 definition;
 * 10. a step that booked the lot answered for every copy then `failed` or
 *    `canceled` (§5.5);
 * 11. with nothing in flight and nothing processing on Stripe: a lot not yet
 *    booked passes resolve_outside, a `refunding` lot has an exit, and a
 *    `refunded` lot with an unresolved failed refund passes resolve_outside,
 *    and passes refund_again exactly when the amount it would send is no
 *    more than paid − succeeded − failed (v6 §9);
 * 12. a repeated Idempotency-Key replays the disposition it made (or is
 *    `request_in_progress` while its lease is held) and the same key on
 *    another target is `idempotency_key_reused`; neither writes anything;
 * 13. a disposition in `needs_attention` for `attempts_exhausted` or
 *    `stripe_result_unknown` has no refund on Stripe carrying its id: E11 and
 *    E12 only follow a list read that holds none (v8 §9). Production's
 *    executor and loop fire both, so this watches them, not the harness;
 * 14. Stripe holds at most one refund per disposition, and production called
 *    `refunds.create` only while the caller still held the row's lease
 *    (v8 §9): an executor that wakes after a takeover never creates.
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

/** The run whose Stripe the mocked calls answer for: its payment, its list, its create. */
const stripeReads = vi.hoisted(() => ({
  paymentId: "",
  paymentIntentId: "",
  list: (): StripeRefundObject[] => [],
  create: async (_input: CreateInput): Promise<CreateResult> => {
    throw new Error("model: refunds.create called outside a run");
  },
}));

vi.mock("@server/modules/credit-refund/stripe-refunds.js", async (importOriginal) => {
  const real = await importOriginal<typeof StripeRefunds>();
  const answer = async (asked: string, held: string): Promise<StripeRefundObject[]> => {
    if (asked !== held) throw new Error(`model: Stripe read for ${asked}, not this run's payment`);
    return stripeReads.list();
  };
  return {
    ...real,
    listRefunds: (paymentIntent: string) => answer(paymentIntent, stripeReads.paymentIntentId),
    listRefundsForPayment: (paymentId: string) => answer(paymentId, stripeReads.paymentId),
    createRefund: (input: CreateInput) => stripeReads.create(input),
  };
});

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { CreditLotEntity } from "@breatic/shared";
import { creditLotRepo, creditLotService } from "@breatic/domain";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { assessOneShot, assessRefundCreate } from "@server/modules/credit-refund/assess.js";
import { requestOneShot, requestRefund } from "@server/modules/credit-refund/disposition.service.js";
import { executeRefund } from "@server/modules/credit-refund/executor.js";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type NewOperation,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { RefundRefusal } from "@server/modules/credit-refund/refusal.js";
import type * as StripeRefunds from "@server/modules/credit-refund/stripe-refunds.js";
import type { RefundCopy, StripeRefundObject } from "@server/modules/credit-refund/types.js";
import { pickUnresolvedFailedRefunds } from "@server/modules/credit-refund/unresolved.js";
import {
  PAID_CENTS,
  eventsOf,
  inTx,
  markReconcileJustFinished,
  parkInFlightOperations,
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
  "repeat_key",
  "key_other_target",
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

type CreateInput = Parameters<typeof StripeRefunds.createRefund>[0];
type CreateResult = Awaited<ReturnType<typeof StripeRefunds.createRefund>>;

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

/** The lot as production reads it inside a write, after the snapshot. */
interface Facts {
  lot: CreditLotEntity;
  ledgerSum: number;
  ops: CreditRefundOperation[];
  refunds: RefundCopy[];
}

/** The six kinds an operator can request, and whether the judges pass each now. */
type Verdicts = Record<OpKind, boolean>;

/** Thrown to roll back the transaction that only reads facts. */
class ReadOnly extends Error {}

const REQUEST_HASH = "e".repeat(64);

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
    FROM credit_refunds r JOIN credit_lots l ON l.id = ${lot.lotId}
    WHERE r.payment_id = ${lot.paymentId}
      AND r.status IN ('failed', 'canceled') AND r.resolved_by_operation_id IS NULL
      AND (l.lifecycle IN ('refund_pending', 'refunding')
           OR (l.lifecycle = 'refunded' AND r.ever_succeeded))
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
const inFlight = (o: { status: string }) => o.status === "started" || o.status === "awaiting_stripe";

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
  /** Every Idempotency-Key this run's dispositions were made under. */
  readonly keys: { key: string; kind: OpKind }[] = [];
  /** Every `refunds.create` production made, and whether its caller held the row's lease then. */
  readonly creates: { key: string; held: boolean }[] = [];
  /** The lease of the `executeRefund` the harness is running now, if any. */
  callerLease: string | null = null;
  /** The status a refund made by production's create starts in. */
  createStatus: RefundStatus = "succeeded";

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
    this.noteSucceeded();
    await applyRefundSnapshot(tx, this.lot.paymentId, this.list(), "request");
  }

  /** Note every refund the next read will see as succeeded (check 7). */
  noteSucceeded(): void {
    for (const r of this.stripe) if (r.status === "succeeded") this.everSucceeded.add(r.id);
  }

  /**
   * Stripe's `refunds.create` under `credit-refund-<id>`, as production calls
   * it: a repeat of the key returns the refund the first call made, as
   * Stripe's idempotency does; a first call makes one in `createStatus`, or
   * is refused when Stripe will not refund that much. Each call is logged
   * with whether its caller still held the row's lease (check 14).
   * @param input - What production asked for.
   * @returns Stripe's answer.
   */
  async create(input: CreateInput): Promise<CreateResult> {
    const [row] = await suite.sql<{ held: boolean | null }[]>`
      SELECT lease_token = ${this.callerLease} AND locked_until > now() AS held
      FROM credit_refund_operations WHERE id = ${input.operationId}
    `;
    this.creates.push({ key: `credit-refund-${input.operationId}`, held: row?.held === true });
    let refund = this.stripe.find((r) => r.opId === input.operationId);
    if (!refund) {
      const amount = input.amountCents ?? this.refundable();
      if (amount <= 0 || amount > this.refundable()) {
        const code = amount <= 0 ? "charge_already_refunded" : "amount_too_large";
        return {
          answer: { kind: "stripe_error", httpStatus: 400, type: "invalid_request_error", code },
          failure: failure(400, { code }),
        };
      }
      refund = { id: reId("own_create"), amount, status: this.createStatus, opId: input.operationId };
      this.stripe.push(refund);
    }
    return {
      answer: { kind: "refund" },
      refund: refundObject(refund.id, refund.status, refund.amount, input.operationId),
    };
  }

  /**
   * Run production's attempt as the executor holding `row`'s lease.
   * @param row - The disposition as that executor last read it.
   */
  async execute(row: CreditRefundOperation): Promise<void> {
    this.callerLease = row.leaseToken;
    try {
      await executeRefund(row, "loop");
    } finally {
      this.callerLease = null;
    }
  }

  count(name: string): void {
    this.tally.set(name, (this.tally.get(name) ?? 0) + 1);
  }

  /**
   * What Stripe will still refund: a failed refund's amount does not come
   * back; a canceled one never moved money.
   * @returns Cents.
   */
  refundable(): number {
    return (
      PAID_CENTS -
      sumWhere(this.stripe, (r) => r.status === "succeeded") -
      sumWhere(this.stripe, isOpen) -
      sumWhere(this.stripe, (r) => r.status === "failed")
    );
  }

  /**
   * The facts a write request judges on: Stripe's list copied in, then the
   * lot, its ledger sum, its dispositions and its payment's copies — as the
   * endpoint reads them — in a transaction that is rolled back.
   * @returns The facts.
   */
  async facts(): Promise<Facts> {
    let read: Facts | undefined;
    try {
      await db.transaction(async (tx) => {
        await applyRefundSnapshot(tx, this.lot.paymentId, this.list(), "request");
        const lot = (await creditLotRepo.lockLot(this.lot.lotId, tx))!;
        const { ledgerSum } = await creditLotRepo.readRefundFacts(this.lot.lotId, tx);
        read = {
          lot,
          ledgerSum: Number(ledgerSum),
          ops: await operationRepo.listForLot(this.lot.lotId, tx),
          refunds: await refundCopyRepo.listForPayment(this.lot.paymentId, tx),
        };
        throw new ReadOnly();
      });
    } catch (err) {
      if (!(err instanceof ReadOnly)) throw err;
    }
    return read!;
  }

  /**
   * Whether the production judges pass each kind now, with what the
   * confirmation page would send back for these facts.
   * @param f - The facts.
   * @param acceptPartial - settle's acceptPartial.
   * @returns One verdict per kind.
   */
  verdicts(f: Facts, acceptPartial: boolean): Verdicts {
    const lifecycle = f.lot.lifecycle;
    const remainingCredits = Number(f.lot.remainingCredits);
    const succeeded = f.refunds.filter((r) => r.status === "succeeded");
    const succeededCents = succeeded.reduce((n, r) => n + r.amountCents, 0);
    const failedRefundIds = pickUnresolvedFailedRefunds(lifecycle, f.refunds).map((r) => r.stripeRefundId);
    const create = (kind: "approve" | "retry" | "refund_again") =>
      assessRefundCreate({
        kind,
        lot: { lifecycle, remainingCredits, ledgerSum: f.ledgerSum },
        payment: { status: "completed", stripePaymentIntentId: this.lot.paymentIntentId, paidCents: PAID_CENTS },
        ops: f.ops,
        refunds: f.refunds,
        confirmedRefundIds: succeeded.map((r) => r.stripeRefundId),
        failedRefundIds,
      }).outcome === "create_refund";
    const oneShot = (kind: "reject" | "settle" | "send_back" | "resolve_outside") =>
      assessOneShot({
        kind,
        lot: { lifecycle, remainingCredits },
        paidCents: PAID_CENTS,
        ops: f.ops,
        refunds: f.refunds,
        confirmedSucceededCents: succeededCents,
        acceptPartial,
        failedRefundIds,
      }).outcome === "proceed";
    return {
      approve: create("approve"),
      retry: create("retry"),
      refund_again: create("refund_again"),
      reject: oneShot("reject"),
      settle: oneShot("settle"),
      send_back: oneShot("send_back"),
      resolve_outside: oneShot("resolve_outside"),
    };
  }

  /**
   * The actions whose preconditions hold now: the six requests as the
   * production judges decide them, the rest from the harness's own state.
   * @param v - The current view.
   * @param c - The step's choice.
   * @returns Enabled actions.
   */
  async enabled(v: View, c: Choice): Promise<Action[]> {
    const judged = this.verdicts(await this.facts(), c.acceptPartial);
    const on: Record<Action, boolean> = {
      ...judged,
      answer: v.inflight?.status === "started",
      claim_late: v.inflight?.status === "started",
      await_tick: v.inflight?.status === "awaiting_stripe" && v.inflight.stripe_refund_id === null,
      await_read_failed: v.inflight?.status === "awaiting_stripe",
      external: this.refundable() > 0,
      stripe_change: this.stripe.some((r) => NEXT[r.status] !== undefined),
      redeliver: this.stripe.length > 0,
      ask: v.lifecycle === "active",
      repeat_key: this.keys.length > 0,
      key_other_target: this.keys.length > 0,
    };
    return ACTIONS.filter((a) => on[a]);
  }

  /**
   * Send an earlier request's Idempotency-Key through the endpoint's service
   * again: to the same lot with the same fingerprint, or to another target.
   * Nothing must be written either way (§4.6).
   * @param c - The step's choice.
   * @param otherTarget - Send it for another lot, with that lot's fingerprint.
   */
  async reuseKey(c: Choice, otherTarget: boolean): Promise<void> {
    const { key, kind } = this.keys[c.amount % this.keys.length]!;
    const req = {
      lotId: otherTarget ? randomUUID() : this.lot.lotId,
      adminId: "admin_model",
      key,
      hash: otherTarget ? "f".repeat(64) : REQUEST_HASH,
      reason: "model: same key again",
    };
    const send = () =>
      kind === "approve" || kind === "retry" || kind === "refund_again"
        ? requestRefund(kind, req, {})
        : requestOneShot(kind, req, {});
    const [held] = await suite.sql<{ id: string; status: string; leased: boolean }[]>`
      SELECT id, status, coalesce(locked_until > now(), false) AS leased
      FROM credit_refund_operations WHERE idempotency_key = ${key}
    `;
    if (otherTarget) {
      const refused = await send().then(() => null, (err: unknown) => err);
      expect(refused).toBeInstanceOf(RefundRefusal);
      expect(refused).toMatchObject({ status: 422, code: "idempotency_key_reused" });
    } else if (held!.status === "started" && held!.leased) {
      const refused = await send().then(() => null, (err: unknown) => err);
      expect(refused).toBeInstanceOf(RefundRefusal);
      expect(refused).toMatchObject({ status: 409, code: "request_in_progress" });
    } else {
      const answer = await send();
      expect(answer.body).toMatchObject({ id: held!.id, idempotencyKey: key });
      expect(answer.status).toBe(inFlight(held!) ? 202 : 200);
    }
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
    const create = (kind: OpKind, extra: Partial<NewOperation>): OperationEvent => {
      const idempotencyKey = `model-${randomUUID()}`;
      this.keys.push({ key: idempotencyKey, kind });
      return {
        type: "E1",
        create: {
          kind,
          lotId: lot.lotId,
          paymentId: lot.paymentId,
          idempotencyKey,
          requestHash: REQUEST_HASH,
          requestedBy: "admin_model",
          reason: `model ${action}`,
          ...extra,
        },
        actor: "request",
      };
    };
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
        // The lease runs out and the loop takes the row over (E13). The old
        // executor then wakes with its stale row and runs production's
        // attempt: it must not reach refunds.create (check 14), and anything
        // it writes is a late answer. Then the old holder answers late.
        const op = v.inflight!;
        const stale = (await operationRepo.findById(op.id))!;
        await suite.sql`
          UPDATE credit_refund_operations SET locked_until = now() - interval '1 second'
          WHERE id = ${op.id}
        `;
        await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13", actor: "loop" }));
        this.createStatus = (["succeeded", "pending", "failed"] as const)[c.variant % 3]!;
        const eventsBefore = (await eventsOf(suite.sql, op.id)).length;
        await this.execute(stale);
        const staleEvents = (await eventsOf(suite.sql, op.id)).slice(eventsBefore).map((e) => e.event);
        expect(staleEvents.filter((e) => e !== "late_answer")).toEqual([]);
        await inTx((tx) =>
          transitionOperation(tx, { id: op.id }, {
            type: "E7",
            failure: failure(409),
            leaseToken: op.lease_token!,
            actor: "loop",
          }),
        );
        return { direct: 2 + staleEvents.length, snapshot: false };
      }
      case "await_tick": {
        // A real loop tick for the disposition, made due (and, on odd
        // variants, 25 hours past its first call): its recheck copies
        // Stripe's list, which judges the disposition's own refund or is the
        // E10, and decides E12 itself. Only that E12 is a direct call.
        const op = v.inflight!;
        await suite.sql`
          UPDATE credit_refund_operations
          SET next_attempt_at = now() - interval '1 second',
              first_called_at = CASE WHEN ${c.variant % 2 === 1}
                THEN now() - interval '25 hours' ELSE first_called_at END
          WHERE id = ${op.id}
        `;
        const e12s = async () =>
          (await eventsOf(suite.sql, op.id)).filter((e) => e.event === "deadline_reached").length;
        const e12Before = await e12s();
        this.noteSucceeded();
        await runRefundLoopOnce();
        return { direct: (await e12s()) - e12Before, snapshot: true };
      }
      case "await_read_failed":
        await inTx((tx) =>
          transitionOperation(tx, { id: v.inflight!.id }, { type: "E16", failure: failure(503), actor: "loop" }),
        );
        return { direct: 1, snapshot: false };
      case "external": {
        const refundable = this.refundable();
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
      case "repeat_key":
      case "key_other_target":
        await this.reuseKey(c, action === "key_other_target");
        return { direct: 0, snapshot: false };
    }
  }

  /**
   * The executor's phase 2 and 3 for a started disposition.
   * @param op - The started disposition.
   * @param c - The step's choice.
   * @returns The direct calls made: one, or resumeExhausted's two for
   *   variant 5; the snapshot is in the same transaction.
   */
  private async answer(op: OpView, c: Choice): Promise<{ direct: number; snapshot: boolean }> {
    const variant = c.variant % 9;
    if (variant === 5) return this.resumeExhausted(op);
    const lease = op.lease_token!;
    // approve and retry send no amount: Stripe refunds what it still will.
    const amountFor = () => (op.kind === "refund_again" ? op.refund_amount_cents! : this.refundable());

    if (variant <= 2) {
      const target = (["succeeded", "pending", "failed"] as const)[variant]!;
      let refund = this.stripe.find((r) => r.opId === op.id);
      if (!refund && op.kind === "refund_again" && amountFor() > this.refundable()) {
        // Stripe refuses an amount beyond what it will still refund, on the
        // first request (§5.2, verified): E6, nothing created.
        this.count("answer:E6");
        await inTx((tx) =>
          transitionOperation(tx, { id: op.id }, {
            type: "E6",
            failure: failure(400, { code: "amount_too_large" }),
            leaseToken: lease,
            actor: "loop",
          }),
        );
        return { direct: 1, snapshot: false };
      }
      if (!refund) {
        const amount = amountFor();
        if (amount <= 0) {
          this.count("answer:E9");
          await inTx((tx) =>
            transitionOperation(tx, { id: op.id }, {
              type: "E9",
              failure: failure(400, { code: "charge_already_refunded" }),
              leaseToken: lease,
              actor: "loop",
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
      3: { type: "E7", failure: failure(429, { code: "rate_limit" }), leaseToken: lease, actor: "loop" },
      4: { type: "E8", failure: failure(500), leaseToken: lease, actor: "loop" },
      6: { type: "E9", failure: failure(400, { code: "charge_already_refunded" }), leaseToken: lease, actor: "loop" },
      7: { type: "E16", failure: failure(503), leaseToken: lease, actor: "loop" },
      8: { type: "E17", failure: failure(402), leaseToken: lease, actor: "loop" },
    };
    if (variant === 4) {
      // A 5xx says nothing about whether Stripe made the refund; sometimes it did.
      const made = c.amount % 3;
      const amount = amountFor();
      if (made > 0 && amount > 0 && amount <= this.refundable() && !this.stripe.some((r) => r.opId === op.id)) {
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
   * The loop resuming a started disposition with no attempt left, through
   * production: its lease runs out, E13 claims it, and `executeRefund` reads
   * Stripe's list first — judging the disposition's own refund there, or,
   * finding none, ending it with E11 (v8 §6.2). It never creates.
   * @param op - The started disposition.
   * @returns E13 and the attempt's one cell.
   */
  private async resumeExhausted(op: OpView): Promise<{ direct: number; snapshot: boolean }> {
    await suite.sql`
      UPDATE credit_refund_operations
      SET locked_until = now() - interval '1 second',
          attempt_count = ${getCreditRefundConfig().maxAttempts},
          first_called_at = coalesce(first_called_at, now())
      WHERE id = ${op.id}
    `;
    const claimed = await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13", actor: "loop" }));
    this.noteSucceeded();
    await this.execute(claimed!);
    this.count(`exhausted:${(await eventsOf(suite.sql, op.id)).at(-1)!.event}`);
    return { direct: 2, snapshot: false };
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
      return { type: "E5", refund: object, actor: "loop" };
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      return { type: "E6", refund: object, actor: "loop" };
    }
    if (op.kind === "refund_again") return { type: "E2", refund: object, actor: "loop" };
    if (this.stripe.some((r) => r.id !== refund.id && isOpen(r))) {
      return { type: "E3", refund: object, actor: "loop" };
    }
    const succ = sumWhere(this.stripe, (r) => r.status === "succeeded");
    if (succ < PAID_CENTS) return { type: "E4", refund: object, reason: "partial_refund", actor: "loop" };
    const unconfirmed = this.stripe.some(
      (r) => r.status === "succeeded" && r.opId === undefined && !op.confirmed_refund_ids.includes(r.id),
    );
    if (unconfirmed) return { type: "E4", refund: object, reason: "unexpected_external_refund", actor: "loop" };
    return { type: "E2", refund: object, actor: "loop" };
  }

  /**
   * Every §9 invariant this harness can see.
   * @param before - Counters before the step.
   * @param step - What the step did.
   * @param step.direct - Direct transition calls.
   * @param step.snapshot - Whether a snapshot was delivered.
   * @param awaitingBefore - Whether a disposition was awaiting Stripe before it.
   * @param lifecycleBefore - The lot's state before it.
   */
  async check(
    before: Counts,
    step: { direct: number; snapshot: boolean },
    awaitingBefore: boolean,
    lifecycleBefore: string,
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

    // 13. A disposition handed to a person because Stripe's result is not
    //     known, or its attempts ran out, has no refund on Stripe (v8 §9).
    for (const o of v.ops) {
      const unknownResult =
        o.attention_reason === "attempts_exhausted" || o.attention_reason === "stripe_result_unknown";
      if (o.status !== "needs_attention" || !unknownResult) continue;
      expect(this.stripe.filter((r) => r.opId === o.id), o.id).toEqual([]);
    }

    // 14. One refund per disposition on Stripe, created only under a lease
    //     the caller still held (v8 §9).
    const owners = this.stripe.flatMap((r) => (r.opId === undefined ? [] : [r.opId]));
    expect(owners.length - new Set(owners).size, "dispositions with two refunds").toBe(0);
    expect(this.creates.filter((c) => !c.held), "refunds.create under a lease no longer held").toEqual([]);

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
    const listed = await inTx(async (tx) => {
      const locked = await creditLotRepo.lockLot(lot.lotId, tx);
      return pickUnresolvedFailedRefunds(locked!.lifecycle, await refundCopyRepo.listForPayment(lot.paymentId, tx));
    });
    expect(listed.map((r) => r.stripeRefundId).sort()).toEqual(v.unresolved.map((u) => u.id));

    // 10. A step that booked the lot answered for every copy then failed or canceled.
    if (lifecycleBefore !== "refunded" && v.lifecycle === "refunded") {
      const unanswered = await sql<{ id: string }[]>`
        SELECT stripe_refund_id AS id FROM credit_refunds
        WHERE payment_id = ${lot.paymentId} AND status IN ('failed', 'canceled')
          AND resolved_by_operation_id IS NULL
      `;
      expect(unanswered).toEqual([]);
    }

    // 11. Nothing in flight and nothing processing: the exits are open (§9).
    //     Judged on what an endpoint would read now, after Stripe's list.
    const f = await this.facts();
    if (!f.ops.some(inFlight) && !f.refunds.some((r) => r.status === "pending" || r.status === "requires_action")) {
      const pass = this.verdicts(f, true);
      const lifecycle = f.lot.lifecycle;
      if (lifecycle === "refunding" || lifecycle === "refund_pending") {
        expect(pass.resolve_outside).toBe(true);
      }
      if (lifecycle === "refunding") {
        expect(pass.settle || pass.send_back || pass.retry || pass.resolve_outside).toBe(true);
      }
      const unresolved = pickUnresolvedFailedRefunds(lifecycle, f.refunds);
      if (lifecycle === "refunded" && unresolved.length > 0) {
        const cents = (pick: (r: RefundCopy) => boolean) =>
          f.refunds.filter(pick).reduce((n, r) => n + r.amountCents, 0);
        const amount = unresolved.reduce((n, r) => n + r.amountCents, 0);
        const fits =
          amount <= PAID_CENTS - cents((r) => r.status === "succeeded") - cents((r) => r.status === "failed");
        expect({ refund_again: pass.refund_again, resolve_outside: pass.resolve_outside }).toEqual({
          refund_again: fits,
          resolve_outside: true,
        });
      }
    }
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
  // Booked, the refund fails later; refund again is refused by the judge
  // (refund_failed: the failed amount does not come back), so it is
  // resolved outside.
  [[
    step("approve"), step("answer", 0), step("stripe_change"), step("refund_again"),
    step("answer", 0), step("stripe_change"), step("resolve_outside"),
  ]],
  // Pending, then a webhook says succeeded: the snapshot books.
  [[step("approve"), step("answer", 1), step("stripe_change", 0), step("redeliver")]],
  // 5xx while Stripe did make the refund: found by metadata on the next snapshot.
  [[step("approve"), step("answer", 4, 2), step("redeliver")]],
  // 5xx while Stripe made a pending refund, then 24 hours: the recheck's list
  // finds it, so the disposition waits on it instead of going to a person.
  [[step("approve"), step("answer", 4, 1), step("await_tick", 1)]],
  // Reject, ask again, 5xx with nothing made, 24 hours, retry, attempts used
  // up, send back, approve, already refunded elsewhere, resolved outside on
  // the refunding lot.
  [[
    step("reject"), step("ask"), step("approve"), step("answer", 4, 0), step("await_tick", 1),
    step("retry"), step("answer", 5), step("send_back"), step("approve"), step("answer", 6),
    step("resolve_outside"),
  ]],
  // Timeout, lease handed on and the old holder late, 5xx with nothing made,
  // 24 hours, an external partial refund, settled on purpose short.
  [[
    step("approve"), step("answer", 3), step("claim_late"), step("answer", 4, 0),
    step("await_tick", 1), step("external", 1, 0), step("settle", 0, 0, { acceptPartial: true, notify: false }),
  ]],
  // The approval's first answer is a failed refund: sent back (E6 under
  // started), then resolved outside on the refund_pending lot.
  [[step("approve"), step("answer", 2), step("resolve_outside")]],
  // An external refund in flight holds the approval back (E3) until it settles.
  [[
    step("approve"), step("external", 0, 99), step("answer", 0), step("stripe_change", 0),
    step("redeliver"),
  ]],
  // Settled short on purpose; the refund it was booked on fails later; refund
  // again for that amount, which Stripe can still refund, succeeds.
  [[
    step("external", 1, 499), step("settle", 0, 0, { acceptPartial: true, notify: false }),
    step("stripe_change", 0, 0), step("refund_again"), step("answer", 0),
  ]],
  // The approval's refund goes from pending straight to failed: retry has
  // nothing Stripe will refund (refund_failed); resolved outside books the lot.
  [[step("approve"), step("answer", 1), step("stripe_change", 1), step("resolve_outside")]],
  // A failed refund made outside used up the payment before any approval:
  // resolved outside books the lot and answers for it.
  [[step("external", 2, 1079), step("resolve_outside")]],
  // The same Idempotency-Key again — while the lease is held, then after the
  // disposition finished — and the same key on another lot.
  [[
    step("approve"), step("repeat_key"), step("key_other_target"), step("answer", 0),
    step("repeat_key"), step("key_other_target"),
  ]],
];

describe("random disposition sequences on one lot (§9 invariants)", () => {
  it("keeps every invariant after every step", async () => {
    const tally = new Map<string, number>();
    // A real loop tick must see only this run's lot: no daily reconcile, and
    // what earlier runs and suites left in flight parked.
    await markReconcileJustFinished(suite.sql);
    await fc.assert(
      fc.asyncProperty(fc.array(choiceArb, { minLength: 4, maxLength: 16 }), async (choices) => {
        await parkInFlightOperations(suite.sql);
        const lot = await seedRefundLot(suite.sql, "refund_pending");
        const h = new Harness(lot, tally);
        Object.assign(stripeReads, {
          paymentId: lot.paymentId,
          paymentIntentId: lot.paymentIntentId,
          list: () => h.list(),
          create: (input: CreateInput) => h.create(input),
        });
        for (const c of choices) {
          const v = await view(lot);
          const enabled = await h.enabled(v, c);
          if (enabled.length === 0) continue;
          const action = enabled.includes(c.want) ? c.want : enabled[c.pick % enabled.length]!;
          const before = await counts(lot);
          const awaitingBefore = v.inflight?.status === "awaiting_stripe";
          const did = await h.run(action, v, c);
          await h.check(before, did, awaitingBefore, v.lifecycle);
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
      "answer:E9", "exhausted:attempts_exhausted", "repeat_key", "key_other_target",
    ]) {
      expect(tally.get(name) ?? 0, name).toBeGreaterThan(0);
    }
  });
});
