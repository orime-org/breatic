// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for the daily refund reconcile (inner#1410 §7.2): the
 * `credit_refund_reconcile_status` row, and the read of which payments a
 * pass covers.
 */

import { sql } from "drizzle-orm";
import { creditRefundReconcileStatus, db } from "@breatic/core";

const NAME = "daily";

/**
 * Whether a pass is due: no finished pass yet, the last one finished more
 * than 24 hours ago, or the retry time after a failed pass has come.
 * @returns True when a pass should run.
 */
export async function isDue(): Promise<boolean> {
  const rows = await db.execute<{ due: boolean }>(sql`
    SELECT (
      ${creditRefundReconcileStatus.lastFinishedAt} IS NULL
      OR ${creditRefundReconcileStatus.lastFinishedAt} < now() - interval '24 hours'
      OR ${creditRefundReconcileStatus.nextRetryAt} <= now()
    ) AS due
    FROM ${creditRefundReconcileStatus}
    WHERE ${creditRefundReconcileStatus.name} = ${NAME}
  `);
  const row = rows[0];
  return row === undefined || row.due;
}

/** Record that a pass started, creating the row on first use. */
export async function markStarted(): Promise<void> {
  await db
    .insert(creditRefundReconcileStatus)
    .values({ name: NAME, lastStartedAt: sql`now()` })
    .onConflictDoUpdate({
      target: creditRefundReconcileStatus.name,
      set: { lastStartedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

/**
 * Record how a pass ended.
 * @param failingPaymentIds - The payments this pass could not reconcile.
 * @param lastError - What went wrong, when something did.
 */
export async function markFinished(failingPaymentIds: string[], lastError: string | null): Promise<void> {
  const clean = failingPaymentIds.length === 0;
  await db
    .update(creditRefundReconcileStatus)
    .set({
      lastFinishedAt: sql`now()`,
      failingPaymentIds,
      lastError: clean ? null : lastError,
      nextRetryAt: clean ? null : sql`now() + interval '1 hour'`,
      ...(clean && { lastOkAt: sql`now()` }),
      updatedAt: sql`now()`,
    })
    .where(sql`${creditRefundReconcileStatus.name} = ${NAME}`);
}

/**
 * The payments a pass covers (§7.2): those of `refunding` lots; those with a
 * refund copy created, or a disposition finished, within the window; those
 * with an unresolved failed refund (§5.3); and the previous pass's failures.
 * @param windowDays - `reconcile_window_days`.
 * @returns Payment ids, each once.
 */
export async function listPaymentsInScope(windowDays: number): Promise<string[]> {
  const rows = await db.execute<{ payment_id: string }>(sql`
    SELECT source_id AS payment_id FROM credit_lots
      WHERE lifecycle = 'refunding' AND source_kind = 'payment'
    UNION
    SELECT payment_id FROM credit_refunds
      WHERE created_at >= now() - make_interval(days => ${windowDays}::int)
    UNION
    SELECT payment_id FROM credit_refund_operations
      WHERE finished_at >= now() - make_interval(days => ${windowDays}::int)
    UNION
    SELECT payment_id FROM credit_refunds_unresolved_failed
    UNION
    SELECT unnest(failing_payment_ids) FROM credit_refund_reconcile_status WHERE name = ${NAME}
  `);
  return rows.map((r) => r.payment_id);
}
