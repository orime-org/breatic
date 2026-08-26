// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where one purchase's confirmation email stands.
 *
 * The row is born `pending` inside the fulfillment transaction, so "no row"
 * is a state the resend control never has to render. From there a send claims
 * it into `sending` and writes back where it landed.
 */

import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import { db, purchaseMailOutbox } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/**
 * Open the outbox row for one purchase, unless it is already open.
 * @param tx - The fulfillment transaction; the row and the lot commit together.
 * @param paymentId - The purchase the email is about.
 * @param locale - The language it will be written in, fixed at purchase time.
 */
export async function openOutbox(
  tx: DbTx,
  paymentId: string,
  locale: string,
): Promise<void> {
  await tx
    .insert(purchaseMailOutbox)
    .values({ paymentId, locale, status: "pending" })
    .onConflictDoNothing();
}

/**
 * Take the right to send this purchase's confirmation.
 *
 * One rule decides it, and it is stated as a condition on the row rather than
 * a list of states: everything except `sent` may be sent, and a row already
 * `sending` may be sent only once that send has been in flight too long to
 * still be one. The two together are what makes five taps one letter — a
 * claim that accepted `sending` unconditionally would succeed every time and
 * gate nothing.
 *
 * `staleSendingBefore` is passed in because the timeout is a configured value
 * and this file reads no configuration.
 * @param paymentId - The purchase whose confirmation is being sent.
 * @param staleSendingBefore - A `sending` row untouched since this instant is
 *   treated as abandoned.
 * @returns Whether this caller may send.
 */
export async function claimSend(
  paymentId: string,
  staleSendingBefore: Date,
): Promise<boolean> {
  const taken = await db
    .update(purchaseMailOutbox)
    .set({
      status: "sending",
      attempts: sql`${purchaseMailOutbox.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(purchaseMailOutbox.paymentId, paymentId),
        ne(purchaseMailOutbox.status, "sent"),
        or(
          ne(purchaseMailOutbox.status, "sending"),
          lt(purchaseMailOutbox.updatedAt, staleSendingBefore),
        ),
      ),
    )
    .returning({ id: purchaseMailOutbox.id });
  return taken.length > 0;
}

/**
 * Write back where the send landed.
 * @param paymentId - The purchase whose confirmation was sent.
 * @param status - Where the row lands.
 * @param lastError - The failure, when there was one.
 */
export async function recordSend(
  paymentId: string,
  status: "sent" | "failed" | "skipped",
  lastError?: string,
): Promise<void> {
  await db
    .update(purchaseMailOutbox)
    .set({ status, lastError: lastError ?? null, updatedAt: new Date() })
    .where(eq(purchaseMailOutbox.paymentId, paymentId));
}
