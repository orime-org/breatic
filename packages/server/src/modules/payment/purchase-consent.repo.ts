// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The record of what one buyer agreed to, and when.
 *
 * Append-only by nature: it is the evidence a purchase was consented to, so
 * there is one write and no update. `payment_id` is unique, which is what
 * makes the second and later callers of fulfillment no-ops rather than
 * duplicates.
 */

import { purchaseConsents } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/**
 * Record one purchase's consent, unless it is already recorded.
 * @param tx - The fulfillment transaction; the consent and the credits it
 *   paid for commit together.
 * @param row - What was agreed.
 * @param row.paymentId - The purchase this consent belongs to.
 * @param row.userId - Who gave it.
 * @param row.locale - The language the wording was shown in.
 * @param row.consentTextVersion - Which consent wording it was.
 * @param row.refundTextVersion - Which refund rule was in force, when one was recorded.
 * @param row.consentedAt - When this consent was first observed, which is the
 *   earliest instant we can attest to.
 * @param row.stripePaymentIntentId - The charge behind it, when there is one.
 */
export async function insertConsent(
  tx: DbTx,
  row: {
    paymentId: string;
    userId: string;
    locale: string;
    consentTextVersion: string;
    refundTextVersion: string | null;
    consentedAt: Date;
    stripePaymentIntentId: string | null;
  },
): Promise<void> {
  await tx.insert(purchaseConsents).values(row).onConflictDoNothing();
}
