// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { eq } from "drizzle-orm";
import { creditRefundRefusals, db, type DbTx } from "@breatic/core";
import type { RefusalBody } from "@server/modules/credit-refund/refusal.js";

/** Original identity shared by all eight internal refund write endpoints. */
export interface RefusalRequest {
  key: string;
  hash: string;
  requestKind: "approve" | "retry" | "reject" | "settle" | "send_back" | "resolve_outside" | "restore_credits" | "resend_mail";
  targetKind: "lot" | "operation";
  targetId: string;
  adminId: string;
  reason: string;
}

/** The committed response used for exact replay. */
export interface StoredRefusal {
  requestHash: string;
  responseStatus: 404 | 409;
  responseBody: RefusalBody;
}

/**
 * Map database columns to the refusal contract.
 * @param row - The stored row.
 * @returns The committed response and fingerprint.
 */
function toStored(row: typeof creditRefundRefusals.$inferSelect): StoredRefusal {
  return {
    requestHash: row.requestHash,
    responseStatus: row.responseStatus as StoredRefusal["responseStatus"],
    responseBody: row.responseBody,
  };
}

/**
 * Find a key including tombstones, which never release key ownership.
 * @param key - The original request key.
 * @param tx - The final decision transaction, if present.
 * @returns The response or null for an unused key.
 */
export async function findByKey(key: string, tx?: DbTx): Promise<StoredRefusal | null> {
  const rows = await (tx ?? db).select().from(creditRefundRefusals).where(eq(creditRefundRefusals.idempotencyKey, key));
  return rows[0] ? toStored(rows[0]) : null;
}

/**
 * Commit a final business refusal under the already locked request key.
 * @param request - Original request identity.
 * @param responseStatus - The final refusal's status.
 * @param responseBody - The literal JSON returned after commit.
 * @param tx - The transaction holding the key lock.
 * @returns The persisted response.
 */
export async function insert(
  request: RefusalRequest,
  responseStatus: 404 | 409,
  responseBody: RefusalBody,
  tx: DbTx,
): Promise<StoredRefusal> {
  const rows = await tx.insert(creditRefundRefusals).values({
    idempotencyKey: request.key,
    requestHash: request.hash,
    requestKind: request.requestKind,
    targetKind: request.targetKind,
    targetId: request.targetId,
    requestedBy: request.adminId,
    requestReason: request.reason,
    responseStatus,
    responseBody,
  }).returning();
  return toStored(rows[0]!);
}
