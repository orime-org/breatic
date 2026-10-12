// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's analytics record on `users` (inner#1442 design §4.4.6, §4.5):
 * the latest consent its browsers reported and the campaign source kept at
 * sign-up. Here because server, worker and collab all read it.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { AccountConsent, Attribution } from "@breatic/shared";
import { db, type DbTx } from "@core/db/client.js";
import { users } from "@core/db/schema.js";

/**
 * Read the latest analytics consent the account's browsers reported.
 * @param userId - The account.
 * @param tx - When given, the row is locked until the transaction ends so a
 *   concurrent report cannot interleave between read and write.
 * @returns The stored choice, or null when none is on record or the account is gone.
 */
export async function getAccountConsent(userId: string, tx?: DbTx): Promise<AccountConsent | null> {
  const where = and(eq(users.id, userId), isNull(users.deletedAt));
  const query = (tx ?? db).select({ consent: users.analyticsConsent }).from(users).where(where).limit(1);
  const rows = tx ? await query.for("update") : await query;
  return rows[0]?.consent ?? null;
}

/**
 * Overwrite the account's analytics consent.
 * @param userId - The account.
 * @param consent - The merged choice to keep.
 * @param tx - The transaction holding the row lock from {@link getAccountConsent}.
 */
export async function setAccountConsent(userId: string, consent: AccountConsent, tx: DbTx): Promise<void> {
  await tx.update(users).set({ analyticsConsent: consent }).where(eq(users.id, userId));
}

/**
 * Read the campaign source recorded at sign-up.
 * @param userId - The account.
 * @returns It, or null when none was kept.
 */
export async function getAccountAttribution(userId: string): Promise<Attribution | null> {
  const rows = await db.select({ attribution: users.attribution }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.attribution ?? null;
}
