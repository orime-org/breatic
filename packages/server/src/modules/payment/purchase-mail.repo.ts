// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where one purchase's confirmation email stands.
 *
 * The row is born `pending` inside the fulfillment transaction, so "no row"
 * is a state the resend control never has to render. From there a send claims
 * it into `sending` and writes back where it landed.
 */

import { and, eq, inArray } from "drizzle-orm";
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
 * Compare-and-set from any of `from` to `sending`. Two callers racing — the
 * first send and a buyer tapping resend — leave exactly one holding it.
 * @param paymentId - The purchase whose confirmation is being sent.
 * @param from - The states a send may start from.
 * @returns Whether this caller may send.
 */
export async function claimSend(
  paymentId: string,
  from: readonly string[],
): Promise<boolean> {
  const taken = await db
    .update(purchaseMailOutbox)
    .set({ status: "sending", updatedAt: new Date() })
    .where(
      and(
        eq(purchaseMailOutbox.paymentId, paymentId),
        inArray(purchaseMailOutbox.status, [...from]),
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
