// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { and, desc, eq, sql } from "drizzle-orm";
import { db, referralBindings, referralCodes, users } from "@breatic/core";
import type { DbTx } from "@breatic/core";

export type ReferralCodeStatus = "active" | "disabled" | "removed";

export interface StoredReferralCode {
  id: string;
  code: string;
  promoterId: string;
  status: ReferralCodeStatus;
}

/**
 * Finds a code by its stored form.
 * @param code - Upper-case code, already parsed.
 * @param tx - The caller's transaction, if any.
 * @returns The code, or null when no promoter holds it.
 */
export async function findCodeByCode(code: string, tx?: DbTx): Promise<StoredReferralCode | null> {
  const rows = await (tx ?? db)
    .select({ id: referralCodes.id, code: referralCodes.code, promoterId: referralCodes.promoterId, status: referralCodes.status })
    .from(referralCodes)
    .where(eq(referralCodes.code, code))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Issues a code to an approved promoter unless another promoter holds it.
 * @param input - The code and who it is for.
 * @param input.code - Stored form.
 * @param input.promoterId - The promoter.
 * @param input.applicationId - The application approved.
 * @param tx - The approval's transaction.
 * @returns The new row's id, or null when the code is taken.
 */
export async function insertCode(
  input: { code: string; promoterId: string; applicationId: string },
  tx: DbTx,
): Promise<string | null> {
  const rows = await tx
    .insert(referralCodes)
    .values(input)
    .onConflictDoNothing({ target: referralCodes.code })
    .returning({ id: referralCodes.id });
  return rows[0]?.id ?? null;
}

/**
 * Locks a code for a status change.
 * @param id - The code row.
 * @param tx - The change's transaction.
 * @returns Its status, or null when there is no such code.
 */
export async function lockCode(id: string, tx: DbTx): Promise<{ id: string; status: ReferralCodeStatus } | null> {
  const rows = await tx
    .select({ id: referralCodes.id, status: referralCodes.status })
    .from(referralCodes)
    .where(eq(referralCodes.id, id))
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Moves a locked code to a new status; removal also stamps when.
 * @param id - The code row.
 * @param status - The new status.
 * @param tx - The change's transaction.
 */
export async function setCodeStatus(id: string, status: ReferralCodeStatus, tx: DbTx): Promise<void> {
  await tx
    .update(referralCodes)
    .set({ status, ...(status === "removed" ? { removedAt: sql`now()` } : {}) })
    .where(eq(referralCodes.id, id));
}

export interface CodeListRow {
  id: string;
  code: string;
  promoterId: string;
  email: string;
  status: ReferralCodeStatus;
  removedAt: Date | null;
  boundAccounts: number;
  createdAt: Date;
  cursorAt: string;
}

/**
 * Lists codes newest first with how many accounts each carries, one row over the page size.
 * @param input - Filter and position.
 * @param input.status - Only this status, when given.
 * @param input.limit - Rows to read, one more than the page size.
 * @param input.after - The last row of the previous page.
 * @returns Rows with the full-precision cursor time.
 */
export async function listCodes(input: {
  status: ReferralCodeStatus | undefined;
  limit: number;
  after: { createdAt: string; id: string } | null;
}): Promise<CodeListRow[]> {
  return db
    .select({
      id: referralCodes.id,
      code: referralCodes.code,
      promoterId: referralCodes.promoterId,
      email: users.email,
      status: referralCodes.status,
      removedAt: referralCodes.removedAt,
      boundAccounts: sql<number>`(select count(*)::int from ${referralBindings} where ${referralBindings.referralCodeId} = ${referralCodes.id})`,
      createdAt: referralCodes.createdAt,
      cursorAt: sql<string>`${referralCodes.createdAt}::text`,
    })
    .from(referralCodes)
    .innerJoin(users, eq(users.id, referralCodes.promoterId))
    .where(
      and(
        input.status ? eq(referralCodes.status, input.status) : undefined,
        input.after
          ? sql`(${referralCodes.createdAt}, ${referralCodes.id}) < (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(referralCodes.createdAt), desc(referralCodes.id))
    .limit(input.limit);
}
