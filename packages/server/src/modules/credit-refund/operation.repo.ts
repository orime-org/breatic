// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `credit_refund_operations` and its event rows
 * (inner#1410 §5.1). Status changes and event rows are written only through
 * `transitionOperation`; `markFirstCalled` and `scheduleNextLook` write one
 * progress column each, plus `updated_at` by the database clock, with no
 * event row (§5.1, §9).
 */

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { creditRefundOperationEvents, creditRefundOperations, db } from "@breatic/core";
import type { DbTx } from "@breatic/core";

export type OperationKind =
  | "approve"
  | "reject"
  | "settle"
  | "send_back"
  | "retry"
  | "resolve_outside"
  | "restore_credits";
export type OperationStatus = "started" | "awaiting_stripe" | "succeeded" | "needs_attention";
export type OperationResult = "refunded" | "rejected" | "sent_back" | "resolved_outside" | "restored";
export type AttentionReason =
  | "partial_refund"
  | "unexpected_external_refund"
  | "stripe_refund_failed_later"
  | "attempts_exhausted"
  | "stripe_result_unknown"
  | "already_refunded_elsewhere"
  | "stripe_declined"
  | "stripe_request_invalid"
  | "state_mismatch";

/** One disposition, as its row stands. */
export interface CreditRefundOperation {
  id: string;
  lotId: string;
  paymentId: string;
  kind: OperationKind;
  status: OperationStatus;
  result: OperationResult | null;
  attentionReason: AttentionReason | null;
  attentionDetail: string | null;
  attentionClosedAt: Date | null;
  attentionClosedBy: string | null;
  idempotencyKey: string;
  requestHash: string;
  requestedBy: string;
  reason: string;
  notify: boolean;
  refundRequestedAt: Date | null;
  confirmedRefundIds: string[];
  confirmedSucceededCents: number | null;
  failedRefundIds: string[];
  settledSucceededCents: number | null;
  stripeRefundId: string | null;
  firstCalledAt: Date | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  leaseToken: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** The columns a new disposition is inserted with. */
export interface OperationInsert {
  lotId: string;
  paymentId: string;
  kind: OperationKind;
  status: OperationStatus;
  result: OperationResult | null;
  idempotencyKey: string;
  requestHash: string;
  requestedBy: string;
  reason: string;
  notify: boolean;
  refundRequestedAt: Date | null;
  confirmedRefundIds: string[];
  confirmedSucceededCents: number | null;
  failedRefundIds: string[];
  settledSucceededCents: number | null;
  /** A lease of this many seconds and `next_attempt_at = now()`; null for none. */
  lease: { token: string; seconds: number } | null;
  finished: boolean;
}

/**
 * A change to one disposition. Times are taken from the database clock:
 * `nextAttemptInSeconds` and `lease` count from `now()`; `finished`,
 * `attentionClosedBy` and `updated_at` stamp {@link STAMP}. Absent keys are
 * left as they are.
 */
export interface OperationPatch {
  status?: OperationStatus;
  result?: OperationResult;
  attentionReason?: AttentionReason;
  attentionDetail?: string | null;
  attentionClosedBy?: string;
  stripeRefundId?: string;
  settledSucceededCents?: number;
  attemptCount?: number;
  lastError?: string;
  /** Seconds from now; null clears `next_attempt_at`. */
  nextAttemptInSeconds?: number | null;
  /** Set the lease: its token and the seconds left from now (0 ends it now); null clears both. */
  lease?: { token: string; seconds: number } | null;
  finished?: true;
}

/**
 * Map a row to the entity.
 * @param row - Raw row.
 * @returns The entity.
 */
function toEntity(row: typeof creditRefundOperations.$inferSelect): CreditRefundOperation {
  return {
    ...row,
    kind: row.kind as OperationKind,
    status: row.status as OperationStatus,
    result: row.result as OperationResult | null,
    attentionReason: row.attentionReason as AttentionReason | null,
  };
}

/**
 * When something happened to a row: the database's wall clock when the
 * expression is evaluated. `now()` is the writing transaction's start, which
 * precedes any row inserted after that start, by this transaction or by
 * another that committed while it waited on the lot lock (§5.1).
 */
const STAMP = sql`clock_timestamp()`;

/**
 * `now() + seconds`, in the database's clock.
 * @param seconds - How far ahead.
 * @returns The SQL expression.
 */
function fromNow(seconds: number): ReturnType<typeof sql> {
  return sql`now() + make_interval(secs => ${seconds}::double precision)`;
}

/**
 * Which lot a disposition belongs to. `lot_id` never changes after insert,
 * so this needs no lock; the caller locks the lot next.
 * @param id - The disposition.
 * @param tx - The caller's transaction.
 * @returns The lot id, or null if there is no such disposition.
 */
export async function findLotId(id: string, tx: DbTx): Promise<string | null> {
  const rows = await tx
    .select({ lotId: creditRefundOperations.lotId })
    .from(creditRefundOperations)
    .where(eq(creditRefundOperations.id, id));
  return rows[0]?.lotId ?? null;
}

/**
 * Lock one disposition row.
 * @param id - The disposition.
 * @param tx - The caller's transaction, already holding the lot's lock.
 * @returns The row, or null.
 */
export async function lockById(id: string, tx: DbTx): Promise<CreditRefundOperation | null> {
  const rows = await tx
    .select()
    .from(creditRefundOperations)
    .where(eq(creditRefundOperations.id, id))
    .for("update");
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Insert a disposition. The partial unique index refuses a second one in
 * flight on the same lot.
 * @param values - The new row.
 * @param tx - The caller's transaction.
 * @returns The inserted row.
 */
export async function insert(values: OperationInsert, tx: DbTx): Promise<CreditRefundOperation> {
  const { lease, finished, ...columns } = values;
  const rows = await tx
    .insert(creditRefundOperations)
    .values({
      ...columns,
      leaseToken: lease?.token ?? null,
      lockedUntil: lease ? fromNow(lease.seconds) : null,
      nextAttemptAt: lease ? sql`now()` : null,
      finishedAt: finished ? STAMP : null,
      createdAt: STAMP,
      updatedAt: STAMP,
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Apply a change to one disposition.
 * @param id - The disposition, locked by the caller.
 * @param patch - What changes.
 * @param tx - The caller's transaction.
 * @returns The row after the change.
 */
export async function update(
  id: string,
  patch: OperationPatch,
  tx: DbTx,
): Promise<CreditRefundOperation> {
  const { nextAttemptInSeconds, lease, finished, attentionClosedBy, ...columns } = patch;
  const rows = await tx
    .update(creditRefundOperations)
    .set({
      ...columns,
      ...(nextAttemptInSeconds !== undefined && {
        nextAttemptAt: nextAttemptInSeconds === null ? null : fromNow(nextAttemptInSeconds),
      }),
      ...(lease !== undefined && {
        leaseToken: lease?.token ?? null,
        lockedUntil: lease ? fromNow(lease.seconds) : null,
      }),
      ...(finished && { finishedAt: STAMP }),
      ...(attentionClosedBy !== undefined && {
        attentionClosedBy,
        attentionClosedAt: STAMP,
      }),
      updatedAt: STAMP,
    })
    .where(eq(creditRefundOperations.id, id))
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Append one event row.
 * @param row - The event.
 * @param row.operationId - The disposition.
 * @param row.event - Its name.
 * @param row.fromStatus - The status before, null for the creating event.
 * @param row.toStatus - The status after.
 * @param row.detail - What the event carried.
 * @param tx - The caller's transaction.
 */
export async function appendEvent(
  row: {
    operationId: string;
    event: string;
    fromStatus: OperationStatus | null;
    toStatus: OperationStatus;
    detail: Record<string, unknown>;
  },
  tx: DbTx,
): Promise<void> {
  await tx.insert(creditRefundOperationEvents).values({ ...row, createdAt: STAMP });
}

/** One event row of a disposition, as E11 reads it. */
export interface OperationEventRow {
  event: string;
  detail: Record<string, unknown>;
}

/**
 * Every event row of a disposition, oldest first.
 * @param operationId - The disposition.
 * @param tx - The caller's transaction.
 * @returns Its events.
 */
export async function listEvents(operationId: string, tx: DbTx): Promise<OperationEventRow[]> {
  const rows = await tx
    .select({ event: creditRefundOperationEvents.event, detail: creditRefundOperationEvents.detail })
    .from(creditRefundOperationEvents)
    .where(eq(creditRefundOperationEvents.operationId, operationId))
    .orderBy(asc(creditRefundOperationEvents.createdAt));
  return rows.map((r) => ({ event: r.event, detail: r.detail ?? {} }));
}

/**
 * The open needs_attention dispositions of a lot, oldest first.
 * @param lotId - The lot.
 * @param exceptId - A disposition to leave out.
 * @param tx - The caller's transaction.
 * @returns Their ids.
 */
export async function listOpenAttention(
  lotId: string,
  exceptId: string,
  tx: DbTx,
): Promise<string[]> {
  const rows = await tx
    .select({ id: creditRefundOperations.id })
    .from(creditRefundOperations)
    .where(
      and(
        eq(creditRefundOperations.lotId, lotId),
        eq(creditRefundOperations.status, "needs_attention"),
        isNull(creditRefundOperations.attentionClosedAt),
        ne(creditRefundOperations.id, exceptId),
      ),
    )
    .orderBy(asc(creditRefundOperations.createdAt), asc(creditRefundOperations.id));
  return rows.map((r) => r.id);
}

/**
 * The disposition of a payment that waits on Stripe, if any. The one-in-
 * flight index allows at most one.
 * @param paymentId - The payment.
 * @param tx - The caller's transaction.
 * @returns Its id, or null.
 */
export async function findAwaiting(paymentId: string, tx: DbTx): Promise<string | null> {
  const rows = await tx
    .select({ id: creditRefundOperations.id })
    .from(creditRefundOperations)
    .where(
      and(
        eq(creditRefundOperations.paymentId, paymentId),
        eq(creditRefundOperations.status, "awaiting_stripe"),
      ),
    );
  return rows[0]?.id ?? null;
}

/**
 * One disposition, unlocked.
 * @param id - The disposition.
 * @param tx - The caller's transaction, if any.
 * @returns The row, or null.
 */
export async function findById(id: string, tx?: DbTx): Promise<CreditRefundOperation | null> {
  const rows = await (tx ?? db)
    .select()
    .from(creditRefundOperations)
    .where(eq(creditRefundOperations.id, id));
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * The disposition holding an idempotency key, and whether its executor
 * still holds the lease (by the database clock).
 * @param key - The `Idempotency-Key`.
 * @param tx - The caller's transaction, if any.
 * @returns The row and the lease fact, or null.
 */
export async function findByKey(
  key: string,
  tx?: DbTx,
): Promise<{ op: CreditRefundOperation; leaseHeld: boolean } | null> {
  const rows = await (tx ?? db)
    .select({
      row: creditRefundOperations,
      leaseHeld: sql<boolean>`coalesce(${creditRefundOperations.lockedUntil} > now(), false)`,
    })
    .from(creditRefundOperations)
    .where(eq(creditRefundOperations.idempotencyKey, key));
  return rows[0] ? { op: toEntity(rows[0].row), leaseHeld: rows[0].leaseHeld } : null;
}

/**
 * Every disposition of a lot, oldest first.
 * @param lotId - The lot.
 * @param tx - The caller's transaction.
 * @returns The rows.
 */
export async function listForLot(lotId: string, tx: DbTx): Promise<CreditRefundOperation[]> {
  const rows = await tx
    .select()
    .from(creditRefundOperations)
    .where(eq(creditRefundOperations.lotId, lotId))
    .orderBy(asc(creditRefundOperations.createdAt), asc(creditRefundOperations.id));
  return rows.map(toEntity);
}

/**
 * Queue behind every other write transaction using the same idempotency key
 * (§4.6), whatever it targets; released at commit.
 * @param key - The `Idempotency-Key`.
 * @param tx - The write transaction.
 */
export async function lockIdempotencyKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`internal-idem:${key}`}))`);
}

/**
 * Before `refunds.create`: stamp the first call, only while the caller still
 * holds the lease with at least one Stripe call's time left on it (§9).
 * @param id - The disposition.
 * @param leaseToken - The caller's lease.
 * @param callMs - How long one Stripe call may take.
 * @returns False when the lease was taken over or is about to run out: the
 *   caller must not call Stripe.
 */
export async function markFirstCalled(id: string, leaseToken: string, callMs: number): Promise<boolean> {
  const rows = await db
    .update(creditRefundOperations)
    .set({ firstCalledAt: sql`coalesce(${creditRefundOperations.firstCalledAt}, now())`, updatedAt: STAMP })
    .where(
      and(
        eq(creditRefundOperations.id, id),
        eq(creditRefundOperations.leaseToken, leaseToken),
        sql`${creditRefundOperations.lockedUntil} > now() + ${callMs} * interval '1 millisecond'`,
      ),
    )
    .returning({ id: creditRefundOperations.id });
  return rows.length > 0;
}

/** A `started` row whose executor is gone: lease run out, attempt due. */
const CLAIMABLE = sql`${creditRefundOperations.status} = 'started'
  AND ${creditRefundOperations.lockedUntil} < now()
  AND ${creditRefundOperations.nextAttemptAt} <= now()`;

/**
 * Candidates for the loop's claim (§7.1 step 1), unlocked: the claim
 * re-checks each under the lot's lock.
 * @param limit - How many.
 * @returns Their ids and lots, most overdue first.
 */
export async function listClaimable(limit: number): Promise<{ id: string; lotId: string }[]> {
  return db
    .select({ id: creditRefundOperations.id, lotId: creditRefundOperations.lotId })
    .from(creditRefundOperations)
    .where(CLAIMABLE)
    .orderBy(asc(creditRefundOperations.nextAttemptAt))
    .limit(limit);
}

/**
 * Lock a disposition if it is still claimable.
 * @param id - The disposition.
 * @param tx - The transaction already holding its lot's lock.
 * @returns True when it is locked and claimable.
 */
export async function lockIfClaimable(id: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .select({ id: creditRefundOperations.id })
    .from(creditRefundOperations)
    .where(and(eq(creditRefundOperations.id, id), CLAIMABLE))
    .for("update");
  return rows.length > 0;
}

/**
 * Dispositions waiting on Stripe whose next lookup is due (§7.1 step 2).
 * @param limit - How many.
 * @returns The rows, most overdue first.
 */
export async function listDueAwaiting(limit: number): Promise<CreditRefundOperation[]> {
  const rows = await db
    .select()
    .from(creditRefundOperations)
    .where(
      and(
        eq(creditRefundOperations.status, "awaiting_stripe"),
        sql`${creditRefundOperations.nextAttemptAt} <= now()`,
      ),
    )
    .orderBy(asc(creditRefundOperations.nextAttemptAt))
    .limit(limit);
  return rows.map(toEntity);
}

/**
 * Put off the next lookup of a disposition still waiting on Stripe. Progress
 * only: the status does not move, so no event row.
 * @param id - The disposition.
 * @param seconds - Seconds from now.
 * @param tx - The transaction holding its lot's lock.
 */
export async function scheduleNextLook(id: string, seconds: number, tx: DbTx): Promise<void> {
  await tx
    .update(creditRefundOperations)
    .set({ nextAttemptAt: fromNow(seconds), updatedAt: STAMP })
    .where(
      and(eq(creditRefundOperations.id, id), eq(creditRefundOperations.status, "awaiting_stripe")),
    );
}

/**
 * Which of the given ids are dispositions of this payment.
 * @param paymentId - The payment.
 * @param ids - Candidate disposition ids (from refund metadata).
 * @param tx - The caller's transaction.
 * @returns The ids that exist.
 */
export async function existingIds(
  paymentId: string,
  ids: readonly string[],
  tx: DbTx,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: creditRefundOperations.id })
    .from(creditRefundOperations)
    .where(
      and(
        eq(creditRefundOperations.paymentId, paymentId),
        inArray(creditRefundOperations.id, [...ids]),
      ),
    );
  return rows.map((r) => r.id);
}
