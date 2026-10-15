// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Random sequences of dispositions, Stripe answers and Stripe-side changes
 * on one lot, with the §9 invariants checked after every step (inner#1410
 * v9), on real Postgres.
 *
 * The harness plays three parts:
 *
 * - **the back office and the endpoints**: an E1 is only issued when the
 *   production judges (`assessRefundCreate`, `assessOneShot`) pass it
 *   against Stripe's current state, read the way the endpoint reads it (the
 *   unresolved failed refunds from the view `credit_refunds_unresolved_failed`
 *   through `listUnresolvedFailed`), and, as the endpoint does, it
 *   first hands Stripe's list to `applyRefundSnapshot` in the same
 *   transaction. restore_credits goes through the endpoint's service
 *   (`requestOneShot`) itself, which reads the refunds and the charge's
 *   `disputed` from Stripe on its own: it is sent whenever the lot is in a
 *   state it names, and must succeed exactly when the judge passes and
 *   otherwise refuse with the judge's code. The harness also repeats an
 *   earlier request's Idempotency-Key, and reuses one on another target,
 *   through the endpoint's service (§4.6);
 * - **the executor and the loop**: a started disposition gets one of the
 *   §5.4 answers, classified here from the fake Stripe's state — a first
 *   request (`attempt_count = 0`) refused with 400 or answered 401/403/404 is
 *   E6, the same answer later is E17 — and passed to `transitionOperation`
 *   with its lease; leases run out, the loop takes them over (E13), and the
 *   old executor wakes with its stale row and runs `executeRefund`, then the
 *   old holder answers late. The two steps that can end a disposition
 *   without Stripe's refund run the production code itself: the awaiting
 *   lookup is a real loop tick (`runRefundLoopOnce`: recheck, snapshot, E12),
 *   and the answer "attempts used up" claims the row and runs
 *   `executeRefund` (E11, whose reason production takes from the event rows);
 * - **Stripe**: the stateful fake (`fake-stripe-refunds.ts`) injected at
 *   `@server/infra/stripe.js`, re-registered with this harness's refunds
 *   after every change, so every production read goes through the real
 *   `stripe-refunds.ts`. Refunds are created at most once per disposition,
 *   change status on their own (including succeeded → failed), appear from
 *   outside the product, and every change is delivered as a snapshot (a
 *   webhook). As measured in test mode (§5.2), once the payment has a
 *   `failed` refund Stripe refuses every create with a first-request 400;
 *   a disputed charge is refused the same way (§10). Production itself never
 *   calls `refunds.create` here — the harness answers for Stripe — so any
 *   recorded create fails the run.
 *
 * After each step (§9):
 *
 * 1. at most one `started` or `awaiting_stripe` disposition;
 * 2. a `refunding` lot has one in flight, or its latest disposition is an
 *    open `needs_attention`;
 * 3. at most one `refund` and at most one `refund_reversed` ledger row; a
 *    `refunded` lot has its `refund` row and no `refund_reversed` one, holds
 *    0, and gets no ledger row after it was booked; a `refund_reversed` row
 *    is the negation of the `refund` row (0 when there is none); the
 *    balance equals the ledger sum; one `refund_rejected` row per rejection;
 * 4. no `refund_pending` (nor anything after it) once the lot has a
 *    `refund_reversed` row;
 * 5. every disposition finished `refunded` (approve, retry, settle) was
 *    booked on a succeeded sum of at least what was paid — no exemption;
 * 6. no Stripe create after a failed refund on the payment: production made
 *    no create call, and no approve or retry was let in while Stripe held a
 *    failed refund;
 * 7. every `restored` disposition: at that moment Stripe held no succeeded
 *    refund, the lot had no `resolved_outside` disposition, the charge was
 *    not disputed; the lot is `active`; the refunds it answered for are
 *    resolved by it;
 * 8. every `sent_back` disposition has no earlier `stripe_declined` one;
 * 9. the views agree with an independent SQL: `credit_refunds_unresolved_failed`
 *    (and `listUnresolvedFailed`) with the §5.3 definition, and
 *    `credit_lot_refund_failures` with "an unresolved failed refund, or
 *    refunding with nothing in flight and a `stripe_declined` disposition";
 * 10. across each E6 under `started` the lot row is unchanged, and the
 *    reason is `stripe_refund_failed_later` when the copy ever succeeded,
 *    `stripe_request_invalid` for a first-request 401/403/404,
 *    `stripe_declined` otherwise; an E11 is `stripe_declined` exactly when
 *    the harness answered this disposition with a refusal before;
 * 11. exactly one `auto` mail and one bell per disposition finished
 *    `rejected`, `restored`, or `refunded` with notify, of the matching
 *    kinds; none for any other;
 * 12. the event rows grew by exactly the transitions taken: one per
 *    `transitionOperation` call, one per awaiting disposition re-judged by a
 *    snapshot, one per needs_attention closed; every disposition starts with
 *    one `requested` row from no status;
 * 13. `ever_succeeded` is true for every refund ever delivered as succeeded,
 *    and never turns back;
 * 14. `refund_requested_at` changes only on the buyer's ask (L1);
 * 15. a step that booked the lot answered for every copy then `failed` or
 *    `canceled` (§5.5);
 * 16. with nothing in flight and nothing processing on Stripe: a
 *    `refunding` or `refund_pending` lot passes resolve_outside; an open
 *    needs_attention has an exit (settle, send_back, retry,
 *    resolve_outside or restore_credits); a lot with an unresolved failed
 *    refund passes resolve_outside, and restore_credits too when Stripe holds
 *    no succeeded refund, the lot was never resolved outside and the charge
 *    is not disputed;
 * 17. a repeated Idempotency-Key replays the disposition it made (or is
 *    `request_in_progress` while its lease is held) and the same key on
 *    another target is `idempotency_key_reused`; neither writes anything;
 * 18. a disposition in `needs_attention` for `attempts_exhausted` or
 *    `stripe_result_unknown` has no refund on Stripe carrying its id: E11 and
 *    E12 only follow a list read that holds none.
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

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t, type CreditLotEntity } from "@breatic/shared";
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
  type StripeFailure,
} from "@server/modules/credit-refund/operation-transitions.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import { runRefundLoopOnce } from "@server/modules/credit-refund/refund-loop.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { RefundRefusal } from "@server/modules/credit-refund/refusal.js";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";
import { listUnresolvedFailed } from "@server/modules/credit-refund/unresolved.repo.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import {
  PAID_CENTS,
  eventsOf,
  inFailureList,
  inTx,
  markReconcileJustFinished,
  parkInFlightOperations,
  refundObject,
  reId,
  seedRefundLot,
  unresolvedViewOf,
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
  "resolve_outside",
  "restore_credits",
  "answer",
  "claim_late",
  "await_tick",
  "await_read_failed",
  "external",
  "stripe_change",
  "redeliver",
  "dispute",
  "ask",
  "repeat_key",
  "key_other_target",
] as const;
type Action = (typeof ACTIONS)[number];

/** The answers a started disposition can get (`variant % ANSWERS`). */
const ANSWERS = 11;

interface Choice {
  /** Taken when enabled; otherwise `pick` chooses among the enabled ones. */
  want: Action;
  pick: number;
  variant: number;
  amount: number;
  notify: boolean;
}

/** One refund as Stripe holds it. */
interface HeldRefund {
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
  settled_succeeded_cents: number | null;
  attempt_count: number;
}

interface View {
  lifecycle: string;
  /** `refund_requested_at` as Postgres text, null when empty. */
  requestedAt: string | null;
  ops: OpView[];
  inflight: OpView | undefined;
  latest: OpView | undefined;
  /** The §5.3 definition, written out independently of the code under test. */
  unresolved: { id: string; amount: number }[];
}

/** The lot as production reads it inside a write, after the snapshot. */
interface Facts {
  lot: CreditLotEntity;
  ledgerSum: number;
  ops: CreditRefundOperation[];
  refunds: RefundCopy[];
  /** The copies the view lists as unresolved failed refunds. */
  unresolved: RefundCopy[];
}

/** The seven kinds an operator can request, and whether the judges pass each now. */
type Verdicts = Record<OpKind, boolean>;

/** What a step did, for the counters. */
interface StepResult {
  /** Direct `transitionOperation` calls (and endpoint E1s). */
  direct: number;
  /** Whether Stripe's list was delivered (a snapshot that may re-judge an awaiting disposition). */
  snapshot: boolean;
  /** Whether the buyer's ask went through (L1). */
  asked?: boolean;
}

/** What Stripe and the lot held when a restore_credits went through (§9). */
interface RestoreFacts {
  succeededOnStripe: boolean;
  disputed: boolean;
  resolvedOutsideBefore: boolean;
}

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
  const [l] = await sql<{ lifecycle: string; requested_at: string | null }[]>`
    SELECT lifecycle, refund_requested_at::text AS requested_at FROM credit_lots WHERE id = ${lot.lotId}
  `;
  const ops = await sql<(Omit<OpView, "settled_succeeded_cents"> & { settled_succeeded_cents: string | null })[]>`
    SELECT id, kind, status, result, notify, attention_closed_at IS NULL AS open,
           attention_reason, lease_token, stripe_refund_id, confirmed_refund_ids,
           failed_refund_ids, settled_succeeded_cents::text AS settled_succeeded_cents,
           attempt_count
    FROM credit_refund_operations WHERE lot_id = ${lot.lotId}
    ORDER BY created_at, id
  `;
  const typed = ops.map((o) => ({
    ...o,
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
    requestedAt: l!.requested_at,
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

/**
 * The lot's whole row, for "unchanged" comparisons.
 * @param lot - The lot.
 * @returns The row as JSON.
 */
async function lotRow(lot: SeededLot): Promise<Record<string, unknown>> {
  const [row] = await suite.sql<{ j: Record<string, unknown> }[]>`
    SELECT to_jsonb(l) AS j FROM credit_lots l WHERE l.id = ${lot.lotId}
  `;
  return row!.j;
}

const isOpen = (r: { status: string }) => r.status === "pending" || r.status === "requires_action";
const sumWhere = (rs: HeldRefund[], f: (r: HeldRefund) => boolean) =>
  rs.filter(f).reduce((n, r) => n + r.amount, 0);
const inFlight = (o: { status: string }) => o.status === "started" || o.status === "awaiting_stripe";

/** What Stripe allows a refund to become next. */
const NEXT: Partial<Record<RefundStatus, RefundStatus[]>> = {
  pending: ["succeeded", "failed", "canceled", "requires_action"],
  requires_action: ["succeeded", "canceled"],
  succeeded: ["failed"],
};

/**
 * Whether a create answer is a Stripe refusal (§5.4), written out here
 * independently of `isStripeRefusal`: HTTP 400 whose code is not
 * rate_limit / lock_timeout / charge_already_refunded, type not
 * idempotency_error, and no `Stripe-Should-Retry: true`.
 * @param f - The failure the harness answered with.
 * @returns True for a refusal.
 */
function isRefusal(f: StripeFailure): boolean {
  return (
    f.httpStatus === 400 &&
    !["rate_limit", "lock_timeout", "charge_already_refunded"].includes(f.code ?? "") &&
    f.type !== "idempotency_error" &&
    f.shouldRetry !== true
  );
}

/** One run's harness state and tallies. */
class Harness {
  readonly stripe: HeldRefund[] = [];
  readonly everSucceeded = new Set<string>();
  everTrue = new Set<string>();
  /** Whether the charge is disputed on Stripe (never goes back). */
  disputed = false;
  /** Ledger rows when the lot was booked; nothing may follow while it stays refunded. */
  rowsAtBooking: number | null = null;
  /** Every Idempotency-Key this run's dispositions were made under. */
  readonly keys: { key: string; kind: OpKind }[] = [];
  /** approve / retry let in while Stripe held a failed refund (must stay empty). */
  readonly createdAfterFailure: string[] = [];
  /** Dispositions the harness answered with a Stripe refusal (for E11's reason). */
  readonly refused = new Set<string>();
  /** What held when each restore_credits went through. */
  readonly restores = new Map<string, RestoreFacts>();

  constructor(
    readonly lot: SeededLot,
    readonly tally: Map<string, number>,
  ) {}

  /** @returns Stripe's list, as `refunds.list` would give it. */
  list() {
    return this.stripe.map((r) => refundObject(r.id, r.status, r.amount, r.opId));
  }

  /** Hand the fake Stripe this harness's refunds, so production reads see them. */
  sync(): void {
    fakeStripe.register(this.lot.paymentIntentId, PAID_CENTS, this.list());
  }

  /**
   * A refund appears on Stripe.
   * @param r - The refund.
   */
  add(r: HeldRefund): void {
    this.stripe.push(r);
    this.sync();
  }

  /**
   * Deliver Stripe's list inside `tx`.
   * @param tx - The transaction.
   */
  async snapshot(tx: DbTx): Promise<void> {
    this.noteSucceeded();
    await applyRefundSnapshot(tx, this.lot.paymentId, this.list(), "request");
  }

  /** Note every refund the next read will see as succeeded (check 13). */
  noteSucceeded(): void {
    for (const r of this.stripe) if (r.status === "succeeded") this.everSucceeded.add(r.id);
  }

  count(name: string): void {
    this.tally.set(name, (this.tally.get(name) ?? 0) + 1);
  }

  /**
   * What a create without `amount` refunds: "the remaining, unrefunded
   * amount", paid less what succeeded or is still processing.
   * @returns Cents.
   */
  unrefunded(): number {
    return PAID_CENTS - sumWhere(this.stripe, (r) => r.status === "succeeded" || isOpen(r));
  }

  /**
   * Stripe's answer to a create on this payment before it makes anything:
   * a first-request 400 once a refund has failed (§5.2, measured), or on a
   * disputed charge (§10); null when Stripe would go ahead.
   * @returns The refusal, or null.
   */
  createRefusal(): StripeFailure | null {
    if (this.stripe.some((r) => r.status === "failed")) {
      return failure(400, { type: "invalid_request_error" });
    }
    if (this.disputed) return failure(400, { type: "invalid_request_error", code: "charge_disputed" });
    return null;
  }

  /**
   * The facts a write request judges on: Stripe's list copied in, then the
   * lot, its ledger sum, its dispositions, its payment's copies and the
   * view's unresolved failed refunds — as the endpoint reads them — in a
   * transaction that is rolled back.
   * @returns The facts.
   */
  async facts(): Promise<Facts> {
    let read: Facts | undefined;
    try {
      await db.transaction(async (tx) => {
        await applyRefundSnapshot(tx, this.lot.paymentId, this.list(), "request");
        const lot = (await creditLotRepo.lockLot(this.lot.lotId, tx))!;
        const { ledgerSum } = await creditLotRepo.readRefundFacts(this.lot.lotId, tx);
        const refunds = await refundCopyRepo.listForPayment(this.lot.paymentId, tx);
        const unresolvedIds = new Set(
          (await listUnresolvedFailed(this.lot.lotId, tx)).map((r) => r.stripeRefundId),
        );
        read = {
          lot,
          ledgerSum: Number(ledgerSum),
          ops: await operationRepo.listForLot(this.lot.lotId, tx),
          refunds,
          unresolved: refunds.filter((r) => unresolvedIds.has(r.stripeRefundId)),
        };
        throw new ReadOnly();
      });
    } catch (err) {
      if (!(err instanceof ReadOnly)) throw err;
    }
    return read!;
  }

  /**
   * The production judge of a one-shot kind on these facts, with what the
   * confirmation page would send back for them.
   * @param kind - The one-shot kind.
   * @param f - The facts.
   * @returns The judge's answer.
   */
  judgeOneShot(kind: Exclude<OpKind, "approve" | "retry">, f: Facts): ReturnType<typeof assessOneShot> {
    const succeededCents = f.refunds
      .filter((r) => r.status === "succeeded")
      .reduce((n, r) => n + r.amountCents, 0);
    return assessOneShot({
      kind,
      lot: { lifecycle: f.lot.lifecycle, remainingCredits: Number(f.lot.remainingCredits) },
      paidCents: PAID_CENTS,
      ops: f.ops,
      refunds: f.refunds,
      unresolvedFailedRefunds: f.unresolved,
      disputed: this.disputed,
      confirmedSucceededCents: succeededCents,
      failedRefundIds: f.unresolved.map((r) => r.stripeRefundId),
    });
  }

  /**
   * Whether the production judges pass each kind now, with what the
   * confirmation page would send back for these facts.
   * @param f - The facts.
   * @returns One verdict per kind.
   */
  verdicts(f: Facts): Verdicts {
    const lifecycle = f.lot.lifecycle;
    const remainingCredits = Number(f.lot.remainingCredits);
    const succeeded = f.refunds.filter((r) => r.status === "succeeded");
    const create = (kind: "approve" | "retry") =>
      assessRefundCreate({
        kind,
        lot: { lifecycle, remainingCredits, ledgerSum: f.ledgerSum },
        payment: { status: "completed", stripePaymentIntentId: this.lot.paymentIntentId, paidCents: PAID_CENTS },
        ops: f.ops,
        refunds: f.refunds,
        confirmedRefundIds: succeeded.map((r) => r.stripeRefundId),
      }).outcome === "create_refund";
    const oneShot = (kind: Exclude<OpKind, "approve" | "retry">) =>
      this.judgeOneShot(kind, f).outcome === "proceed";
    return {
      approve: create("approve"),
      retry: create("retry"),
      reject: oneShot("reject"),
      settle: oneShot("settle"),
      send_back: oneShot("send_back"),
      resolve_outside: oneShot("resolve_outside"),
      restore_credits: oneShot("restore_credits"),
    };
  }

  /**
   * The actions whose preconditions hold now: five requests as the
   * production judges decide them; restore_credits whenever the lot is in a
   * state it names and nothing is in flight (the endpoint then decides);
   * the rest from the harness's own state.
   * @param v - The current view.
   * @returns Enabled actions.
   */
  async enabled(v: View): Promise<Action[]> {
    const { restore_credits: _judgedByEndpoint, ...judged } = this.verdicts(await this.facts());
    const noFailure = !this.stripe.some((r) => r.status === "failed");
    const on: Record<Action, boolean> = {
      ...judged,
      restore_credits:
        v.inflight === undefined && ["refunded", "refunding", "refund_pending"].includes(v.lifecycle),
      answer: v.inflight?.status === "started",
      claim_late: v.inflight?.status === "started",
      await_tick: v.inflight?.status === "awaiting_stripe" && v.inflight.stripe_refund_id === null,
      await_read_failed: v.inflight?.status === "awaiting_stripe",
      // Stripe refuses any refund once one failed, and on a disputed charge.
      external: noFailure && !this.disputed && this.unrefunded() > 0,
      stripe_change: this.stripe.some((r) => NEXT[r.status] !== undefined),
      redeliver: this.stripe.length > 0,
      dispute: !this.disputed,
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
      kind === "approve" || kind === "retry" ? requestRefund(kind, req, {}) : requestOneShot(kind, req, {});
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
   * @returns What the step did.
   */
  async run(action: Action, v: View, c: Choice): Promise<StepResult> {
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
      case "retry": {
        const failedOnStripe = this.stripe.some((r) => r.status === "failed");
        const op = await e1(create(action, { confirmedRefundIds: succeededIds }));
        if (failedOnStripe) this.createdAfterFailure.push(op.id);
        return { direct: 1, snapshot: true };
      }
      case "reject":
      case "send_back":
        await e1(create(action, {}));
        return { direct: 1, snapshot: true };
      case "settle":
        await e1(create("settle", { notify: c.notify, confirmedSucceededCents: succ }));
        return { direct: 1, snapshot: true };
      case "resolve_outside":
        await e1(
          create("resolve_outside", { failedRefundIds: v.unresolved.map((u) => u.id), confirmedSucceededCents: succ }),
        );
        return { direct: 1, snapshot: true };
      case "restore_credits":
        return this.restore(v);
      case "answer":
        return this.answer(v.inflight!, c);
      case "claim_late": {
        // The lease runs out and the loop takes the row over (E13). The old
        // executor then wakes with its stale row and runs production's
        // attempt: it must not reach refunds.create (checked after every
        // step), and anything it writes is a late answer. Then the old
        // holder answers late.
        const op = v.inflight!;
        const stale = (await operationRepo.findById(op.id))!;
        await suite.sql`
          UPDATE credit_refund_operations SET locked_until = now() - interval '1 second'
          WHERE id = ${op.id}
        `;
        await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13", actor: "loop" }));
        const eventsBefore = (await eventsOf(suite.sql, op.id)).length;
        await executeRefund(stale, "loop");
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
        const status = (["pending", "succeeded", "failed"] as const)[c.variant % 3]!;
        this.add({ id: reId("ext"), amount: 1 + (c.amount % this.unrefunded()), status });
        await inTx((tx) => this.snapshot(tx));
        return { direct: 0, snapshot: true };
      }
      case "stripe_change": {
        const changeable = this.stripe.filter((r) => NEXT[r.status] !== undefined);
        const r = changeable[c.amount % changeable.length]!;
        const nexts = NEXT[r.status]!;
        r.status = nexts[c.variant % nexts.length]!;
        this.sync();
        await inTx((tx) => this.snapshot(tx));
        return { direct: 0, snapshot: true };
      }
      case "redeliver":
        await inTx((tx) => this.snapshot(tx));
        return { direct: 0, snapshot: true };
      case "dispute":
        // The buyer disputes the charge with the bank; the product reads it
        // only when it asks Stripe (restore, preview), and Stripe refuses
        // refunds on it from now on.
        this.disputed = true;
        fakeStripe.setDisputed(lot.paymentIntentId, true);
        return { direct: 0, snapshot: false };
      case "ask": {
        const ask = () => creditLotService.requestRefund({ lotId: lot.lotId, requestingUserId: lot.userId });
        if (this.restores.size > 0) {
          // §5.3, §6.3 L1: a lot whose credits were restored takes no new ask.
          await expect(ask()).rejects.toMatchObject({
            statusCode: 409,
            message: t("server.credit.refund_restored"),
          });
          this.count("ask:refused_restored");
          return { direct: 0, snapshot: false, asked: false };
        }
        await ask();
        return { direct: 0, snapshot: false, asked: true };
      }
      case "repeat_key":
      case "key_other_target":
        await this.reuseKey(c, action === "key_other_target");
        return { direct: 0, snapshot: false };
    }
  }

  /**
   * restore_credits through the endpoint's service, which reads Stripe's
   * refunds and the charge's `disputed` itself. It must go through exactly
   * when the production judge passes on the same facts, and otherwise answer
   * the judge's refusal, storing nothing.
   * @param v - The view before it.
   * @returns What the step did.
   */
  private async restore(v: View): Promise<StepResult> {
    const f = await this.facts();
    const verdict = this.judgeOneShot("restore_credits", f);
    const key = `model-${randomUUID()}`;
    const facts: RestoreFacts = {
      succeededOnStripe: this.stripe.some((r) => r.status === "succeeded"),
      disputed: this.disputed,
      resolvedOutsideBefore: v.ops.some((o) => o.result === "resolved_outside"),
    };
    this.noteSucceeded();
    const sent = requestOneShot(
      "restore_credits",
      { lotId: this.lot.lotId, adminId: "admin_model", key, hash: REQUEST_HASH, reason: "model restore_credits" },
      { failedRefundIds: f.unresolved.map((r) => r.stripeRefundId) },
    );
    if (verdict.outcome === "proceed") {
      const answer = await sent;
      const id = (answer.body as { id: string }).id;
      expect(answer.body).toMatchObject({ kind: "restore_credits", status: "succeeded", result: "restored" });
      this.keys.push({ key, kind: "restore_credits" });
      this.restores.set(id, facts);
      this.count("restore_credits:restored");
      await this.mailSent(id);
      return { direct: 1, snapshot: true };
    }
    const refused = await sent.then(() => null, (err: unknown) => err);
    const reason = "reason" in verdict ? verdict.reason : undefined;
    expect(refused).toBeInstanceOf(RefundRefusal);
    expect(refused).toMatchObject({ status: 409, code: verdict.code, reason });
    this.count(`restore_refused:${reason ?? verdict.code}`);
    return { direct: 0, snapshot: true };
  }

  /**
   * Wait until the disposition's auto mail, sent in the background right
   * after the request commits, has left `pending` and `sending`, so the next
   * step does not race its write-back.
   * @param opId - The disposition.
   */
  private async mailSent(opId: string): Promise<void> {
    await vi.waitFor(
      async () => {
        const rows = await suite.sql<{ status: string }[]>`
          SELECT status FROM refund_mail_outbox WHERE operation_id = ${opId} AND origin = 'auto'
        `;
        expect(rows.filter((r) => r.status === "pending" || r.status === "sending")).toEqual([]);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  /**
   * An E6 on a started disposition (§6.2, §9): the lot row is the same
   * before and after, and the disposition lands in needs_attention with the
   * reason the rule gives.
   * @param op - The started disposition.
   * @param event - The E6.
   * @param expected - The reason the rule gives.
   * @param withSnapshot - Deliver Stripe's list in the same transaction first.
   * @returns One direct call.
   */
  private async declined(
    op: OpView,
    event: OperationEvent,
    expected: "stripe_declined" | "stripe_request_invalid" | "stripe_refund_failed_later",
    withSnapshot: boolean,
  ): Promise<StepResult> {
    const before = await lotRow(this.lot);
    await inTx(async (tx) => {
      if (withSnapshot) await this.snapshot(tx);
      await transitionOperation(tx, { id: op.id }, event);
    });
    expect(await lotRow(this.lot)).toEqual(before);
    const [row] = await suite.sql<{ status: string; attention_reason: string | null }[]>`
      SELECT status, attention_reason FROM credit_refund_operations WHERE id = ${op.id}
    `;
    expect(row).toEqual({ status: "needs_attention", attention_reason: expected });
    this.count(`answer:E6:${expected}`);
    return { direct: 1, snapshot: false };
  }

  /**
   * A create answer that made nothing: E6 on the first request, E17 after.
   * @param op - The started disposition.
   * @param fail - Stripe's answer.
   * @returns One direct call.
   */
  private async nothingMade(op: OpView, fail: StripeFailure): Promise<StepResult> {
    const lease = op.lease_token!;
    if (op.attempt_count === 0) {
      const invalid = fail.httpStatus === 401 || fail.httpStatus === 403 || fail.httpStatus === 404;
      return this.declined(
        op,
        { type: "E6", failure: fail, leaseToken: lease, actor: "loop" },
        invalid ? "stripe_request_invalid" : "stripe_declined",
        false,
      );
    }
    if (isRefusal(fail)) this.refused.add(op.id);
    this.count(isRefusal(fail) ? "answer:E17:refusal" : "answer:E17");
    await inTx((tx) =>
      transitionOperation(tx, { id: op.id }, { type: "E17", failure: fail, leaseToken: lease, actor: "loop" }),
    );
    return { direct: 1, snapshot: false };
  }

  /**
   * The executor's phase 2 and 3 for a started disposition.
   * @param op - The started disposition.
   * @param c - The step's choice.
   * @returns The direct calls made: one, or resumeExhausted's two for
   *   variant 5; the snapshot is in the same transaction.
   */
  private async answer(op: OpView, c: Choice): Promise<StepResult> {
    const variant = c.variant % ANSWERS;
    if (variant === 5) return this.resumeExhausted(op);
    const lease = op.lease_token!;
    const own = this.stripe.find((r) => r.opId === op.id);

    if (variant <= 2 || ((variant === 9 || variant === 10) && own)) {
      let refund = own;
      if (!refund) {
        const refusal = this.createRefusal();
        if (refusal) return this.nothingMade(op, refusal);
        const amount = this.unrefunded();
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
        refund = { id: reId("own"), amount, status: (["succeeded", "pending", "failed"] as const)[variant % 3]!, opId: op.id };
        this.add(refund);
      }
      const object = refundObject(refund.id, refund.status, refund.amount, op.id);
      const event = this.classify(op, refund, object);
      if (event.type === "E6") {
        // The copy has ever succeeded exactly when a delivery saw it succeeded.
        return this.declined(
          op,
          { ...event, leaseToken: lease },
          this.everSucceeded.has(refund.id) ? "stripe_refund_failed_later" : "stripe_declined",
          true,
        );
      }
      this.count(`answer:${event.type}`);
      await inTx(async (tx) => {
        await this.snapshot(tx);
        await transitionOperation(tx, { id: op.id }, { ...event, leaseToken: lease });
      });
      return { direct: 1, snapshot: false };
    }

    if (variant === 9) {
      // Stripe refuses this refund with a 400 (§5.4): a first request is E6
      // stripe_declined, a later one E17 that E11 will count.
      return this.nothingMade(op, this.createRefusal() ?? failure(400, { code: "parameter_invalid" }));
    }
    if (variant === 10) {
      // Our key, permission or payment id is wrong: Stripe did not execute.
      const httpStatus = ([401, 403, 404] as const)[c.amount % 3]!;
      return this.nothingMade(
        op,
        failure(httpStatus, { type: httpStatus === 404 ? "invalid_request_error" : "authentication_error" }),
      );
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
      const amount = this.unrefunded();
      if (made > 0 && amount > 0 && !own && this.createRefusal() === null) {
        this.add({ id: reId("own_5xx"), amount, status: made === 1 ? "pending" : "succeeded", opId: op.id });
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
   * finding none, ending it with E11, `stripe_declined` when one of its
   * create answers was a Stripe refusal and `attempts_exhausted` otherwise
   * (v9 §5.4, §6.2). It never creates.
   * @param op - The started disposition.
   * @returns E13 and the attempt's one cell.
   */
  private async resumeExhausted(op: OpView): Promise<StepResult> {
    await suite.sql`
      UPDATE credit_refund_operations
      SET locked_until = now() - interval '1 second',
          attempt_count = ${getCreditRefundConfig().maxAttempts},
          first_called_at = coalesce(first_called_at, now())
      WHERE id = ${op.id}
    `;
    const claimed = await inTx((tx) => transitionOperation(tx, { id: op.id }, { type: "E13", actor: "loop" }));
    this.noteSucceeded();
    await executeRefund(claimed!, "loop");
    const last = (await eventsOf(suite.sql, op.id)).at(-1)!.event;
    if (last === "attempts_exhausted") {
      const [row] = await suite.sql<{ attention_reason: string | null }[]>`
        SELECT attention_reason FROM credit_refund_operations WHERE id = ${op.id}
      `;
      const expected = this.refused.has(op.id) ? "stripe_declined" : "attempts_exhausted";
      expect(row!.attention_reason).toBe(expected);
      this.count(`exhausted:${expected}`);
    } else {
      this.count(`exhausted:${last}`);
    }
    return { direct: 2, snapshot: false };
  }

  /**
   * §5.4 for a refund object of approve or retry: E2 … E6, by the settle rule.
   */
  private classify(
    op: OpView,
    refund: HeldRefund,
    object: ReturnType<typeof refundObject>,
  ): OperationEvent {
    if (refund.status === "pending" || refund.status === "requires_action") {
      return { type: "E5", refund: object, actor: "loop" };
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      return { type: "E6", refund: object, actor: "loop" };
    }
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
   * @param awaitingBefore - Whether a disposition was awaiting Stripe before it.
   * @param vBefore - The view before it.
   */
  async check(before: Counts, step: StepResult, awaitingBefore: boolean, vBefore: View): Promise<void> {
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

    // 3, 4. Ledger: one refund row and one refund_reversed row at most.
    const [ledger] = await sql<{
      refunds: number;
      reversed: number;
      refund_sum: string;
      reversed_sum: string;
      balanced: boolean;
      remaining: string;
    }[]>`
      SELECT
        (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id AND entry_type = 'refund')::int AS refunds,
        (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id AND entry_type = 'refund_reversed')::int
          AS reversed,
        (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger
           WHERE lot_id = l.id AND entry_type = 'refund')::text AS refund_sum,
        (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger
           WHERE lot_id = l.id AND entry_type = 'refund_reversed')::text AS reversed_sum,
        l.remaining_credits =
          (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE lot_id = l.id) AS balanced,
        l.remaining_credits::text AS remaining
      FROM credit_lots l WHERE l.id = ${lot.lotId}
    `;
    expect(ledger!.refunds).toBeLessThanOrEqual(1);
    expect(ledger!.reversed).toBeLessThanOrEqual(1);
    expect(ledger!.balanced).toBe(true);
    if (v.lifecycle === "refunded") {
      expect({ refunds: ledger!.refunds, reversed: ledger!.reversed }).toEqual({ refunds: 1, reversed: 0 });
      expect(ledger!.remaining).toBe("0.000000");
      this.rowsAtBooking ??= after.ledgerRows;
      expect(after.ledgerRows).toBe(this.rowsAtBooking);
    } else {
      this.rowsAtBooking = null;
    }
    if (ledger!.refunds === 1) expect(v.lifecycle === "refunded" || ledger!.reversed === 1).toBe(true);
    if (ledger!.reversed === 1) {
      expect(Number(ledger!.refund_sum) + Number(ledger!.reversed_sum)).toBe(0);
      expect(["active", "depleted"]).toContain(v.lifecycle);
    }
    const rejected = v.ops.filter((o) => o.result === "rejected").length;
    const [rej] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM credit_ledger
      WHERE lot_id = ${lot.lotId} AND entry_type = 'refund_rejected' AND amount = 0
    `;
    expect(Number(rej!.n)).toBe(rejected);

    // 5. Booked on the whole payment, every time.
    for (const o of v.ops.filter((x) => x.result === "refunded")) {
      expect(o.settled_succeeded_cents!, o.id).toBeGreaterThanOrEqual(PAID_CENTS);
    }

    // 6. No Stripe create after a failed refund; production never creates here.
    expect(fakeStripe.createCalls).toEqual([]);
    expect(this.createdAfterFailure).toEqual([]);

    // 7. Restored only where no money reached the buyer.
    const resolved = await sql<{ id: string; by: string | null }[]>`
      SELECT stripe_refund_id AS id, resolved_by_operation_id AS by FROM credit_refunds
      WHERE lot_id = ${lot.lotId}
    `;
    const by = new Map(resolved.map((r) => [r.id, r.by]));
    for (const o of v.ops.filter((x) => x.result === "restored")) {
      expect(this.restores.get(o.id), o.id).toEqual({
        succeededOnStripe: false,
        disputed: false,
        resolvedOutsideBefore: false,
      });
      expect(v.ops.some((x) => x.result === "resolved_outside")).toBe(false);
      expect(v.lifecycle).toBe("active");
      for (const id of o.failed_refund_ids) expect(by.get(id), id).toBe(o.id);
    }

    // 8. Never sent back once Stripe declined the lot.
    v.ops.forEach((o, i) => {
      if (o.result !== "sent_back") return;
      expect(v.ops.slice(0, i).filter((p) => p.attention_reason === "stripe_declined"), o.id).toEqual([]);
    });

    // 9. The views are the definitions.
    const viewIds = (await unresolvedViewOf(sql, lot.lotId)).map((r) => r.stripe_refund_id);
    expect(viewIds).toEqual(v.unresolved.map((u) => u.id));
    const picked = await inTx(async (tx) => listUnresolvedFailed(lot.lotId, tx));
    expect(picked.map((r) => r.stripeRefundId).sort()).toEqual(v.unresolved.map((u) => u.id));
    const [failures] = await sql<{ expected: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1 FROM credit_refunds r
          WHERE r.payment_id = l.source_id
            AND r.status IN ('failed', 'canceled') AND r.resolved_by_operation_id IS NULL
            AND (l.lifecycle IN ('refund_pending', 'refunding')
                 OR (l.lifecycle = 'refunded' AND r.ever_succeeded)))
        OR (l.lifecycle = 'refunding'
            AND NOT EXISTS (SELECT 1 FROM credit_refund_operations o
                            WHERE o.lot_id = l.id AND o.status IN ('started', 'awaiting_stripe'))
            AND EXISTS (SELECT 1 FROM credit_refund_operations o
                        WHERE o.lot_id = l.id AND o.attention_reason = 'stripe_declined'))
      ) AS expected
      FROM credit_lots l WHERE l.id = ${lot.lotId}
    `;
    expect(await inFailureList(sql, lot.lotId)).toBe(failures!.expected);

    // 11. One auto mail and one bell per telling finish, none otherwise.
    const MAIL_KIND: Record<string, string> = {
      rejected: "refund_rejected",
      restored: "refund_restored",
      refunded: "refund_completed",
    };
    const telling = v.ops.filter(
      (o) => o.result === "rejected" || o.result === "restored" || (o.result === "refunded" && o.notify),
    );
    const mails = await sql<{ operation_id: string; kind: string }[]>`
      SELECT m.operation_id, m.kind FROM refund_mail_outbox m
      JOIN credit_refund_operations o ON o.id = m.operation_id
      WHERE o.lot_id = ${lot.lotId} AND m.origin = 'auto'
    `;
    expect(mails.map((m) => `${m.operation_id}:${m.kind}`).sort()).toEqual(
      telling.map((o) => `${o.id}:${MAIL_KIND[o.result!]}`).sort(),
    );
    const [bells] = await sql<{ completed: number; rejected: number; restored: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE type = 'credit.refund_completed')::int AS completed,
        COUNT(*) FILTER (WHERE type = 'credit.refund_rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE type = 'credit.refund_restored')::int AS restored
      FROM notifications WHERE user_id = ${lot.userId}
    `;
    expect(bells).toEqual({
      completed: telling.filter((o) => o.result === "refunded").length,
      rejected,
      restored: telling.filter((o) => o.result === "restored").length,
    });

    // 12. One event row per transition taken.
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

    // 18. A disposition handed to a person because Stripe's result is not
    //     known, or its attempts ran out, has no refund on Stripe.
    for (const o of v.ops) {
      const unknownResult =
        o.attention_reason === "attempts_exhausted" || o.attention_reason === "stripe_result_unknown";
      if (o.status !== "needs_attention" || !unknownResult) continue;
      expect(this.stripe.filter((r) => r.opId === o.id), o.id).toEqual([]);
    }

    // 13. ever_succeeded: delivered successes are remembered, and memory stays.
    const copies = await sql<{ id: string; ever: boolean }[]>`
      SELECT stripe_refund_id AS id, ever_succeeded AS ever FROM credit_refunds
      WHERE lot_id = ${lot.lotId}
    `;
    const ever = new Map(copies.map((c) => [c.id, c.ever]));
    for (const id of this.everSucceeded) expect(ever.get(id)).toBe(true);
    for (const id of this.everTrue) expect(ever.get(id)).toBe(true);
    this.everTrue = new Set(copies.filter((c) => c.ever).map((c) => c.id));

    // 14. refund_requested_at moves only on the buyer's ask.
    if (step.asked) {
      expect(v.requestedAt).not.toBeNull();
      expect(v.requestedAt).not.toBe(vBefore.requestedAt);
    } else {
      expect(v.requestedAt).toBe(vBefore.requestedAt);
    }

    // 15. A step that booked the lot answered for every copy then failed or canceled.
    if (vBefore.lifecycle !== "refunded" && v.lifecycle === "refunded") {
      const unanswered = await sql<{ id: string }[]>`
        SELECT stripe_refund_id AS id FROM credit_refunds
        WHERE payment_id = ${lot.paymentId} AND status IN ('failed', 'canceled')
          AND resolved_by_operation_id IS NULL
      `;
      expect(unanswered).toEqual([]);
    }

    // 16. Nothing in flight and nothing processing: the exits are open (§9).
    //     Judged on what an endpoint would read now, after Stripe's list.
    const f = await this.facts();
    if (!f.ops.some(inFlight) && !f.refunds.some(isOpen)) {
      const pass = this.verdicts(f);
      const lifecycle = f.lot.lifecycle;
      if (lifecycle === "refunding" || lifecycle === "refund_pending") {
        expect(pass.resolve_outside).toBe(true);
      }
      if (f.ops.some((o) => o.status === "needs_attention" && o.attentionClosedAt === null)) {
        expect(pass.settle || pass.send_back || pass.retry || pass.resolve_outside || pass.restore_credits).toBe(true);
      }
      if (f.unresolved.length > 0) {
        expect(pass.resolve_outside).toBe(true);
        const restorable =
          !f.refunds.some((r) => r.status === "succeeded") &&
          !f.ops.some((o) => o.result === "resolved_outside") &&
          !this.disputed;
        if (restorable) expect(pass.restore_credits).toBe(true);
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
});

/**
 * A step that asks for one action by name.
 * @param want - The action.
 * @param variant - Which answer or change.
 * @param amount - Which refund, how much, or which status code.
 * @param notify - settle's notify.
 * @returns The choice.
 */
function step(want: Action, variant = 0, amount = 0, notify = true): Choice {
  return { want, pick: 0, variant, amount, notify };
}

/**
 * Hand-written runs that walk every exit, so a random draw that misses a
 * path cannot leave it unchecked. Answer variants: 0 succeeded, 1 pending,
 * 2 failed, 3 E7, 4 5xx, 5 attempts used up, 6 E9, 7 E16, 8 E17 402,
 * 9 a 400 refusal, 10 401/403/404 (by amount).
 */
const EXAMPLES: [Choice[]][] = [
  // Booked, the refund fails later; the buyer takes the credits back
  // (refund_reversed of the booked amount); a new ask is refused.
  [[step("approve"), step("answer", 0), step("stripe_change"), step("restore_credits"), step("ask")]],
  // Booked, the refund fails later, resolved outside; restore is then
  // refused for good (paid_outside).
  [[step("approve"), step("answer", 0), step("stripe_change"), step("resolve_outside"), step("restore_credits")]],
  // Pending, then a webhook says succeeded: the snapshot books.
  [[step("approve"), step("answer", 1), step("stripe_change", 0), step("redeliver")]],
  // 5xx while Stripe did make the refund: found by metadata on the next snapshot.
  [[step("approve"), step("answer", 4, 2), step("redeliver")]],
  // 5xx while Stripe made a pending refund, then 24 hours: the recheck's list
  // finds it, so the disposition waits on it instead of going to a person.
  [[step("approve"), step("answer", 4, 1), step("await_tick", 1)]],
  // Reject, ask again, 5xx with nothing made, 24 hours, retry, attempts used
  // up with no refusal, send back, approve, already refunded elsewhere,
  // resolved outside on the refunding lot.
  [[
    step("reject"), step("ask"), step("approve"), step("answer", 4, 0), step("await_tick", 1),
    step("retry"), step("answer", 5), step("send_back"), step("approve"), step("answer", 6),
    step("resolve_outside"),
  ]],
  // Timeout, lease handed on and the old holder late, 5xx with nothing made,
  // 24 hours, an external partial refund; retry refunds the rest and books.
  [[
    step("approve"), step("answer", 3), step("claim_late"), step("answer", 4, 0),
    step("await_tick", 1), step("external", 1, 0), step("retry"), step("answer", 0),
  ]],
  // The approval's refund object fails at once (E6 under started:
  // stripe_declined, lot stays refunding); the buyer takes the credits back.
  [[step("approve"), step("answer", 2), step("restore_credits")]],
  // The same, resolved outside instead: the refunding lot is booked.
  [[step("approve"), step("answer", 2), step("resolve_outside")]],
  // A first-request 400: stripe_declined with no refund made; retry is
  // still let in (no failed refund) and declined again; restore.
  [[step("approve"), step("answer", 9), step("retry"), step("answer", 9), step("restore_credits")]],
  // A first-request 401: stripe_request_invalid; send back is open, then reject.
  [[step("approve"), step("answer", 10, 0), step("send_back"), step("reject")]],
  // A first-request 403 and 404.
  [[step("approve"), step("answer", 10, 1), step("resolve_outside")]],
  [[step("approve"), step("answer", 10, 2), step("retry"), step("answer", 0)]],
  // A timeout, then a 400 refusal on the second request (E17), then the
  // attempts run out: E11 is stripe_declined; restore.
  [[step("approve"), step("answer", 3), step("answer", 9), step("answer", 5), step("restore_credits")]],
  // The buyer disputes the charge: Stripe refuses the approval's refund
  // (E6 stripe_declined); restore is refused (disputed); resolved outside.
  [[step("dispute"), step("approve"), step("answer", 0), step("restore_credits"), step("resolve_outside")]],
  // The approval's refund goes from pending straight to failed
  // (stripe_refund_failed_later); retry is refused (refund_failed); resolved outside.
  [[step("approve"), step("answer", 1), step("stripe_change", 1), step("resolve_outside")]],
  // A failed refund made outside before any approval: approve is refused;
  // the credits are restored on the refund_pending lot; a new ask is refused.
  [[step("external", 2, 1079), step("restore_credits"), step("ask")]],
  // An external refund in flight holds the approval back (E3) until it settles.
  [[
    step("approve"), step("external", 0, 99), step("answer", 0), step("stripe_change", 0),
    step("redeliver"),
  ]],
  // An external refund nobody confirmed (E4 unexpected_external_refund);
  // settled on the whole payment.
  [[step("approve"), step("external", 1, 99), step("answer", 0), step("settle", 0, 0, false)]],
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
        fakeStripe.reset();
        const lot = await seedRefundLot(suite.sql, "refund_pending");
        const h = new Harness(lot, tally);
        h.sync();
        for (const c of choices) {
          const v = await view(lot);
          const enabled = await h.enabled(v);
          if (enabled.length === 0) continue;
          const action = enabled.includes(c.want) ? c.want : enabled[c.pick % enabled.length]!;
          const before = await counts(lot);
          const awaitingBefore = v.inflight?.status === "awaiting_stripe";
          const did = await h.run(action, v, c);
          await h.check(before, did, awaitingBefore, v);
        }
      }),
      { numRuns: 25, examples: EXAMPLES },
    );

    // The hand-written runs reach every disposition kind and the answers
    // that finish them; a refactor of the harness that stops reaching one
    // turns this red instead of quietly checking less.
    for (const name of [
      "approve", "reject", "settle", "send_back", "retry", "resolve_outside",
      "restore_credits:restored", "restore_refused:paid_outside", "restore_refused:disputed",
      "claim_late", "await_tick", "external", "stripe_change", "redeliver", "dispute",
      "ask", "ask:refused_restored",
      "answer:E2", "answer:E3", "answer:E4", "answer:E5", "answer:E7", "answer:E8", "answer:E9",
      "answer:E6:stripe_declined", "answer:E6:stripe_request_invalid", "answer:E17:refusal",
      "exhausted:attempts_exhausted", "exhausted:stripe_declined",
      "repeat_key", "key_other_target",
    ]) {
      expect(tally.get(name) ?? 0, name).toBeGreaterThan(0);
    }
    // Twenty hand-written runs, 25 random ones, and shrinking when one fails
    // outgrow the suite's 120 s; at 120 s a failing run was cut off mid-shrink
    // and reported a timeout instead of its counterexample.
  }, 300_000);
});
