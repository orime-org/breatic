// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { eq, sql } from "drizzle-orm";
import { db, influencerOperations } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** One decision of the influencer internal endpoints. */
export type InfluencerDecision = Record<string, unknown> & { status: "created" | "applied" | "refused" };

/** A decision as stored under its key. */
export interface StoredInfluencerOperation { requestHash: string; result: InfluencerDecision }

/**
 * Serialize decisions over one key before reading or evaluating it.
 * @param key - The idempotency key.
 * @param tx - The deciding transaction.
 * @throws {Error} When the lock cannot be taken.
 */
export async function lockOperationKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`influencer:${key}`}))`);
}

/**
 * The decision stored under a key.
 * @param key - The idempotency key.
 * @param tx - The deciding transaction, when there is one.
 * @returns The decision, or null when the key is unused.
 * @throws {Error} When the database read fails.
 */
export async function findOperation(key: string, tx?: DbTx): Promise<StoredInfluencerOperation | null> {
  const rows = await (tx ?? db).select({ requestHash: influencerOperations.requestHash, result: influencerOperations.result })
    .from(influencerOperations).where(eq(influencerOperations.key, key)).limit(1);
  return rows[0] ? { requestHash: rows[0].requestHash, result: rows[0].result as InfluencerDecision } : null;
}

/**
 * Keep a decision under its key, in the transaction that made its effects.
 * @param input - The decision.
 * @param input.key - The idempotency key.
 * @param input.hash - The request's fingerprint.
 * @param input.adminId - The back-office operator.
 * @param input.body - The request body.
 * @param input.result - The decision.
 * @param tx - The deciding transaction.
 * @throws {Error} When the write fails.
 */
export async function insertOperation(input: {
  key: string; hash: string; adminId: string; body: Record<string, unknown>; result: InfluencerDecision;
}, tx: DbTx): Promise<void> {
  await tx.insert(influencerOperations).values({ key: input.key, requestHash: input.hash, requestedBy: input.adminId,
    requestBody: input.body, result: input.result });
}
