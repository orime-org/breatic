// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Membership readings of every live account at a fixed moment (inner#1993
 * §9.3 steps 3 and 8): the cutover takes one snapshot before and one after
 * and compares them account by account, so the reading must follow the given
 * moment rather than the clock, and paging must return each account once.
 */

import { TransactionRollbackError, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  db,
  getMembershipReadingForUser,
  initCore,
  membershipReadingsAt,
  upsertSubscription,
  type MembershipSnapshotRow,
} from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker
}

let sql: ReturnType<typeof postgres>;
const created: string[] = [];

/**
 * A live account on a stored tier.
 * @param tier - The stored tier.
 * @returns Its id.
 */
async function account(tier: "base" | "pro"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`tier-snapshot-${crypto.randomUUID()}@example.test`}, true, ${tier})
    RETURNING id
  `;
  created.push(row!.id);
  return row!.id;
}

/**
 * Every reading at `now`, through the same paging the snapshot script uses.
 * @param now - The moment to read at.
 * @param pageSize - The page size.
 * @returns All rows, in order.
 */
async function readAll(now: Date, pageSize: number): Promise<MembershipSnapshotRow[]> {
  const rows: MembershipSnapshotRow[] = [];
  for await (const row of membershipReadingsAt(now, pageSize)) rows.push(row);
  return rows;
}

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "tier-snapshot-test" } });
});

afterAll(async () => {
  try {
    if (created.length > 0) {
      await sql`DELETE FROM subscriptions WHERE user_id = ANY(${created}::uuid[])`;
      await sql`DELETE FROM users WHERE id = ANY(${created}::uuid[])`;
    }
  } finally {
    await sql?.end({ timeout: 1 });
  }
});

describe("membershipReadingsAt", () => {
  it("reads each live account at the given moment, once, in id order", async () => {
    const base = await account("base");
    const pro = await account("pro");
    const gone = await account("base");
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${gone}`;
    await upsertSubscription(db, {
      userId: pro,
      stripeSubscriptionId: `sub_snapshot_${pro}`,
      tier: "pro",
      period: "month",
      status: "active",
      currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      stripeItemId: null,
      hasPendingUpdate: false,
      pendingTier: null,
      pendingPeriod: null,
      payableInvoiceUrl: null,
      observedAt: new Date("2026-08-18T00:00:00.000Z"),
    });

    // Other suites leave live accounts behind, some deliberately invalid to
    // test that readings refuse them. Read inside one transaction that first
    // hides every other live account, then roll it back: core's `db` runs
    // on the open transaction in this async flow.
    const rolledBack = db.transaction(async (tx) => {
      await tx.execute(drizzleSql`UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL AND id NOT IN (${base}, ${pro})`);
      const during = await readAll(new Date("2026-08-01T00:00:00Z"), 1);
      const ids = during.map((r) => r.userId);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(gone);
      const at = (rows: MembershipSnapshotRow[], id: string): MembershipSnapshotRow | undefined => rows.find((r) => r.userId === id);
      expect(at(during, base)).toMatchObject({ effectiveTier: "base", settlementProtected: false });
      expect(at(during, pro)).toMatchObject({ effectiveTier: "pro", settlementProtected: false });
      expect(Object.keys(at(during, pro)!.limits ?? {}).sort()).toEqual(
        ["concurrent_editors", "project_members", "projects_per_studio", "storage_bytes", "studio_members", "team_studios"],
      );

      // The snapshot reads what every reading reads: the same row the
      // single-account reader gives at that moment.
      const now = await readAll(new Date(), 1000);
      for (const id of [base, pro]) {
        const single = await getMembershipReadingForUser(id);
        expect(at(now, id)).toEqual({
          userId: id,
          effectiveTier: single.effectiveTier,
          limits: single.limits,
          settlementProtected: single.settlementProtected,
        });
      }

      // Long after the paid period ended, the same rows read as lapsed.
      const later = await readAll(new Date("2027-06-01T00:00:00Z"), 1000);
      expect(at(later, pro)).toMatchObject({ effectiveTier: "base" });
      tx.rollback();
    });
    await expect(rolledBack).rejects.toBeInstanceOf(TransactionRollbackError);
  });
});
