// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { eq, sql } from "drizzle-orm";
import { db, creditGrantOperations, creditGrantResultSchema } from "@breatic/core";
import type { DbTx, CreditGrantResult, CreditGrantWrite } from "@breatic/core";

/** The committed key owner and original result. */
export interface StoredGrantOperation { requestHash: string; result: CreditGrantResult }

/**
 * Serialize decisions over one original key before reading or evaluating it.
 * @param key - The stable original request key.
 * @param tx - The transaction holding the identity and funding locks.
 * @throws {Error} When the database cannot acquire the transaction lock.
 */
export async function lockOperationKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit-grant:${key}`}))`);
}

/**
 * Read the original immutable decision without rechecking today's identity.
 * @param key - The stable original request key.
 * @param tx - The transaction holding the identity and funding locks.
 * @returns The original result or null for a currently unused key.
 * @throws {Error} When the database fails or stored data violates the contract.
 */
export async function findOperation(key: string, tx?: DbTx): Promise<StoredGrantOperation | null> {
  const rows = await (tx ?? db).select({ requestHash: creditGrantOperations.requestHash, result: creditGrantOperations.result })
    .from(creditGrantOperations).where(eq(creditGrantOperations.key, key)).limit(1);
  return rows[0] ? { requestHash: rows[0].requestHash, result: creditGrantResultSchema.parse(rows[0].result) } : null;
}

/**
 * Retain every original decision in the transaction that produced its effects.
 * @param input - The validated funding facts.
 * @param input.key - The stable original request key.
 * @param input.hash - The canonical original intent fingerprint.
 * @param input.userId - The product account receiving credits.
 * @param input.adminId - The authenticated back-office operator UUID.
 * @param input.body - The normalized original request body.
 * @param input.result - The immutable decision retained for replay.
 * @param tx - The transaction holding the identity and funding locks.
 * @throws {Error} When the decision cannot be persisted.
 */
export async function insertOperation(input: {
  key: string; hash: string; userId: string; adminId: string; body: CreditGrantWrite; result: CreditGrantResult;
}, tx: DbTx): Promise<void> {
  await tx.insert(creditGrantOperations).values({ key: input.key, requestHash: input.hash, targetUserId: input.userId,
    requestedBy: input.adminId, requestBody: input.body, result: input.result });
}
