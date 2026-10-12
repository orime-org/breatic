// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `credit_refund_operations` and its event rows
 * (inner#1410 §5.1). The only caller that writes is `transitionOperation`.
 */

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { creditRefundOperationEvents, creditRefundOperations } from "@breatic/core";
import type { DbTx } from "@breatic/core";

export type OperationKind =
  | "approve"
  | "reject"
  | "settle"
  | "send_back"
  | "retry"
  | "refund_again"
  | "resolve_outside";
export type OperationStatus = "started" | "awaiting_stripe" | "succeeded" | "needs_attention";
export type OperationResult = "refunded" | "rejected" | "sent_back" | "resolved_outside";
export type AttentionReason =
  | "partial_refund"
  | "unexpected_external_refund"
  | "stripe_refund_failed_later"
  | "attempts_exhausted"
  | "stripe_result_unknown"
  | "already_refunded_elsewhere"
  | "stripe_declined"
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
  confirmedRefundIds: string[];
  confirmedSucceededCents: number | null;
  failedRefundIds: string[];
  refundAmountCents: number | null;
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
  confirmedRefundIds: string[];
  confirmedSucceededCents: number | null;
  failedRefundIds: string[];
  refundAmountCents: number | null;
  settledSucceededCents: number | null;
  /** A lease of this many seconds and `next_attempt_at = now()`; null for none. */
  lease: { token: string; seconds: number } | null;
  finished: boolean;
}

/**
 * A change to one disposition. Times are taken from the database clock:
 * `nextAttemptInSeconds` and `lease` from `now()`, `finished` and
 * `attentionClosedBy` stamp `now()`. Absent keys are left as they are.
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
  /** A new lease from now; null clears token and `locked_until`. */
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
      finishedAt: finished ? sql`now()` : null,
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
      ...(finished && { finishedAt: sql`now()` }),
      ...(attentionClosedBy !== undefined && {
        attentionClosedBy,
        attentionClosedAt: sql`now()`,
      }),
      updatedAt: sql`now()`,
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
  await tx.insert(creditRefundOperationEvents).values(row);
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
