// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Controlled versioned collection intervals; migration deliberately opens none. */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { accountActivityCoverage } from "@core/db/schema.js";
import type { AccountActivityCoverageEntity } from "@breatic/shared";

/**
 * Serialize a version even before its first interval exists.
 * @param tx - The interval mutation transaction.
 * @param version - Collection contract version.
 * @throws {Error} When the database cannot acquire the lock.
 */
async function lockVersion(tx: DbTx, version: number): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Activity coverage version must be a positive integer");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'account_activity_coverage:' + version}, 0))`);
}

/**
 * Open coverage only after every required collector has been verified.
 * @param version - The complete collection contract version.
 * @param at - Trusted server instant, never a client supplied timestamp.
 * @returns The persisted open interval.
 * @throws {Error} When the version is open, overlaps history, or cannot persist.
 */
export async function openActivityCoverage(version: number, at: Date): Promise<AccountActivityCoverageEntity> {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid activity coverage instant");
  return db.transaction(async (tx) => {
    await lockVersion(tx, version);
    const history = await tx.select().from(accountActivityCoverage).where(and(
      eq(accountActivityCoverage.version, version), isNull(accountActivityCoverage.deletedAt),
    ));
    if (history.some((row) => row.endedAt === null || row.endedAt.getTime() > at.getTime())) {
      throw new Error("Activity coverage is already open or overlaps recorded history");
    }
    const [row] = await tx.insert(accountActivityCoverage).values({ version, startedAt: at }).returning();
    if (!row) throw new Error("Activity coverage insertion returned no interval");
    return row;
  });
}

/**
 * Close the version's open interval without changing its historical start.
 * @param version - Collection contract version being suspended.
 * @param at - Trusted server stop instant.
 * @returns The persisted closed interval.
 * @throws {Error} When no interval is open, the end is invalid, or persistence fails.
 */
export async function closeActivityCoverage(version: number, at: Date): Promise<AccountActivityCoverageEntity> {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid activity coverage instant");
  return db.transaction(async (tx) => {
    await lockVersion(tx, version);
    const history = await tx.select().from(accountActivityCoverage).where(and(
      eq(accountActivityCoverage.version, version), isNull(accountActivityCoverage.deletedAt),
    )).for("update");
    const current = history.find((row) => row.endedAt === null);
    if (!current || at.getTime() <= current.startedAt.getTime()) throw new Error("Activity coverage close must follow an open interval's start");
    const [row] = await tx.update(accountActivityCoverage).set({ endedAt: at }).where(and(
      eq(accountActivityCoverage.id, current.id), isNull(accountActivityCoverage.endedAt),
    )).returning();
    if (!row) throw new Error("Activity coverage changed while closing");
    return row;
  });
}
