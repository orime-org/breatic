// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `refund_mail_outbox` (inner#1410 §6.5).
 */

import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
  creditLots,
  creditRefundOperations,
  db,
  payments,
  refundMailOutbox,
  users,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { RefundMailView } from "@server/modules/credit-refund/refund-mail-template.js";

/** Which buyer email. */
export type RefundMailKind = "refund_completed" | "refund_rejected" | "refund_restored";

/** One mail row, as the internal API reports it. */
export interface RefundMail {
  id: string;
  operationId: string;
  kind: RefundMailKind;
  origin: "auto" | "resend";
  status: "pending" | "sending" | "sent" | "failed" | "skipped" | "unknown";
  requestedBy: string | null;
  reason: string | null;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The mail row plus the idempotency columns the API compares. */
interface StoredMail {
  mail: RefundMail;
  requestHash: string | null;
}

/**
 * Map a row to what the API reports and compares.
 * @param row - Raw row.
 * @returns The mail and its request hash.
 */
function toStored(row: typeof refundMailOutbox.$inferSelect): StoredMail {
  const { idempotencyKey: _key, requestHash, ...rest } = row;
  return {
    mail: {
      ...rest,
      kind: rest.kind as RefundMail["kind"],
      origin: rest.origin as RefundMail["origin"],
      status: rest.status as RefundMail["status"],
    },
    requestHash,
  };
}

/**
 * Queue the automatic mail of a finishing disposition (M0, `auto`). The
 * partial unique index allows one per disposition.
 * @param operationId - The disposition.
 * @param kind - Which mail.
 * @param tx - The disposition's transaction.
 */
export async function insertAuto(
  operationId: string,
  kind: RefundMailKind,
  tx: DbTx,
): Promise<void> {
  await tx.insert(refundMailOutbox).values({ operationId, kind, origin: "auto" });
}

/**
 * Queue an operator's resend (M0, `resend`): a new row beside any earlier one.
 * @param row - The resend.
 * @param row.operationId - The disposition.
 * @param row.kind - Which mail.
 * @param row.requestedBy - The back office admin.
 * @param row.reason - Why.
 * @param row.idempotencyKey - The request's key.
 * @param row.requestHash - The request's fingerprint.
 * @param tx - The request's transaction.
 * @returns The new row.
 */
export async function insertResend(
  row: {
    operationId: string;
    kind: RefundMailKind;
    requestedBy: string;
    reason: string;
    idempotencyKey: string;
    requestHash: string;
  },
  tx: DbTx,
): Promise<RefundMail> {
  const rows = await tx
    .insert(refundMailOutbox)
    .values({ ...row, origin: "resend" })
    .returning();
  return toStored(rows[0]!).mail;
}

/**
 * Claim a row for sending (M1): `pending` to `sending`. Each row is claimed
 * once; a send nobody wrote back becomes `unknown` (M5), never claimed again.
 * @param mailId - The row.
 * @returns True when this caller took it.
 */
export async function claimSend(mailId: string): Promise<boolean> {
  const rows = await db
    .update(refundMailOutbox)
    .set({ status: "sending", updatedAt: sql`now()` })
    .where(and(eq(refundMailOutbox.id, mailId), eq(refundMailOutbox.status, "pending")))
    .returning({ id: refundMailOutbox.id });
  return rows.length > 0;
}

/**
 * Write back where a claimed send landed (M2, M3, M4).
 * @param mailId - The row.
 * @param status - `sent`, `failed` or `skipped`.
 * @param lastError - Why it failed.
 * @returns False when the row was no longer `sending`, and nothing changed.
 */
export async function recordSend(
  mailId: string,
  status: "sent" | "failed" | "skipped",
  lastError?: string,
): Promise<boolean> {
  const rows = await db
    .update(refundMailOutbox)
    .set({
      status,
      lastError: status === "failed" ? (lastError ?? null) : null,
      ...(status === "sent" && { sentAt: sql`now()` }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(refundMailOutbox.id, mailId), eq(refundMailOutbox.status, "sending")))
    .returning({ id: refundMailOutbox.id });
  return rows.length > 0;
}

/**
 * Give up on sends nobody wrote back (M5): `sending` rows untouched since
 * before the cutoff become `unknown`.
 * @param staleBefore - The cutoff.
 * @returns How many rows moved.
 */
export async function markStaleUnknown(staleBefore: Date): Promise<number> {
  const rows = await db
    .update(refundMailOutbox)
    .set({ status: "unknown", updatedAt: sql`now()` })
    .where(and(eq(refundMailOutbox.status, "sending"), lt(refundMailOutbox.updatedAt, staleBefore)))
    .returning({ id: refundMailOutbox.id });
  return rows.length;
}

/**
 * Pending rows inserted more than a minute ago: the loop's sweep (§7.1
 * step 3). Younger rows belong to the send that follows their insert.
 * @param limit - How many.
 * @returns Their ids, oldest first.
 */
export async function listDuePending(limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: refundMailOutbox.id })
    .from(refundMailOutbox)
    .where(
      and(
        eq(refundMailOutbox.status, "pending"),
        lt(refundMailOutbox.createdAt, sql`now() - interval '1 minute'`),
      ),
    )
    .orderBy(asc(refundMailOutbox.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * A disposition's rows still waiting to be sent.
 * @param operationId - The disposition.
 * @returns Their ids.
 */
export async function listPendingOf(operationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: refundMailOutbox.id })
    .from(refundMailOutbox)
    .where(and(eq(refundMailOutbox.operationId, operationId), eq(refundMailOutbox.status, "pending")));
  return rows.map((r) => r.id);
}

/**
 * What one row's letter says (§8), read from our own rows.
 * @param mailId - The row.
 * @returns The view, or null when there is no such row.
 */
export async function getMailView(mailId: string): Promise<RefundMailView | null> {
  const rows = await db
    .select({
      kind: refundMailOutbox.kind,
      email: users.email,
      metadata: payments.metadata,
      paymentId: payments.id,
      currency: payments.currency,
      credits: creditLots.purchasedCredits,
      purchasedAt: creditLots.createdAt,
      requestedAt: creditRefundOperations.refundRequestedAt,
      settledCents: creditRefundOperations.settledSucceededCents,
      finishedAt: creditRefundOperations.finishedAt,
      operationCreatedAt: creditRefundOperations.createdAt,
    })
    .from(refundMailOutbox)
    .innerJoin(creditRefundOperations, eq(creditRefundOperations.id, refundMailOutbox.operationId))
    .innerJoin(creditLots, eq(creditLots.id, creditRefundOperations.lotId))
    .innerJoin(payments, eq(payments.id, creditRefundOperations.paymentId))
    .innerJoin(users, eq(users.id, payments.userId))
    .where(eq(refundMailOutbox.id, mailId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const metadata = row.metadata ?? {};
  const locale = metadata["locale"];
  const timeZone = metadata["timeZone"];
  const base = {
    email: row.email,
    locale: typeof locale === "string" && locale.length > 0 ? locale : "en",
    timeZone: typeof timeZone === "string" && timeZone.length > 0 ? timeZone : "UTC",
    paymentId: row.paymentId,
    credits: Number(row.credits),
    purchasedAt: row.purchasedAt,
  };
  const requestedAt = row.requestedAt ?? row.operationCreatedAt;
  const kind = row.kind as RefundMailKind;
  if (kind !== "refund_completed") return { ...base, kind, requestedAt };
  return {
    ...base,
    kind: "refund_completed",
    // The amount the bell named: the succeeded sum booked.
    amountCents: row.settledCents ?? 0,
    currency: row.currency,
    refundedAt: row.finishedAt ?? row.operationCreatedAt,
  };
}

/**
 * The resend row holding an idempotency key.
 * @param key - The `Idempotency-Key`.
 * @param tx - The caller's transaction, if any.
 * @returns The row and its request hash, or null.
 */
export async function findByKey(key: string, tx?: DbTx): Promise<StoredMail | null> {
  const rows = await (tx ?? db)
    .select()
    .from(refundMailOutbox)
    .where(eq(refundMailOutbox.idempotencyKey, key));
  return rows[0] ? toStored(rows[0]) : null;
}
