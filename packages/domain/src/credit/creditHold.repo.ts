// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `credit_holds` table (inner#1611): credits reserved for work that has
 * started and not yet been charged.
 *
 * Every hold is written under the studio's debt lock, which the caller takes
 * first; releasing only shrinks what is held and takes none.
 */

import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import { db, creditChargeRequests, creditHolds } from "@breatic/core";
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

/**
 * Keep a held hold alive until a later moment; an earlier one, or a released hold, is left alone.
 * @param referenceId - Its key.
 * @param until - The new expiry.
 * @param tx - Optional transaction handle.
 * @param dueBefore - Extend only a hold expiring before this moment; `until` when absent.
 */
export async function extendHold(referenceId: string, until: Date, tx?: DbTx, dueBefore: Date = until): Promise<void> {
  await (tx ?? db)
    .update(creditHolds)
    .set({ expiresAt: until, updatedAt: new Date() })
    .where(and(eq(creditHolds.referenceId, referenceId), eq(creditHolds.status, "held"), lt(creditHolds.expiresAt, dueBefore), lt(creditHolds.expiresAt, until)));
}

/**
 * What each person spent in a studio over a span (inner#1968, design 3.10):
 * their charge requests created in it, pending or settled, and their counted
 * holds that no pending request has taken over, which that request already
 * counts. Both parts are read in one statement, so they share one snapshot: a
 * request filed between two reads would otherwise leave its hold claimed and
 * itself unseen, and count in neither.
 * @param studioId - The studio.
 * @param from - The span's first instant.
 * @param to - The instant after its last.
 * @param tx - Optional transaction, so an admission sums under its lock.
 * @returns One row per person and part; a person may appear twice.
 */
export async function sumSpentByActor(studioId: string, from: Date, to: Date, tx?: DbTx): Promise<Array<{ actorUserId: string; amount: string }>> {
  const conn = tx ?? db;
  const charged = conn
    .select({ actorUserId: creditChargeRequests.actorUserId, amount: sql<string>`SUM(${creditChargeRequests.amount})::text` })
    .from(creditChargeRequests)
    .where(and(eq(creditChargeRequests.studioId, studioId), gte(creditChargeRequests.createdAt, from), lt(creditChargeRequests.createdAt, to)))
    .groupBy(creditChargeRequests.actorUserId);
  const held = conn
    .select({ actorUserId: creditHolds.actorUserId, amount: sql<string>`SUM(${creditHolds.amount})::text` })
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.studioId, studioId),
        eq(creditHolds.status, "held"),
        gt(creditHolds.expiresAt, sql`now()`),
        sql`NOT EXISTS (SELECT 1 FROM ${creditChargeRequests} WHERE ${creditChargeRequests.status} = 'pending' AND ${creditChargeRequests.releaseHold} = ${creditHolds.referenceId})`,
      ),
    )
    .groupBy(creditHolds.actorUserId);
  return charged.unionAll(held);
}
