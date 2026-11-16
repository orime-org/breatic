// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Studio ids the global region gave up creating in this region (inner#1955),
 * and the per-id lock creation and abandonment decide under.
 */

import { eq, sql } from "drizzle-orm";
import { studioCreationTombstones, type DbTx } from "@breatic/core";

/**
 * Hold one Studio id for this transaction.
 * @param studioId - The id.
 * @param tx - The transaction holding the lock.
 */
export async function lockStudioId(studioId: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`studio-create:${studioId}`}))`);
}

/**
 * Whether the global region gave this id up.
 * @param studioId - The id.
 * @param tx - The transaction to read in.
 * @returns True when a tombstone exists.
 */
export async function isAbandoned(studioId: string, tx: DbTx): Promise<boolean> {
  const rows = await tx
    .select({ id: studioCreationTombstones.id })
    .from(studioCreationTombstones)
    .where(eq(studioCreationTombstones.studioId, studioId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record that the global region gave this id up.
 * @param studioId - The id.
 * @param tx - The transaction holding its lock.
 */
export async function recordAbandoned(studioId: string, tx: DbTx): Promise<void> {
  await tx.insert(studioCreationTombstones).values({ studioId }).onConflictDoNothing();
}
