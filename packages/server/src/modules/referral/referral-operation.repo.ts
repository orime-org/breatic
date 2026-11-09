// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { eq, sql } from "drizzle-orm";
import { db, referralOperations } from "@breatic/core";
import type { DbTx } from "@breatic/core";

export type ReferralOperationKind = "approve" | "reject" | "disable" | "enable" | "remove";
export type ReferralOperationResult = { status: "applied" | "refused" } & Record<string, unknown>;

/**
 * Serialises every write under one back-office key until the transaction ends.
 * @param key - The idempotency key.
 * @param tx - The write's transaction.
 */
export async function lockOperationKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral:${key}`}))`);
}

/**
 * Reads the original answer stored under a key.
 * @param key - The idempotency key.
 * @param tx - The caller's transaction, if any.
 * @returns The request fingerprint and the answer, or null for a new key.
 */
export async function findOperation(
  key: string,
  tx?: DbTx,
): Promise<{ requestHash: string; result: ReferralOperationResult } | null> {
  const rows = await (tx ?? db)
    .select({ requestHash: referralOperations.requestHash, result: referralOperations.result })
    .from(referralOperations)
    .where(eq(referralOperations.key, key))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stores a write's answer under its key, in the write's own transaction.
 * @param input - The key, what was asked and what was answered.
 * @param input.key - The idempotency key.
 * @param input.kind - Which write.
 * @param input.targetId - The application or code written to.
 * @param input.hash - The request fingerprint.
 * @param input.adminId - Who asked.
 * @param input.body - The request body.
 * @param input.result - The answer.
 * @param tx - The write's transaction.
 */
export async function insertOperation(
  input: {
    key: string;
    kind: ReferralOperationKind;
    targetId: string;
    hash: string;
    adminId: string;
    body: Record<string, unknown>;
    result: ReferralOperationResult;
  },
  tx: DbTx,
): Promise<void> {
  await tx.insert(referralOperations).values({
    key: input.key,
    kind: input.kind,
    targetId: input.targetId,
    requestHash: input.hash,
    requestedBy: input.adminId,
    requestBody: input.body,
    result: input.result,
  });
}
