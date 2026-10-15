// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `credit_refunds`, the product's copy of what Stripe says
 * about each refund of a credit pack's payment (inner#1410 §6.4).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { creditRefunds } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type {
  RefundCopy,
  StripePendingReason,
  StripeRefundStatus,
} from "@server/modules/credit-refund/types.js";

/** One refund as Stripe reported it, ready to be copied. */
export interface CopyWrite {
  stripeRefundId: string;
  paymentId: string;
  lotId: string;
  operationId: string | null;
  amountCents: number;
  currency: string;
  status: StripeRefundStatus;
  failureReason: string | null;
  pendingReason: StripePendingReason | null;
}

/**
 * Map a row to the shape the rules read.
 * @param row - Raw row.
 * @returns The copy.
 */
function toCopy(row: typeof creditRefunds.$inferSelect): RefundCopy {
  return {
    stripeRefundId: row.stripeRefundId,
    amountCents: row.amountCents,
    status: row.status as StripeRefundStatus,
    pendingReason: row.pendingReason as StripePendingReason | null,
    operationId: row.operationId,
    everSucceeded: row.everSucceeded,
    resolvedByOperationId: row.resolvedByOperationId,
    failureReason: row.failureReason,
  };
}

/**
 * Insert a refund not seen before, or take the reported status, with the
 * failure and pending reasons reported alongside it, for one that was.
 * `failed` and `canceled` are final on Stripe, so a copy in either keeps its
 * status and reasons: a report that says otherwise was read before. A report that changes nothing writes
 * nothing. `ever_succeeded` only turns true, whatever the status does;
 * `operation_id` and `resolved_by_operation_id` are never changed by a later
 * report.
 * @param copy - The refund.
 * @param tx - The caller's transaction, holding the lot's lock.
 */
export async function upsert(copy: CopyWrite, tx: DbTx): Promise<void> {
  const succeeded = copy.status === "succeeded";
  const isFinal = sql`${creditRefunds.status} IN ('failed', 'canceled')`;
  await tx
    .insert(creditRefunds)
    .values({ ...copy, everSucceeded: succeeded })
    .onConflictDoUpdate({
      target: creditRefunds.stripeRefundId,
      set: {
        status: sql`CASE WHEN ${isFinal} THEN ${creditRefunds.status} ELSE ${copy.status} END`,
        failureReason: sql`CASE WHEN ${isFinal} THEN ${creditRefunds.failureReason} ELSE ${copy.failureReason} END`,
        pendingReason: sql`CASE WHEN ${isFinal} THEN ${creditRefunds.pendingReason} ELSE ${copy.pendingReason} END`,
        everSucceeded: sql`${creditRefunds.everSucceeded} OR ${succeeded}`,
        updatedAt: sql`now()`,
      },
      // A pending refund's reason can change while its status stays pending.
      setWhere: sql`((${creditRefunds.status} IS DISTINCT FROM ${copy.status}
          OR ${creditRefunds.pendingReason} IS DISTINCT FROM ${copy.pendingReason}) AND NOT ${isFinal})
        OR (${succeeded} AND NOT ${creditRefunds.everSucceeded})`,
    });
}

/**
 * Every copied refund of a payment.
 * @param paymentId - The payment.
 * @param tx - The caller's transaction.
 * @returns The copies, by refund id.
 */
export async function listForPayment(paymentId: string, tx: DbTx): Promise<RefundCopy[]> {
  const rows = await tx
    .select()
    .from(creditRefunds)
    .where(eq(creditRefunds.paymentId, paymentId))
    .orderBy(creditRefunds.stripeRefundId);
  return rows.map(toCopy);
}

/**
 * Record that a disposition answered for these refunds. A refund already
 * answered for keeps its first answer.
 * @param lotId - The lot they belong to.
 * @param refundIds - The refunds.
 * @param operationId - The disposition that answered.
 * @param tx - The caller's transaction.
 */
export async function markResolved(
  lotId: string,
  refundIds: readonly string[],
  operationId: string,
  tx: DbTx,
): Promise<void> {
  if (refundIds.length === 0) return;
  await tx
    .update(creditRefunds)
    .set({ resolvedByOperationId: operationId, updatedAt: sql`now()` })
    .where(
      and(
        eq(creditRefunds.lotId, lotId),
        inArray(creditRefunds.stripeRefundId, [...refundIds]),
        isNull(creditRefunds.resolvedByOperationId),
      ),
    );
}
