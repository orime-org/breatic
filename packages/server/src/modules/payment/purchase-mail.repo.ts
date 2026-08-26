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
 *
 * The row carries no copy of the language: the letter is written in the one
 * stored on the payment at checkout, and a second copy here would be a second
 * answer to the same question.
 * @param tx - The fulfillment transaction; the row and the lot commit together.
 * @param paymentId - The purchase the email is about.
 */
export async function openOutbox(tx: DbTx, paymentId: string): Promise<void> {
  await tx
    .insert(purchaseMailOutbox)
    .values({ paymentId, status: "pending" })
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
 *
 * What comes back is the claim: `attempts` after this claim incremented it,
 * which no other claim on this row shares. Treating a stale send as abandoned
 * only holds if the send that was abandoned can no longer write, and nothing
 * cancels it — it is asleep in an SMTP socket. The number is what
 * {@link recordSend} checks so that the one who lost the row writes nothing.
 * @param paymentId - The purchase whose confirmation is being sent.
 * @param staleSendingBefore - A `sending` row untouched since this instant is
 *   treated as abandoned.
 * @returns The claim, or null when this caller may not send.
 */
export async function claimSend(
  paymentId: string,
  staleSendingBefore: Date,
): Promise<number | null> {
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
    .returning({ attempts: purchaseMailOutbox.attempts });
  return taken[0]?.attempts ?? null;
}

/**
 * Write back where the send landed, if this send still holds the row.
 *
 * A send that was treated as abandoned wakes up eventually — its SMTP socket
 * times out, minutes after somebody else took the row over and sent the
 * letter. Writing its failure then would record a letter that did arrive as
 * one that did not, put the resend control back, and send a third.
 * @param paymentId - The purchase whose confirmation was sent.
 * @param claim - What {@link claimSend} handed back to this send.
 * @param status - Where the row lands.
 * @param lastError - The failure, when there was one.
 */
export async function recordSend(
  paymentId: string,
  claim: number,
  status: "sent" | "failed" | "skipped",
  lastError?: string,
): Promise<void> {
  await db
    .update(purchaseMailOutbox)
    .set({ status, lastError: lastError ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(purchaseMailOutbox.paymentId, paymentId),
        eq(purchaseMailOutbox.attempts, claim),
      ),
    );
}
