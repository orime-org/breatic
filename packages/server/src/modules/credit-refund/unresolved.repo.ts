// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reads of the two views that hold the one definition of an unresolved failed
 * refund and of the "refund failed" list (inner#1410 §5.3, migration 0094).
 * The preview, the judgement tables, booking, the daily reconcile and the back
 * office all read these views, so a refund cannot be listed by one and refused
 * by another.
 */

import { sql } from "drizzle-orm";
import type { DbTx } from "@breatic/core";
import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";

/** One unresolved failed refund, as the view gives it. */
export type UnresolvedFailedRefund = Pick<RefundCopy, "stripeRefundId" | "amountCents" | "status">;

/**
 * The lot's failed or canceled refunds no disposition has answered for, read
 * in the caller's transaction so it sees the copies just written.
 * @param lotId - The lot.
 * @param tx - The caller's transaction.
 * @returns The refunds, by refund id.
 */
export async function listUnresolvedFailed(lotId: string, tx: DbTx): Promise<UnresolvedFailedRefund[]> {
  const rows = await tx.execute<{ stripe_refund_id: string; amount_cents: string; status: StripeRefundStatus }>(sql`
    SELECT stripe_refund_id, amount_cents::text AS amount_cents, status
    FROM credit_refunds_unresolved_failed WHERE lot_id = ${lotId}
    ORDER BY stripe_refund_id
  `);
  return rows.map((r) => ({ stripeRefundId: r.stripe_refund_id, amountCents: Number(r.amount_cents), status: r.status }));
}

/**
 * Whether the lot is on the "refund failed" list.
 * @param lotId - The lot.
 * @param tx - The caller's transaction.
 * @returns True when the view lists it.
 */
export async function isOnRefundFailureList(lotId: string, tx: DbTx): Promise<boolean> {
  const rows = await tx.execute<{ listed: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM credit_lot_refund_failures WHERE lot_id = ${lotId}) AS listed
  `);
  return rows[0]?.listed === true;
}
