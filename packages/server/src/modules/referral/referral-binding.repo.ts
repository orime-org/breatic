// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { eq } from "drizzle-orm";
import { db, referralBindings, referralCodes } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { SignupReferralSource } from "@breatic/shared";

export type ReferralSource = SignupReferralSource | "later";

export interface StoredReferralBinding {
  referralCodeId: string;
  source: ReferralSource;
  createdAt: Date;
}

/**
 * Reads the code an account carries.
 * @param userId - The account.
 * @param tx - The caller's transaction, if any.
 * @returns The binding, or null when the account carries none.
 */
export async function findBindingByUser(userId: string, tx?: DbTx): Promise<StoredReferralBinding | null> {
  const rows = await (tx ?? db)
    .select({ referralCodeId: referralBindings.referralCodeId, source: referralBindings.source, createdAt: referralBindings.createdAt })
    .from(referralBindings)
    .where(eq(referralBindings.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Attaches a code to an account for good.
 * @param input - The account, the code row and where the code came from.
 * @param input.userId - The account.
 * @param input.referralCodeId - The code's row.
 * @param input.source - Where the code came from.
 * @param tx - The transaction that checked the account under its row lock.
 * @throws {Error} if the account already carries a code (unique violation).
 */
export async function insertBinding(
  input: { userId: string; referralCodeId: string; source: ReferralSource },
  tx: DbTx,
): Promise<void> {
  await tx.insert(referralBindings).values(input);
}

/**
 * Reads the code text an account carries, whatever the code's status now.
 * @param userId - The account.
 * @param tx - The caller's transaction, if any.
 * @returns The stored-form code, or null when the account carries none.
 */
export async function findBoundCode(userId: string, tx?: DbTx): Promise<string | null> {
  const rows = await (tx ?? db)
    .select({ code: referralCodes.code })
    .from(referralBindings)
    .innerJoin(referralCodes, eq(referralCodes.id, referralBindings.referralCodeId))
    .where(eq(referralBindings.userId, userId))
    .limit(1);
  return rows[0]?.code ?? null;
}
