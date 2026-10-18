// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `credit_holds` table (inner#1611): credits reserved for work that has
 * started and not yet been charged.
 *
 * Every hold is written under the studio's debt lock, which the caller takes
 * first; releasing only shrinks what is held and takes none.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { db, creditHolds } from "@breatic/core";
import type { DbTx } from "@breatic/core";

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
 * @returns The sum as a decimal string; "0" when nothing is held.
 */
export async function sumHeldForStudio(studioId: string, tx?: DbTx): Promise<string> {
  const rows = await (tx ?? db)
    .select({ total: sql<string>`COALESCE(SUM(${creditHolds.amount}), 0)::text` })
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.studioId, studioId),
        eq(creditHolds.status, "held"),
        gt(creditHolds.expiresAt, sql`now()`),
      ),
    );
  return rows[0]?.total ?? "0";
}

/**
 * Write a hold.
 * @param hold - The hold.
 * @param tx - Optional transaction.
 * @throws {Error} When its key already has a hold (`credit_holds_reference_id_idx`).
 */
export async function insertHold(hold: NewHold, tx?: DbTx): Promise<void> {
  await (tx ?? db).insert(creditHolds).values(hold);
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
