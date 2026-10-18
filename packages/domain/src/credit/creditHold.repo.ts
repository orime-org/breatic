// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `credit_holds` table (inner#1611): credits reserved for work that has
 * started and not yet been charged.
 *
 * Every write that grows a hold runs under the studio's debt lock, which the
 * caller takes first; releasing only shrinks what is held and takes none.
 */

import { and, eq, gt, ne, sql } from "drizzle-orm";
import { db, creditHolds } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** One hold as the engine reads it. */
export interface HoldRow {
  studioId: string;
  /** Decimal string, to the column's scale. */
  amount: string;
  status: "held" | "released";
  /** Whether it still counts: held and not past `expires_at`. */
  active: boolean;
}

/** A hold about to be written. */
export interface NewHold {
  studioId: string;
  actorUserId: string;
  referenceId: string;
  /** Decimal string. */
  amount: string;
  expiresAt: Date;
}

/**
 * What a studio's counted holds add up to.
 * @param studioId - The studio.
 * @param tx - Optional transaction, so an admission sums under its lock.
 * @param excludeReferenceId - A hold to leave out, when it is the one being resized.
 * @returns The sum as a decimal string; "0" when nothing is held.
 */
export async function sumHeldForStudio(
  studioId: string,
  tx?: DbTx,
  excludeReferenceId?: string,
): Promise<string> {
  const rows = await (tx ?? db)
    .select({ total: sql<string>`COALESCE(SUM(${creditHolds.amount}), 0)::text` })
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.studioId, studioId),
        eq(creditHolds.status, "held"),
        gt(creditHolds.expiresAt, sql`now()`),
        excludeReferenceId === undefined ? undefined : ne(creditHolds.referenceId, excludeReferenceId),
      ),
    );
  return rows[0]?.total ?? "0";
}

/**
 * Read one hold.
 * @param referenceId - Its key.
 * @param tx - Optional transaction.
 * @param forUpdate - Lock the row, for a write that reads it first.
 * @returns The hold, or null when the key has none.
 */
export async function findHold(referenceId: string, tx?: DbTx, forUpdate = false): Promise<HoldRow | null> {
  const query = (tx ?? db)
    .select({
      studioId: creditHolds.studioId,
      amount: sql<string>`${creditHolds.amount}::text`,
      status: creditHolds.status,
      active: sql<boolean>`${creditHolds.status} = 'held' AND ${creditHolds.expiresAt} > now()`,
    })
    .from(creditHolds)
    .where(eq(creditHolds.referenceId, referenceId));
  const rows = forUpdate ? await query.for("update") : await query;
  return rows[0] ?? null;
}

/**
 * Write a hold, unless its key already has one.
 * @param hold - The hold.
 * @param tx - Optional transaction.
 */
export async function insertHold(hold: NewHold, tx?: DbTx): Promise<void> {
  await (tx ?? db).insert(creditHolds).values(hold).onConflictDoNothing({ target: creditHolds.referenceId });
}

/**
 * Move a held hold to a new amount and expiry.
 * @param referenceId - Its key.
 * @param amount - Decimal string.
 * @param expiresAt - The new expiry.
 * @param tx - The transaction holding the studio's debt lock.
 */
export async function updateHold(referenceId: string, amount: string, expiresAt: Date, tx: DbTx): Promise<void> {
  await tx
    .update(creditHolds)
    .set({ amount, expiresAt, updatedAt: new Date() })
    .where(and(eq(creditHolds.referenceId, referenceId), eq(creditHolds.status, "held")));
}

/**
 * Release a hold. A key with no hold, or one already released, is left alone.
 * @param referenceId - Its key.
 * @param tx - Optional transaction, so a charge releases in its own commit.
 */
export async function releaseHold(referenceId: string, tx?: DbTx): Promise<void> {
  const now = new Date();
  await (tx ?? db)
    .update(creditHolds)
    .set({ status: "released", releasedAt: now, updatedAt: now })
    .where(and(eq(creditHolds.referenceId, referenceId), eq(creditHolds.status, "held")));
}
