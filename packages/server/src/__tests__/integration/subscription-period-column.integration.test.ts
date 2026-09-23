// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A subscription now records which billing period it was bought over
 * (#253, design section 1.4).
 *
 * The tier alone no longer says what somebody pays: PRO monthly and PRO
 * annual are the same tier at two prices, over two lengths of time. The panel
 * prints the price, the renewal date and what the account may move to from
 * this row, and all three differ by period.
 *
 * `period` is NOT NULL with no default. A default would let a writer that
 * forgot the column land silently on monthly, and the one thing worse than a
 * subscription with no period is one that quietly claims the cheaper one.
 *
 * `pending_period` is nullable: most subscriptions have no move in flight.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inject } from "vitest";

let sql: ReturnType<typeof postgres> | undefined;
let userId: string;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 1 });
  // A real account, because the rows below go through the real table and its
  // user_id is a foreign key: a made-up id would be refused by the key long
  // before the period check had anything to say.
  const [user] = (await sql`
    INSERT INTO users (email, email_verified)
    VALUES (${`period-check-${Date.now()}@example.test`}, true)
    RETURNING id
  `) as unknown as { id: string }[];
  userId = user!.id;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** One row of `information_schema.columns`, as far as this suite reads it. */
type ColumnRow = {
  column_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

describe("subscriptions.period", () => {
  it("is present, NOT NULL, and carries no default", async () => {
    const rows = (await sql!`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'subscriptions' AND column_name = 'period'
    `) as unknown as ColumnRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe("NO");
    expect(rows[0]!.column_default).toBeNull();
  });

  it("stores both of the periods the product sells", async () => {
    for (const period of ["month", "year"]) {
      const [row] = (await sql!`
        INSERT INTO subscriptions
          (user_id, stripe_subscription_id, tier, status, period)
        VALUES
          (${userId}, ${`sub_accepts_${period}`}, 'pro', 'active', ${period})
        RETURNING period
      `) as unknown as { period: string }[];
      expect(row!.period).toBe(period);
    }
  });

  it("refuses a period the product does not sell", async () => {
    // Written through the real table so the CHECK is what refuses it, rather
    // than a copy of the list in this file.
    await expect(
      sql!`
        INSERT INTO subscriptions
          (user_id, stripe_subscription_id, tier, status, period)
        VALUES
          (${userId}, 'sub_period_check', 'pro', 'active', 'week')
      `,
    ).rejects.toThrow(/subscriptions_period_check|violates check constraint/);
  });
});

describe("subscriptions.pending_period", () => {
  it("is present and nullable, because most subscriptions have no move in flight", async () => {
    const rows = (await sql!`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'subscriptions' AND column_name = 'pending_period'
    `) as unknown as ColumnRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe("YES");
  });

  it("refuses a pending period the product does not sell", async () => {
    await expect(
      sql!`
        INSERT INTO subscriptions
          (user_id, stripe_subscription_id, tier, status, period, pending_period)
        VALUES
          (${userId}, 'sub_pending_check', 'pro', 'active', 'month', 'week')
      `,
    ).rejects.toThrow(
      /subscriptions_pending_period_check|violates check constraint/,
    );
  });
});
