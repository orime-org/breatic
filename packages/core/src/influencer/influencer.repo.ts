// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The influencers table (inner#2157): sign-up attribution reads it by host,
 * server CORS and collab admission read every registered host, and the
 * internal endpoints register and disable codes.
 */

import { eq, isNotNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { influencers } from "@core/db/schema.js";

/** One influencer as attribution and the internal endpoints see it. */
export interface InfluencerState {
  code: string;
  enabled: boolean;
}

/**
 * The influencer registered on a host.
 * @param host - A lower-case host name.
 * @returns Its code and whether it is enabled, or null when none is registered.
 * @throws {Error} When the database read fails.
 */
export async function findByHost(host: string): Promise<InfluencerState | null> {
  const rows = await db.select({ code: influencers.code, disabledAt: influencers.disabledAt })
    .from(influencers).where(eq(influencers.host, host)).limit(1);
  return rows[0] ? { code: rows[0].code, enabled: rows[0].disabledAt === null } : null;
}

/**
 * Every registered host, disabled ones included: their existing users keep
 * using the site.
 * @returns The hosts.
 * @throws {Error} When the database read fails.
 */
export async function listHosts(): Promise<string[]> {
  const rows = await db.select({ host: influencers.host }).from(influencers).where(isNotNull(influencers.host));
  return rows.map((row) => row.host!);
}

/**
 * Lock one code's row for a status change.
 * @param code - The influencer code.
 * @param tx - The status change's transaction.
 * @returns Its state, or null when the code is not registered.
 * @throws {Error} When the database read fails.
 */
export async function lockByCode(code: string, tx: DbTx): Promise<InfluencerState | null> {
  const rows = await tx.select({ code: influencers.code, disabledAt: influencers.disabledAt })
    .from(influencers).where(eq(influencers.code, code)).for("update");
  return rows[0] ? { code: rows[0].code, enabled: rows[0].disabledAt === null } : null;
}

/**
 * Which of a code and a host are already taken, disabled rows included.
 * @param input - The candidate.
 * @param input.code - The code.
 * @param input.host - The host.
 * @param tx - The registering transaction.
 * @returns Whether each is taken.
 * @throws {Error} When the database read fails.
 */
export async function findTaken(input: { code: string; host: string }, tx: DbTx): Promise<{ code: boolean; host: boolean }> {
  const rows = await tx.select({ code: influencers.code, host: influencers.host }).from(influencers)
    .where(sql`${influencers.code} = ${input.code} OR ${influencers.host} = ${input.host}`);
  return { code: rows.some((row) => row.code === input.code), host: rows.some((row) => row.host === input.host) };
}

/**
 * Register an influencer.
 * @param input - The influencer.
 * @param input.code - Its code.
 * @param input.host - Its site's lower-case host.
 * @param tx - The registering transaction, when there is one.
 * @throws {Error} When the code or host is taken or the write fails.
 */
export async function insertInfluencer(input: { code: string; host: string }, tx?: DbTx): Promise<void> {
  await (tx ?? db).insert(influencers).values({ code: input.code, host: input.host });
}

/**
 * Disable an influencer at an instant, or enable it again with null.
 * @param code - The influencer code.
 * @param disabledAt - When it was disabled, or null to enable it.
 * @param tx - The status change's transaction, when there is one.
 * @throws {Error} When the write fails.
 */
export async function setInfluencerDisabled(code: string, disabledAt: Date | null, tx?: DbTx): Promise<void> {
  await (tx ?? db).update(influencers).set({ disabledAt }).where(eq(influencers.code, code));
}
