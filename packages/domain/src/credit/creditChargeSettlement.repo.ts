// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The global record of every regional charge request settled
 * (inner#1955): one row per region and request id, holding the outcome the
 * first settlement produced, so a retried request is answered with it and
 * charged nothing more.
 */

import { and, eq, sql } from "drizzle-orm";
import { creditChargeSettlements, type DbTx } from "@breatic/core";

/**
 * Take a request's settlement slot, or read the outcome already recorded.
 * The insert waits on a concurrent settlement of the same request and then
 * finds its row, so two settlements of one request never both charge.
 * @param region - The region that filed the request.
 * @param requestId - The request's id there.
 * @param tx - The settlement transaction.
 * @returns `{ claimed: true }` for the first settlement, or the recorded outcome.
 */
export async function claim(
  region: string,
  requestId: string,
  tx: DbTx,
): Promise<{ claimed: true } | { claimed: false; outcome: unknown }> {
  const inserted = await tx
    .insert(creditChargeSettlements)
    .values({ region, requestId, outcome: sql`'{}'::jsonb` })
    .onConflictDoNothing()
    .returning({ id: creditChargeSettlements.id });
  if (inserted.length > 0) return { claimed: true };
  const [row] = await tx
    .select({ outcome: creditChargeSettlements.outcome })
    .from(creditChargeSettlements)
    .where(and(eq(creditChargeSettlements.region, region), eq(creditChargeSettlements.requestId, requestId)))
    .limit(1);
  return { claimed: false, outcome: row?.outcome ?? null };
}

/**
 * Record the outcome of the settlement that claimed the slot.
 * @param region - The region that filed the request.
 * @param requestId - The request's id there.
 * @param outcome - What was charged.
 * @param tx - The settlement transaction.
 */
export async function recordOutcome(region: string, requestId: string, outcome: Record<string, unknown>, tx: DbTx): Promise<void> {
  await tx
    .update(creditChargeSettlements)
    .set({ outcome })
    .where(and(eq(creditChargeSettlements.region, region), eq(creditChargeSettlements.requestId, requestId)));
}
