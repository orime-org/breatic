// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { db, enterpriseCreditPurchaseOperations, enterpriseCreditPurchaseResultSchema } from "@breatic/core";
import type { DbTx, EnterpriseCreditPurchaseResult, EnterpriseCreditPurchaseWrite } from "@breatic/core";

/** The persisted original key owner and immutable decision. */
export interface StoredEnterpriseCreditPurchase { requestHash: string; result: EnterpriseCreditPurchaseResult }

/**
 * Serialize all decisions carrying one original purchase key.
 * @param key - The confirmed original key.
 * @param tx - The transaction retaining the creation and decision.
 * @throws {Error} When the database cannot acquire the lock.
 */
export async function lockOperationKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`enterprise-credit-purchase:${key}`}))`);
}

/**
 * Read a committed original decision independently of current membership.
 * @param key - The stable original key.
 * @param tx - The enclosing transaction, when present.
 * @returns The original result or a currently absent operation.
 * @throws {Error} When stored data or the database fails.
 */
export async function findOperation(key: string, tx?: DbTx): Promise<StoredEnterpriseCreditPurchase | null> {
  const [row] = await (tx ?? db).select({ requestHash: enterpriseCreditPurchaseOperations.requestHash, result: enterpriseCreditPurchaseOperations.result })
    .from(enterpriseCreditPurchaseOperations).where(eq(enterpriseCreditPurchaseOperations.key, key)).limit(1);
  return row === undefined ? null : { requestHash: row.requestHash, result: enterpriseCreditPurchaseResultSchema.parse(row.result) };
}

/**
 * Retain the original purchase decision in the transaction creating its effects.
 * @param input - The exact identity, canonical body and validated result.
 * @param input.key - The original confirmation key.
 * @param input.hash - The complete original intent fingerprint.
 * @param input.userId - The target product account.
 * @param input.adminId - The authenticated original operator.
 * @param input.body - The normalized confirmed purchase intent.
 * @param input.result - The immutable original decision.
 * @param tx - The creation transaction.
 * @throws {Error} When the decision cannot be stored.
 */
export async function insertOperation(input: {
  key: string; hash: string; userId: string; adminId: string; body: EnterpriseCreditPurchaseWrite; result: EnterpriseCreditPurchaseResult;
}, tx: DbTx): Promise<void> {
  await tx.insert(enterpriseCreditPurchaseOperations).values({ key: input.key, requestHash: input.hash, targetUserId: input.userId,
    requestedBy: input.adminId, requestBody: input.body, result: input.result });
}
