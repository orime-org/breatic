// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Seeding and reading helpers shared by the refund disposition suites
 * (inner#1410 §5, §6, §9). Not a test file: the suites that import it are
 * `credit-refund-op-*.integration.test.ts`, `credit-refund-snapshot.*` and
 * `credit-refund-model.*`.
 *
 * Every row a case starts from is written by SQL here, so a case about one
 * cell of the transition table never depends on another cell having worked.
 * The lot itself is opened by the domain (`grantFromPayment`, then the
 * buyer's ask), so its ledger already sums to its balance.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, inject } from "vitest";
import postgres from "postgres";
import Stripe from "stripe";
import type { Hono } from "hono";
import { db, initCore, loadLocales } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import type { StripePendingReason } from "@server/modules/credit-refund/types.js";
import type { FakeRefundInput, FakeStripeRefunds } from "./fake-stripe-refunds.js";
import { openPaymentSource } from "./payment-source.js";

export type Sql = ReturnType<typeof postgres>;

/** What the buyer paid, tax included: `coalesce(total_cents, amount_cents)`. */
export const PAID_CENTS = 1080;
/** What the payment granted, and what an untouched lot holds. */
export const CREDITS = 880;

/**
 * The `event` column each event of §6.2 writes. One name per event, kept
 * for the cells that leave the status where it was too; E15 is any answer
 * that carries a lease token the row no longer holds.
 */
export const EVENT_NAME = {
  E1: "requested",
  E2: "refund_succeeded",
  E3: "refund_succeeded_others_pending",
  E4: "refund_succeeded_unsettleable",
  E5: "refund_pending",
  E6: "refund_declined",
  E7: "retryable_error",
  E8: "stripe_server_error",
  E9: "charge_already_refunded",
  E10: "refund_not_found",
  E11: "attempts_exhausted",
  E12: "deadline_reached",
  E13: "claimed",
  E14: "attention_closed",
  E15: "late_answer",
  E16: "stripe_read_failed",
  E17: "unclassified_error",
} as const;

/**
 * Register the suite's setup: payments on (placeholder keys reach Stripe
 * zero times — every Stripe answer here is handed in), locales loaded, and a
 * raw SQL client for seeding and reading.
 * @param appName - `application_name` for the suite's connections.
 * @returns A holder whose `sql` is ready inside the suite's tests.
 */
export function useRefundSuite(appName: string): { sql: Sql } {
  const holder = {} as { sql: Sql };
  beforeAll(() => {
    initCore({
      ...process.env,
      PAYMENT_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
      STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    });
    loadLocales();
    holder.sql = postgres(inject("DATABASE_URL"), {
      max: 6,
      prepare: false,
      connection: { application_name: appName },
    });
  });
  afterAll(async () => {
    await holder.sql?.end({ timeout: 1 });
    initCore(process.env);
  });
  return holder;
}


export type LotState = "active" | "refund_pending" | "refunding" | "refunded";

export interface SeededLot {
  userId: string;
  paymentId: string;
  paymentIntentId: string;
  lotId: string;
}

let seq = 0;

/**
 * A buyer, a completed payment of {@link PAID_CENTS} and the lot it opened,
 * moved to `state`: the ask for `refund_pending`, SQL after that. A
 * `refunded` lot gets the `refund` ledger row and zero balance it would have.
 * @param sql - Raw client.
 * @param state - Where the lot should stand.
 * @returns The ids.
 */
export async function seedRefundLot(sql: Sql, state: LotState): Promise<SeededLot> {
  seq += 1;
  const tag = `${Date.now()}-${seq}-${randomUUID().slice(0, 8)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`refund-op-${tag}@example.test`}, true) RETURNING id
  `;
  const sourceId = await openPaymentSource(sql);
  const paymentIntentId = `pi_${tag}`;
  await sql`
    INSERT INTO payments
      (id, user_id, amount_cents, total_cents, currency, status, credits_granted,
       stripe_payment_intent_id)
    VALUES (${sourceId}, ${user!.id}, 1000, ${PAID_CENTS}, 'usd', 'completed', ${CREDITS},
            ${paymentIntentId})
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: sourceId,
    userId: user!.id,
    purchasedCredits: CREDITS,
  });
  const seeded = {
    userId: user!.id,
    paymentId: sourceId,
    paymentIntentId,
    lotId: lot.id,
  };
  if (state === "active") return seeded;
  await creditLotService.requestRefund({ lotId: lot.id, requestingUserId: user!.id });
  if (state === "refunding") {
    await sql`UPDATE credit_lots SET lifecycle = 'refunding' WHERE id = ${lot.id}`;
  } else if (state === "refunded") {
    await sql`
      INSERT INTO credit_ledger (payer_user_id, lot_id, entry_type, amount, reference_id)
      VALUES (${user!.id}, ${lot.id}, 'refund', ${-CREDITS}, ${`re_seeded_${tag}`})
    `;
    await sql`
      UPDATE credit_lots SET remaining_credits = 0, lifecycle = 'refunded' WHERE id = ${lot.id}
    `;
  }
  return seeded;
}

export type OpKind =
  | "approve"
  | "reject"
  | "settle"
  | "send_back"
  | "retry"
  | "resolve_outside"
  | "restore_credits";
export type OpStatus = "started" | "awaiting_stripe" | "succeeded" | "needs_attention";

export interface SeedOp {
  kind: OpKind;
  status: OpStatus;
  result?: "refunded" | "rejected" | "sent_back" | "resolved_outside" | "restored";
  attentionReason?: string;
  stripeRefundId?: string | null;
  notify?: boolean;
  confirmedRefundIds?: string[];
  failedRefundIds?: string[];
  attemptCount?: number;
  /** `first_called_at` this many hours ago; null leaves it empty. */
  firstCalledHoursAgo?: number | null;
  /** `locked_until` in the past (an expired lease) instead of the future. */
  leaseExpired?: boolean;
  /** `created_at` this many seconds ago, to order a lot's dispositions. */
  createdSecondsAgo?: number;
}

/**
 * One disposition row in the given state, as the code would have left it.
 * `started` rows hold a lease; the other states hold none.
 * @param sql - Raw client.
 * @param lot - The lot it belongs to.
 * @param op - Its kind, status and the columns that matter for the case.
 * @returns Its id and lease token.
 */
export async function seedOperation(
  sql: Sql,
  lot: SeededLot,
  op: SeedOp,
): Promise<{ id: string; leaseToken: string | null }> {
  const leaseToken = op.status === "started" ? randomUUID() : null;
  const finished = op.status === "succeeded" || op.status === "needs_attention";
  const notify =
    op.notify ??
    (op.kind === "approve" || op.kind === "retry" || op.kind === "reject");
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO credit_refund_operations
      (lot_id, payment_id, kind, status, result, attention_reason, attention_detail,
       idempotency_key, request_hash, requested_by, reason, notify,
       confirmed_refund_ids, failed_refund_ids,
       stripe_refund_id, first_called_at, attempt_count, next_attempt_at,
       lease_token, locked_until, finished_at, created_at)
    VALUES
      (${lot.lotId}, ${lot.paymentId}, ${op.kind}, ${op.status}, ${op.result ?? null},
       ${op.attentionReason ?? null},
       ${op.attentionReason ? `seeded ${op.attentionReason}` : null},
       ${`seed-${randomUUID()}`}, ${"0".repeat(64)}, ${"admin_seed"}, ${"seeded"}, ${notify},
       string_to_array(${(op.confirmedRefundIds ?? []).join(",")}, ','),
       string_to_array(${(op.failedRefundIds ?? []).join(",")}, ','),
       ${op.stripeRefundId ?? null},
       ${
         op.firstCalledHoursAgo === null || op.firstCalledHoursAgo === undefined
           ? null
           : sql`now() - make_interval(hours => ${op.firstCalledHoursAgo}::int)`
       },
       ${op.attemptCount ?? 0},
       ${finished ? null : sql`now()`},
       ${leaseToken},
       ${
         op.status === "started"
           ? op.leaseExpired
             ? sql`now() - interval '1 second'`
             : sql`now() + interval '120 seconds'`
           : null
       },
       ${finished ? sql`now()` : null},
       now() - make_interval(secs => ${op.createdSecondsAgo ?? 0}::double precision))
    RETURNING id
  `;
  return { id: row!.id, leaseToken };
}

export type RefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";

export interface SeedCopy {
  id: string;
  amountCents: number;
  status: RefundStatus;
  everSucceeded?: boolean;
  operationId?: string | null;
  resolvedBy?: string | null;
  /** Stripe's `failure_reason`; empty when not given. */
  failureReason?: string | null;
  /**
   * Stripe's `pending_reason` (v9 §5.1). The column is written only when
   * given, so a case that does not name it leaves it to the column default.
   */
  pendingReason?: string | null;
}

/**
 * One refund copy, as `applyRefundSnapshot` would have left it.
 * @param sql - Raw client.
 * @param lot - The lot and payment it belongs to.
 * @param copy - The refund's facts.
 */
export async function seedCopy(sql: Sql, lot: SeededLot, copy: SeedCopy): Promise<void> {
  const row: Record<string, string | number | boolean | null> = {
    stripe_refund_id: copy.id,
    payment_id: lot.paymentId,
    lot_id: lot.lotId,
    operation_id: copy.operationId ?? null,
    amount_cents: copy.amountCents,
    currency: "usd",
    status: copy.status,
    ever_succeeded: copy.everSucceeded ?? copy.status === "succeeded",
    resolved_by_operation_id: copy.resolvedBy ?? null,
    failure_reason: copy.failureReason ?? null,
  };
  if (copy.pendingReason !== undefined) row.pending_reason = copy.pendingReason;
  await sql`INSERT INTO credit_refunds ${sql(row)}`;
}

/** A Stripe refund object with the fields the product reads. */
export interface RefundFixture {
  id: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  failure_reason: string | null;
  /** Stripe's `pending_reason`: set while `pending`, null otherwise (v9 §5.1). */
  pending_reason: StripePendingReason | null;
  metadata: Record<string, string>;
}

/**
 * A Stripe refund object, made by the product when `operationId` is given.
 * @param id - `re_…`.
 * @param status - Stripe's status.
 * @param amount - Cents.
 * @param operationId - The disposition named in `metadata.refund_operation_id`.
 * @param pendingReason - `pending_reason` while pending; `processing` when absent.
 * @returns The object.
 */
export function refundObject(
  id: string,
  status: RefundStatus,
  amount: number,
  operationId?: string,
  pendingReason?: StripePendingReason,
): RefundFixture {
  return {
    id,
    amount,
    currency: "usd",
    status,
    failure_reason: status === "failed" ? "lost_or_stolen_card" : null,
    pending_reason: status === "pending" ? (pendingReason ?? "processing") : null,
    metadata: operationId ? { refund_operation_id: operationId } : {},
  };
}

/** A fresh, unique Stripe refund id. */
export function reId(label: string): string {
  return `re_${label}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * A refunded lot whose booked refund failed later on Stripe (§6.3 L8): the
 * copy remembers it succeeded, so it is an unresolved failed refund. Stripe
 * holds the failed refund and `extra`.
 * @param sql - Raw client.
 * @param stripe - The fake Stripe the suite answers from.
 * @param opts - `label` names the failed refund, `createdSecondsAgo` dates
 *   the approval, `extra` adds more refunds on Stripe.
 * @returns The lot, the approval that booked it and the failed refund.
 */
export async function refundedThenFailed(
  sql: Sql,
  stripe: FakeStripeRefunds,
  opts: { label?: string; createdSecondsAgo?: number; extra?: RefundFixture[] } = {},
): Promise<{ lot: SeededLot; approve: string; failed: string }> {
  const lot = await seedRefundLot(sql, "refunded");
  const approve = await seedOperation(sql, lot, {
    kind: "approve",
    status: "succeeded",
    result: "refunded",
    createdSecondsAgo: opts.createdSecondsAgo ?? 600,
  });
  const failed = reId(opts.label ?? "failed_later");
  await seedCopy(sql, lot, { id: failed, amountCents: PAID_CENTS, status: "succeeded", operationId: approve.id });
  stripe.register(lot.paymentIntentId, PAID_CENTS, [
    refundObject(failed, "failed", PAID_CENTS, approve.id),
    ...(opts.extra ?? []),
  ]);
  return { lot, approve: approve.id, failed };
}

export type RefundEventType = "refund.created" | "refund.updated" | "refund.failed";

/**
 * A Stripe event carrying a refund object.
 * @param type - The event type.
 * @param refund - The refund as the event carries it: Stripe's raw shape.
 * @param paymentIntent - The refund's payment intent.
 * @param id - The event id; fresh when absent.
 * @returns The event body.
 */
export function refundEvent(
  type: RefundEventType,
  refund: FakeRefundInput,
  paymentIntent: string,
  id = `evt_${randomUUID().replace(/-/g, "")}`,
): Record<string, unknown> {
  return {
    id,
    object: "event",
    api_version: "2025-01-27.acacia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: { ...refund, object: "refund", payment_intent: paymentIntent, created: 1_700_000_000 },
    },
  };
}

/** Signs test deliveries; the key is never used to call Stripe. */
const webhookSigner = new Stripe("sk_test_unused_by_the_refund_suites");

/**
 * Deliver an event to the Stripe webhook of an app, signed the way Stripe
 * signs with `secret`.
 * @param app - The app.
 * @param secret - The webhook secret the app verifies with.
 * @param event - The event body.
 * @returns The answer.
 */
export async function deliverWebhook(app: Hono, secret: string, event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const signature = webhookSigner.webhooks.generateTestHeaderString({ payload, secret });
  return app.request("/api/v1/payment/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body: payload,
  });
}

/** Everything a disposition can write, for one lot and its buyer. */
export interface WorldState {
  lot: Record<string, unknown>;
  ledger: Record<string, unknown>[];
  ops: Record<string, unknown>[];
  events: Record<string, unknown>[];
  copies: Record<string, unknown>[];
  bells: Record<string, unknown>[];
  mails: Record<string, unknown>[];
}

/**
 * Every row a transition could touch, whole, for exact before/after compare.
 * @param sql - Raw client.
 * @param lot - The lot and buyer.
 * @returns The rows, each table in a fixed order.
 */
export async function worldOf(sql: Sql, lot: SeededLot): Promise<WorldState> {
  const [lotRow] = await sql<{ j: Record<string, unknown> }[]>`
    SELECT to_jsonb(l) AS j FROM credit_lots l WHERE l.id = ${lot.lotId}
  `;
  const rows = async (q: Promise<{ j: Record<string, unknown> }[]>) =>
    (await q).map((r) => r.j);
  return {
    lot: lotRow!.j,
    ledger: await rows(sql`
      SELECT to_jsonb(c) AS j FROM credit_ledger c WHERE c.lot_id = ${lot.lotId}
      ORDER BY c.created_at, c.id`),
    ops: await rows(sql`
      SELECT to_jsonb(o) AS j FROM credit_refund_operations o WHERE o.lot_id = ${lot.lotId}
      ORDER BY o.created_at, o.id`),
    events: await rows(sql`
      SELECT to_jsonb(e) AS j FROM credit_refund_operation_events e
      JOIN credit_refund_operations o ON o.id = e.operation_id
      WHERE o.lot_id = ${lot.lotId} ORDER BY e.created_at, e.id`),
    copies: await rows(sql`
      SELECT to_jsonb(r) AS j FROM credit_refunds r WHERE r.lot_id = ${lot.lotId}
      ORDER BY r.stripe_refund_id`),
    bells: await rows(sql`
      SELECT to_jsonb(n) AS j FROM notifications n WHERE n.user_id = ${lot.userId}
      ORDER BY n.created_at, n.id`),
    mails: await rows(sql`
      SELECT to_jsonb(m) AS j FROM refund_mail_outbox m
      JOIN credit_refund_operations o ON o.id = m.operation_id
      WHERE o.lot_id = ${lot.lotId} ORDER BY m.created_at, m.id`),
  };
}

export interface OpRow {
  kind: string;
  status: string;
  result: string | null;
  attention_reason: string | null;
  attention_detail: string | null;
  attention_closed_at: string | null;
  attention_closed_by: string | null;
  notify: boolean;
  stripe_refund_id: string | null;
  settled_succeeded_cents: number | null;
  confirmed_refund_ids: string[];
  confirmed_succeeded_cents: number | null;
  failed_refund_ids: string[];
  attempt_count: number;
  last_error: string | null;
  lease_token: string | null;
  idempotency_key: string;
  request_hash: string;
  requested_by: string;
  reason: string;
  finished_at: string | null;
  /** Epoch microseconds, null when the column is. */
  next_attempt_us: number | null;
  locked_until_us: number | null;
}

/**
 * One disposition row, timestamps that are compared as epoch microseconds.
 * @param sql - Raw client.
 * @param id - The disposition.
 * @returns The row.
 */
export async function readOp(sql: Sql, id: string): Promise<OpRow> {
  const [row] = await sql<(Omit<OpRow, "next_attempt_us" | "locked_until_us"> & {
    next_attempt_us: string | null;
    locked_until_us: string | null;
    settled_succeeded_cents: string | null;
    confirmed_succeeded_cents: string | null;
  })[]>`
    SELECT kind, status, result, attention_reason, attention_detail,
           attention_closed_at::text AS attention_closed_at, attention_closed_by,
           notify, stripe_refund_id, settled_succeeded_cents::text AS settled_succeeded_cents,
           confirmed_refund_ids, confirmed_succeeded_cents::text AS confirmed_succeeded_cents,
           failed_refund_ids,
           attempt_count, last_error, lease_token, idempotency_key, request_hash,
           requested_by, reason, finished_at::text AS finished_at,
           (extract(epoch FROM next_attempt_at) * 1000000)::bigint::text AS next_attempt_us,
           (extract(epoch FROM locked_until) * 1000000)::bigint::text AS locked_until_us
    FROM credit_refund_operations WHERE id = ${id}
  `;
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    ...row!,
    settled_succeeded_cents: num(row!.settled_succeeded_cents),
    confirmed_succeeded_cents: num(row!.confirmed_succeeded_cents),
    next_attempt_us: num(row!.next_attempt_us),
    locked_until_us: num(row!.locked_until_us),
  };
}

/**
 * Assert a refused request left the world as `before` save the copies it
 * read and the re-judgement of the disposition waiting on Stripe that its
 * read made (v6 §4.6, §6.4): no new disposition, every other row unchanged,
 * the waiting one still in its status, and every new event row its own,
 * written by the request.
 * @param sql - Raw client.
 * @param lot - The lot.
 * @param before - The world before the request.
 * @param inFlightId - The disposition still in flight.
 */
export async function expectOnlyRejudged(
  sql: Sql,
  lot: SeededLot,
  before: WorldState,
  inFlightId: string,
): Promise<void> {
  const { copies: _ca, ops: opsAfter, events: eventsAfter, ...restAfter } = await worldOf(sql, lot);
  const { copies: _cb, ops: opsBefore, events: eventsBefore, ...restBefore } = before;
  expect(restAfter).toEqual(restBefore);
  expect(opsAfter.map((o) => o.id)).toEqual(opsBefore.map((o) => o.id));
  const others = (ops: Record<string, unknown>[]) => ops.filter((o) => o.id !== inFlightId);
  expect(others(opsAfter)).toEqual(others(opsBefore));
  const statusOf = (ops: Record<string, unknown>[]) => ops.find((o) => o.id === inFlightId)?.status;
  expect(statusOf(opsAfter)).toBe(statusOf(opsBefore));
  expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
  for (const e of eventsAfter.slice(eventsBefore.length)) {
    expect(e).toMatchObject({ operation_id: inFlightId, detail: { actor: "request" } });
  }
}

export interface EventRow {
  event: string;
  from_status: string | null;
  to_status: string;
  detail: Record<string, unknown>;
}

/**
 * A disposition's event rows, oldest first.
 * @param sql - Raw client.
 * @param id - The disposition.
 * @returns The rows.
 */
export async function eventsOf(sql: Sql, id: string): Promise<EventRow[]> {
  return sql<EventRow[]>`
    SELECT event, from_status, to_status, detail
    FROM credit_refund_operation_events WHERE operation_id = ${id}
    ORDER BY created_at, id
  `;
}

export interface CopyRow {
  stripe_refund_id: string;
  payment_id: string;
  lot_id: string;
  operation_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  failure_reason: string | null;
  ever_succeeded: boolean;
  resolved_by_operation_id: string | null;
}

/**
 * The refund copies of a lot, by refund id.
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns The rows.
 */
export async function copiesOf(sql: Sql, lotId: string): Promise<CopyRow[]> {
  const rows = await sql<(Omit<CopyRow, "amount_cents"> & { amount_cents: string })[]>`
    SELECT stripe_refund_id, payment_id, lot_id, operation_id, amount_cents::text AS amount_cents,
           currency, status, failure_reason, ever_succeeded, resolved_by_operation_id
    FROM credit_refunds WHERE lot_id = ${lotId} ORDER BY stripe_refund_id
  `;
  return rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
}

export interface LotRow {
  lifecycle: string;
  remaining: string;
  attempts: number;
}

/**
 * Where a lot stands.
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns Lifecycle, balance as Postgres text, rejected-attempt count.
 */
export async function readLot(sql: Sql, lotId: string): Promise<LotRow> {
  const [row] = await sql<{ lifecycle: string; remaining: string; attempts: number }[]>`
    SELECT lifecycle, remaining_credits::text AS remaining, refund_attempts AS attempts
    FROM credit_lots WHERE id = ${lotId}
  `;
  return row!;
}

export interface LedgerRow {
  entry_type: string;
  amount: string;
  reference_id: string | null;
}

/**
 * A lot's ledger, oldest first.
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns Type, amount as text, reference.
 */
export async function ledgerOf(sql: Sql, lotId: string): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    SELECT entry_type, amount::text AS amount, reference_id
    FROM credit_ledger WHERE lot_id = ${lotId} ORDER BY created_at, id
  `;
}

export interface BellRow {
  type: string;
  payload: Record<string, unknown>;
  expires_at: string | null;
  project_id: string | null;
}

/**
 * The buyer's refund bells, oldest first.
 * @param sql - Raw client.
 * @param userId - The buyer.
 * @returns The rows of the three refund types.
 */
export async function bellsOf(sql: Sql, userId: string): Promise<BellRow[]> {
  return sql<BellRow[]>`
    SELECT type, payload, expires_at::text AS expires_at, project_id
    FROM notifications
    WHERE user_id = ${userId}
      AND type IN ('credit.refund_completed', 'credit.refund_rejected', 'credit.refund_restored')
    ORDER BY created_at, id
  `;
}

export interface MailRow {
  operation_id: string;
  kind: string;
  origin: string;
  status: string;
  requested_by: string | null;
  idempotency_key: string | null;
}

/**
 * The mail rows of a lot's dispositions.
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns The rows, oldest first.
 */
export async function mailsOf(sql: Sql, lotId: string): Promise<MailRow[]> {
  return sql<MailRow[]>`
    SELECT m.operation_id, m.kind, m.origin, m.status, m.requested_by, m.idempotency_key
    FROM refund_mail_outbox m JOIN credit_refund_operations o ON o.id = m.operation_id
    WHERE o.lot_id = ${lotId} ORDER BY m.created_at, m.id
  `;
}

/**
 * Finish every disposition still in flight, so a suite that drives the
 * refund loop or the daily reconcile — both scan the whole table — starts
 * from the rows it seeds itself. The integration run is a single fork, so
 * the rows parked here belong to suites that have already finished.
 * @param sql - Raw client.
 */
export async function parkInFlightOperations(sql: Sql): Promise<void> {
  await sql`
    UPDATE credit_refund_operations
    SET status = 'needs_attention', attention_reason = 'state_mismatch',
        attention_detail = 'parked by a later suite', finished_at = now(),
        lease_token = NULL, locked_until = NULL, next_attempt_at = NULL
    WHERE status IN ('started', 'awaiting_stripe')
  `;
}

/**
 * Give every lot-opening payment that has no payment intent a unique
 * placeholder one. Some suites insert such payments and move their lots by
 * SQL (real data cannot: approve refuses a payment without an intent); the
 * daily reconcile scans the whole table, would land on them and record them
 * as failing. The fake Stripe answers an intent it was never told about with
 * an empty list, so a placeholder makes them reconcile cleanly. Like
 * {@link parkInFlightOperations}, it only touches rows of finished suites.
 * @param sql - Raw client.
 */
export async function giveIntentlessPaymentsAnIntent(sql: Sql): Promise<void> {
  await sql`
    UPDATE payments p SET stripe_payment_intent_id = 'pi_placeholder_' || p.id
    WHERE p.stripe_payment_intent_id IS NULL
      AND EXISTS (SELECT 1 FROM credit_lots l WHERE l.source_id = p.id)
  `;
}

/**
 * Mark the daily reconcile as just finished, so a refund loop tick's step 4
 * (§7.2) is not due and the tick touches only what the case seeded.
 * @param sql - Raw client.
 */
export async function markReconcileJustFinished(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO credit_refund_reconcile_status (name, last_started_at, last_finished_at, last_ok_at)
    VALUES ('daily', now(), now(), now())
    ON CONFLICT (name) DO UPDATE SET
      last_started_at = now(), last_finished_at = now(), last_ok_at = now(),
      last_error = NULL, failing_payment_ids = '{}', next_retry_at = NULL
  `;
}

/**
 * The database clock in epoch microseconds, for bracketing a `now()`.
 * @param sql - Raw client.
 * @returns Microseconds.
 */
export async function dbClockUs(sql: Sql): Promise<number> {
  const [row] = await sql<{ t: string }[]>`
    SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS t
  `;
  return Number(row!.t);
}

/**
 * Run in one committed transaction.
 * @param run - The work.
 * @returns What it returned.
 */
export async function inTx<T>(run: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(run);
}

/**
 * Run work that must refuse, catch the refusal inside the transaction and
 * commit, so anything written before the throw would be on disk.
 * @param run - The work.
 * @returns What was thrown, or null.
 */
export async function refusedAndCommitted(run: (tx: DbTx) => Promise<unknown>): Promise<unknown> {
  let caught: unknown = null;
  await db.transaction(async (tx) => {
    try {
      await run(tx);
    } catch (err) {
      caught = err;
    }
  });
  return caught;
}

/**
 * Give a disposition the error an earlier `refunds.create` left in `last_error`.
 * @param sql - Raw client.
 * @param opId - The disposition.
 * @param message - The error text.
 */
export async function setLastError(sql: Sql, opId: string, message: string): Promise<void> {
  await sql`UPDATE credit_refund_operations SET last_error = ${message} WHERE id = ${opId}`;
}

/**
 * An attempt that left the row `started` ended its lease and kept the token
 * (v8 round 5, §6.2): `locked_until <= now()`, `lease_token` still set — the
 * given one, when named, so a late answer of the same executor is recognised.
 * @param sql - Raw client.
 * @param opId - The disposition.
 * @param token - The token the row must still hold; any non-null one when absent.
 */
export async function expectLeaseReleased(sql: Sql, opId: string, token?: string): Promise<void> {
  const op = await readOp(sql, opId);
  if (token === undefined) expect(op.lease_token).not.toBeNull();
  else expect(op.lease_token).toBe(token);
  expect(op.locked_until_us!).toBeLessThanOrEqual(await dbClockUs(sql));
}

/**
 * The `pending_reason` of each refund copy of a lot (v9 §5.1, §6.4), by
 * refund id. Read on its own so the suites that compare whole copy rows
 * ({@link copiesOf}) do not depend on the column.
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns Refund id → pending_reason.
 */
export async function pendingReasonsOf(sql: Sql, lotId: string): Promise<Record<string, string | null>> {
  const rows = await sql<{ id: string; pending_reason: string | null }[]>`
    SELECT stripe_refund_id AS id, pending_reason FROM credit_refunds WHERE lot_id = ${lotId}
  `;
  return Object.fromEntries(rows.map((r) => [r.id, r.pending_reason]));
}

/**
 * The rows of `credit_refunds_unresolved_failed` (v9 §5.3) for one lot,
 * the view the preview, the one-shot dispositions, the reconcile and the
 * back office read.
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns Its rows, by refund id.
 */
export async function unresolvedViewOf(
  sql: Sql,
  lotId: string,
): Promise<{ lot_id: string; payment_id: string; stripe_refund_id: string; amount_cents: number; currency: string; status: string }[]> {
  const rows = await sql<{ lot_id: string; payment_id: string; stripe_refund_id: string; amount_cents: string; currency: string; status: string }[]>`
    SELECT lot_id, payment_id, stripe_refund_id, amount_cents::text AS amount_cents, currency, status
    FROM credit_refunds_unresolved_failed WHERE lot_id = ${lotId} ORDER BY stripe_refund_id
  `;
  return rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
}

/**
 * Whether the lot is on the "refund failed" list, the view
 * `credit_lot_refund_failures` (v9 §5.3).
 * @param sql - Raw client.
 * @param lotId - The lot.
 * @returns True when the view has a row for it.
 */
export async function inFailureList(sql: Sql, lotId: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM credit_lot_refund_failures WHERE lot_id = ${lotId}
  `;
  return row!.n > 0;
}
