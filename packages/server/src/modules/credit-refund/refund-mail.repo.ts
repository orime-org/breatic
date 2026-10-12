// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `refund_mail_outbox` (inner#1410 §6.5).
 */

import { eq } from "drizzle-orm";
import { db, refundMailOutbox } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** Which buyer email. */
export type RefundMailKind = "refund_completed" | "refund_rejected";

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
