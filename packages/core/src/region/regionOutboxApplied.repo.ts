// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The last outbox event the global region applied per region and aggregate
 * (inner#1955), the watermark that keeps each aggregate's events in order and
 * applied at most once.
 */

import { and, eq } from "drizzle-orm";
import type { DbTx } from "@core/db/client.js";
import { regionOutboxApplied } from "@core/db/schema.js";

/**
 * Lock an aggregate's watermark, creating it on first use.
 * @param region - The region.
 * @param aggregateKey - The aggregate.
 * @param tx - The applying transaction.
 * @returns The last applied id, or null when none was applied yet.
 */
export async function lockLastApplied(region: string, aggregateKey: string, tx: DbTx): Promise<number | null> {
  await tx.insert(regionOutboxApplied).values({ region, aggregateKey, lastId: 0 }).onConflictDoNothing();
  const [row] = await tx
    .select({ lastId: regionOutboxApplied.lastId })
    .from(regionOutboxApplied)
    .where(and(eq(regionOutboxApplied.region, region), eq(regionOutboxApplied.aggregateKey, aggregateKey)))
    .for("update")
    .limit(1);
  return row === undefined || row.lastId === 0 ? null : row.lastId;
}

/**
 * Move an aggregate's watermark to the event just applied.
 * @param region - The region.
 * @param aggregateKey - The aggregate.
 * @param lastId - The event's id.
 * @param tx - The applying transaction.
 */
export async function setLastApplied(region: string, aggregateKey: string, lastId: number, tx: DbTx): Promise<void> {
  await tx
    .update(regionOutboxApplied)
    .set({ lastId, updatedAt: new Date() })
    .where(and(eq(regionOutboxApplied.region, region), eq(regionOutboxApplied.aggregateKey, aggregateKey)));
}
