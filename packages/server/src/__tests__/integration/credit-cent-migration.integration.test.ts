// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Migration 0100 (inner#1666) on balances written before charges were
 * rounded to whole cents: a lot's remaining is cut down to two decimals, a
 * debt and a running hold are raised to two decimals, and every change to a
 * lot or a debt leaves a `rounding_adjustment` row so both still reconcile
 * against the ledger. Each case replays the migration inside a transaction
 * that is rolled back.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import {
  seedDesignatedLot,
  seedStudioFixture,
  type StudioFixture,
} from "@server/__tests__/integration/studio-credit-fixtures.js";

const MIGRATION = new URL(
  "../../../../core/src/db/migrations/0100_credit_cent_rounding.sql",
  import.meta.url,
);
const APP = "credit-cent-migration-test";

let sql: ReturnType<typeof postgres>;
let statements: string[];

beforeAll(async () => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: APP } });
  statements = (await readFile(MIGRATION, "utf8")).split("--> statement-breakpoint");
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  initCore(process.env);
});

class Rollback extends Error {}

/**
 * Run `body` in a transaction that is always rolled back.
 * @param body - Replays the migration and reads what it left.
 * @returns What `body` returned.
 */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (tx) => {
      result = await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return result as T;
}

/**
 * Replay every statement of the migration.
 * @param tx - The transaction to run them in.
 */
async function migrate(tx: postgres.TransactionSql): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement);
}

/**
 * Give a lot the remaining an unrounded charge left, with the spend row that
 * left it, as charges did before this change.
 * @param db - Where to write.
 * @param fx - Whose lot.
 * @param lotId - The lot.
 * @param spent - What the charge took, with up to six decimals.
 */
async function spendUnrounded(db: postgres.Sql | postgres.TransactionSql, fx: StudioFixture, lotId: string, spent: string): Promise<void> {
  await db`UPDATE credit_lots SET remaining_credits = remaining_credits - ${spent}::numeric WHERE id = ${lotId}`;
  await db`
    INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, studio_id, project_id, entry_type, amount)
    VALUES (${fx.userId}, ${fx.userId}, ${lotId}, ${fx.studioId}, ${fx.projectId}, 'spend', ${`-${spent}`}::numeric)
  `;
}

/**
 * Give a studio an unrounded debt, with the row that recorded it.
 * @param db - Where to write.
 * @param fx - Whose studio.
 * @param owed - What it owes, with up to six decimals.
 */
async function oweUnrounded(db: postgres.Sql | postgres.TransactionSql, fx: StudioFixture, owed: string): Promise<void> {
  await db`
    INSERT INTO studio_credit_debts (studio_id, amount) VALUES (${fx.studioId}, ${owed}::numeric)
    ON CONFLICT (studio_id) DO UPDATE SET amount = studio_credit_debts.amount + EXCLUDED.amount
  `;
  await db`
    INSERT INTO credit_ledger (actor_user_id, studio_id, project_id, entry_type, amount)
    VALUES (${fx.userId}, ${fx.studioId}, ${fx.projectId}, 'debt_incurred', ${`-${owed}`}::numeric)
  `;
}

/**
 * A lot's remaining, lifecycle and ledger sum.
 * @param db - Where to read.
 * @param lotId - The lot.
 * @returns The three, as text.
 */
async function lotState(
  db: postgres.Sql | postgres.TransactionSql,
  lotId: string,
): Promise<{ remaining: string; lifecycle: string; ledger: string }> {
  const [row] = await db<{ remaining: string; lifecycle: string; ledger: string }[]>`
    SELECT l.remaining_credits::text AS remaining, l.lifecycle,
           (SELECT COALESCE(SUM(amount), 0)::text FROM credit_ledger WHERE lot_id = l.id) AS ledger
    FROM credit_lots l WHERE l.id = ${lotId}
  `;
  return row!;
}

/**
 * A studio's debt, and what its ledger rows say it should be.
 * @param db - Where to read.
 * @param studioId - The studio.
 * @returns Both, as numbers.
 */
async function debtState(db: postgres.Sql | postgres.TransactionSql, studioId: string): Promise<{ amount: string; reconciled: string }> {
  const [row] = await db<{ amount: string; reconciled: string }[]>`
    SELECT (SELECT amount::text FROM studio_credit_debts WHERE studio_id = ${studioId}) AS amount,
           (SELECT (COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debt_repayment'), 0)
                  - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debt_incurred'), 0)
                  - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'rounding_adjustment' AND lot_id IS NULL), 0))::numeric(20, 6)::text
            FROM credit_ledger WHERE studio_id = ${studioId}) AS reconciled
  `;
  return row!;
}

describe("migration 0100 on unrounded balances", () => {
  it("cuts a lot's remaining down to two decimals and records the difference", async () => {
    const fx = await seedStudioFixture(sql, "cent-mig");
    const lotId = await seedDesignatedLot(sql, fx, 100);
    await spendUnrounded(sql, fx, lotId, "87.654322");

    const after = await rolledBack(async (tx) => {
      await migrate(tx);
      const [adjustment] = await tx<{ amount: string; payer: string; studio: string | null }[]>`
        SELECT amount::text, payer_user_id AS payer, studio_id AS studio
        FROM credit_ledger WHERE lot_id = ${lotId} AND entry_type = 'rounding_adjustment'
      `;
      return { lot: await lotState(tx, lotId), adjustment };
    });

    expect(after.lot).toEqual({ remaining: "12.340000", lifecycle: "active", ledger: "12.340000" });
    expect(after.adjustment).toEqual({ amount: "-0.005678", payer: fx.userId, studio: null });
  });

  it("marks a lot depleted when cutting it leaves nothing", async () => {
    const fx = await seedStudioFixture(sql, "cent-mig");
    const lotId = await seedDesignatedLot(sql, fx, 1);
    await spendUnrounded(sql, fx, lotId, "0.995679");

    const after = await rolledBack(async (tx) => {
      await migrate(tx);
      return lotState(tx, lotId);
    });

    expect(after).toEqual({ remaining: "0.000000", lifecycle: "depleted", ledger: "0.000000" });
  });

  it("raises a debt to two decimals and keeps it reconciled, off the Studio's own ledger", async () => {
    const fx = await seedStudioFixture(sql, "cent-mig");
    await oweUnrounded(sql, fx, "0.123456");

    const after = await rolledBack(async (tx) => {
      await migrate(tx);
      const [adjustment] = await tx<{ amount: string; payer: string | null; lot: string | null }[]>`
        SELECT amount::text, payer_user_id AS payer, lot_id AS lot
        FROM credit_ledger WHERE studio_id = ${fx.studioId} AND entry_type = 'rounding_adjustment'
      `;
      return { debt: await debtState(tx, fx.studioId), adjustment };
    });

    expect(after.debt).toEqual({ amount: "0.130000", reconciled: "0.130000" });
    expect(after.adjustment).toEqual({ amount: "-0.006544", payer: null, lot: null });
  });

  it("raises a running hold to two decimals and leaves a released one as it was", async () => {
    const fx = await seedStudioFixture(sql, "cent-mig");
    const running = `cent-mig-held-${Date.now()}`;
    const released = `cent-mig-released-${Date.now()}`;
    await sql`
      INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, status, expires_at, released_at)
      VALUES (${fx.studioId}, ${fx.userId}, ${running}, 3.075123, 'held', now() + interval '1 hour', NULL),
             (${fx.studioId}, ${fx.userId}, ${released}, 3.075123, 'released', now() + interval '1 hour', now())
    `;

    const after = await rolledBack(async (tx) => {
      await migrate(tx);
      return tx<{ reference_id: string; amount: string }[]>`
        SELECT reference_id, amount::text FROM credit_holds WHERE reference_id IN (${running}, ${released}) ORDER BY status
      `;
    });

    expect(after).toEqual([
      { reference_id: running, amount: "3.080000" },
      { reference_id: released, amount: "3.075123" },
    ]);
  });

  it("changes nothing when it runs a second time", async () => {
    const fx = await seedStudioFixture(sql, "cent-mig");
    const lotId = await seedDesignatedLot(sql, fx, 100);
    await spendUnrounded(sql, fx, lotId, "1.000001");
    await oweUnrounded(sql, fx, "0.000001");

    const rows = await rolledBack(async (tx) => {
      await migrate(tx);
      const [first] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM credit_ledger WHERE entry_type = 'rounding_adjustment'`;
      await migrate(tx);
      const [second] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM credit_ledger WHERE entry_type = 'rounding_adjustment'`;
      return { first: first!.n, second: second!.n, lot: await lotState(tx, lotId), debt: await debtState(tx, fx.studioId) };
    });

    expect(rows.second).toBe(rows.first);
    expect(rows.lot).toMatchObject({ remaining: "98.990000", ledger: "98.990000" });
    expect(rows.debt).toEqual({ amount: "0.010000", reconciled: "0.010000" });
  });

  it("waits for a charge already under way and reconciles what that charge left", async () => {
    const fx = await seedStudioFixture(sql, "cent-mig");
    const lotId = await seedDesignatedLot(sql, fx, 100);
    await spendUnrounded(sql, fx, lotId, "0.000001");

    // A charge from a server still running the old code: it has locked the
    // lot and has not written yet when the migration starts.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const charge = sql.begin(async (tx) => {
      await tx`SELECT id FROM credit_lots WHERE id = ${lotId} FOR UPDATE`;
      locked();
      await gate;
      await spendUnrounded(tx, fx, lotId, "0.123456");
    });
    await lockTaken;

    const migrated = rolledBack(async (tx) => {
      await migrate(tx);
      return lotState(tx, lotId);
    });
    // pg_stat_activity keeps the first 1 KB of a statement, which the
    // migration's header comment fills before its LOCK TABLE line.
    await waitUntilBlockedOn(sql, ["every charge now settles to whole hundredths"], 1);
    release();
    await charge;

    // 100 - 0.000001 - 0.123456 = 99.876543, cut to 99.87.
    expect(await migrated).toEqual({ remaining: "99.870000", lifecycle: "active", ledger: "99.870000" });
  });
});
