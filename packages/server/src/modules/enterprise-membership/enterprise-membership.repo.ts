// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { eq, sql } from "drizzle-orm";
import { db, enterpriseMembershipOperations, enterpriseMembershipResultSchema } from "@breatic/core";
import type { DbTx, EnterpriseMembershipResult, EnterpriseMembershipWrite } from "@breatic/core";

/** The key owner and immutable response of one committed operation. */
export interface StoredMembershipOperation {
  requestHash: string;
  result: EnterpriseMembershipResult;
}

/**
 * Serialize every writer of one request key before reading its committed result.
 * @param key - The stable request key.
 * @param tx - The transaction that owns the decision and its writes.
 * @throws {Error} When the database cannot acquire the transaction lock.
 */
export async function lockOperationKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`enterprise-membership:${key}`}))`);
}

/**
 * Read an immutable operation, including tombstones that still own their key.
 * @param key - The stable request key.
 * @param tx - The transaction holding that key, when present.
 * @returns The stored result or null for a currently unused key.
 * @throws {Error} When the database fails or a stored result violates its contract.
 */
export async function findOperation(key: string, tx?: DbTx): Promise<StoredMembershipOperation | null> {
  const rows = await (tx ?? db).select({ requestHash: enterpriseMembershipOperations.requestHash, result: enterpriseMembershipOperations.result })
    .from(enterpriseMembershipOperations).where(eq(enterpriseMembershipOperations.key, key)).limit(1);
  const row = rows[0];
  return row ? { requestHash: row.requestHash, result: enterpriseMembershipResultSchema.parse(row.result) } : null;
}

/**
 * Save the result in the same transaction as the membership change.
 * @param input - Original request identity and the final result.
 * @param input.key - The stable request key.
 * @param input.hash - The canonical request fingerprint.
 * @param input.userId - The logical target account, which may be absent.
 * @param input.adminId - The operator authenticated by the signature.
 * @param input.body - The validated request facts.
 * @param input.result - The response retained for exact replay.
 * @param tx - The decision transaction.
 * @throws {Error} When storing the result fails.
 */
export async function insertOperation(input: {
  key: string;
  hash: string;
  userId: string;
  adminId: string;
  body: EnterpriseMembershipWrite;
  result: EnterpriseMembershipResult;
}, tx: DbTx): Promise<void> {
  await tx.insert(enterpriseMembershipOperations).values({
    key: input.key,
    requestHash: input.hash,
    targetUserId: input.userId,
    requestedBy: input.adminId,
    requestBody: input.body,
    result: input.result,
  });
}
