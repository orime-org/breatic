// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `payment_receipts`: the product's record of a completed payment (inner#1993 §4.2).
 */

import { eq } from "drizzle-orm";
import { paymentReceipts, type DbTx } from "@breatic/core";

/** The figures a receipt records. */
export interface PaymentReceipt {
  id: string;
  userId: string;
  amountCents: number;
  taxCents: number | null;
  totalCents: number | null;
  currency: string;
  /** Credits granted, as the numeric column's text. */
  creditsGranted: string;
  orderedAt: Date;
}

/**
 * Read a payment's receipt.
 * @param id - The payment's id.
 * @param tx - The caller's transaction.
 * @returns The receipt, or null.
 */
export async function findReceipt(id: string, tx: DbTx): Promise<PaymentReceipt | null> {
  const [row] = await tx
    .select({
      id: paymentReceipts.id,
      userId: paymentReceipts.userId,
      amountCents: paymentReceipts.amountCents,
      taxCents: paymentReceipts.taxCents,
      totalCents: paymentReceipts.totalCents,
      currency: paymentReceipts.currency,
      creditsGranted: paymentReceipts.creditsGranted,
      orderedAt: paymentReceipts.orderedAt,
    })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Write a payment's receipt; its credit source must already exist.
 * @param receipt - The figures.
 * @param tx - The caller's transaction.
 */
export async function insertReceipt(receipt: PaymentReceipt, tx: DbTx): Promise<void> {
  await tx.insert(paymentReceipts).values({ ...receipt, sourceKind: "payment" });
}
