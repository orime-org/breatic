// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `operations` field of the account membership answer, against real
 * Postgres (inner#1968, test spec I-01 to I-04; design 3.7).
 *
 * The answer reads the account's current period: three counts over the
 * `counted` rows whose `period_start` is that period's start, split by slot,
 * the allowance left, the period's bounds and the overage price. Rows still
 * reserved, released, or counted in an earlier period are not counted. The
 * catalog carries each tier's monthly operations and, in its limits, the
 * running-task cap.
 *
 * The standard account comes from the counting fixtures: a pro account whose
 * subscription anchor is a minute before the database clock, so the current
 * period starts there and ends one calendar month later.
 *
 * Shape this suite chose: `overageCredits` is written the way every
 * `CreditDecimal` is, with six decimals ("0.500000"); the spec's "0.5" is the
 * value, not the wire form.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import { readAccountMembership } from "@server/modules/account/membership.service.js";
import { PAYMENTS_ON, seedAccount, type Account } from "./operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(PAYMENTS_ON);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "account-membership-operations-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * The same instant one calendar month later, the day clamped to the month's last.
 * @param from - The instant.
 * @param months - How many months to move, negative for earlier.
 * @returns The moved instant.
 */
function addMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(from.getUTCDate(), last), from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
}

/**
 * Ledger rows for the account in one state.
 * @param a - The account.
 * @param n - How many.
 * @param state - Their status, and for counted rows their slot and period.
 * @param state.status - The ledger status.
 * @param state.slot - The slot of a counted row.
 * @param state.periodStart - The period of a counted row.
 */
async function ledger(
  a: Account,
  n: number,
  state: { status: "counted" | "reserved" | "released"; slot?: "allowance" | "overage"; periodStart?: Date },
): Promise<void> {
  const counted = state.status === "counted";
  const at = state.periodStart ?? a.periodStart;
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, released_at, expires_at, created_at)
    select 'task:' || gen_random_uuid(), 'generation', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, ${state.status}, 'covered',
      ${counted ? (state.slot ?? "allowance") : null}, ${counted ? at : null}, ${counted ? at : null},
      ${state.status === "released" ? new Date() : null}, now() + interval '1 hour', ${at}
    from generate_series(1, ${n})`;
}

describe("I the account membership answer's operations", () => {
  it("I-01 a pro account with 1240 counted this period reads every field of its operations", async () => {
    const a = await seedAccount(sql, { used: 1240 });
    const { operations } = await readAccountMembership(a.userId);
    expect(operations).toEqual({
      monthlyAllowance: 4000,
      usedThisPeriod: 1240,
      allowanceUsed: 1240,
      allowanceRemaining: 2760,
      overageThisPeriod: 0,
      periodStart: a.periodStart.toISOString(),
      nextResetAt: addMonths(a.periodStart, 1).toISOString(),
      overageCredits: "0.500000",
    });
  });

  it("I-02 4000 allowance and 37 overage read as 4037 used, 4000 of the allowance, none left and 37 over", async () => {
    const a = await seedAccount(sql, { used: 4000 });
    await ledger(a, 37, { status: "counted", slot: "overage" });
    const { operations } = await readAccountMembership(a.userId);
    expect(operations).toMatchObject({ usedThisPeriod: 4037, allowanceUsed: 4000, allowanceRemaining: 0, overageThisPeriod: 37 });
  });

  it("I-03 reserved and released rows and an earlier period's counted rows count in none of the three", async () => {
    const a = await seedAccount(sql, { used: 10 });
    await ledger(a, 3, { status: "reserved" });
    await ledger(a, 2, { status: "released" });
    const earlier = addMonths(a.periodStart, -1);
    await ledger(a, 50, { status: "counted", slot: "allowance", periodStart: earlier });
    await ledger(a, 5, { status: "counted", slot: "overage", periodStart: earlier });
    const { operations } = await readAccountMembership(a.userId);
    expect(operations).toMatchObject({ usedThisPeriod: 10, allowanceUsed: 10, allowanceRemaining: 3990, overageThisPeriod: 0 });
  });

  it("I-04 the catalog offers 500, 4000 and 16000 operations a month and 2, 5 and 10 running tasks", async () => {
    const a = await seedAccount(sql, { credits: 0 });
    const { catalog } = await readAccountMembership(a.userId);
    const offered = catalog.map((offer) => {
      const o = offer as typeof offer & { monthlyOperations?: number };
      const limits = offer.limits as typeof offer.limits & { running_tasks_per_user?: number };
      return [offer.tier, o.monthlyOperations, limits.running_tasks_per_user];
    });
    expect(offered).toEqual([
      ["base", 500, 2],
      ["pro", 4000, 5],
      ["team", 16000, 10],
    ]);
  });
});
