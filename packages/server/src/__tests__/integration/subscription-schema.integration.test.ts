// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 订阅的三处数据模型（#106 §5，迁移 0054）。
 *
 * 三件结构性的事，单元测试一个都看不见：
 *
 *   1. `users.stripe_customer_id` —— 认人链路的根。订阅事件上不带任何我们的
 *      标识，是先建 customer 再结账才让事件认得出账号。
 *   2. `subscriptions` 允许同一个账号有多行，唯一约束只在 Stripe 的订阅 id 上。
 *      把唯一约束加到 `user_id` 上会挡住「订过、退了、再订一次」——这是验收第
 *      7 条，而它一旦被挡住，表现是一个已经付了钱的用户拿不到会员。
 *   3. `stripe_webhook_events` 的主键就是幂等本身：同一个事件插第二次必须冲突。
 *      它没有 `deleted_at`，删一行等于允许重放。
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import { initCore } from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "subscription-schema-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Creates a throwaway account.
 * @returns Its id.
 */
async function makeUser(): Promise<string> {
  const email = `sub-schema-${Date.now()}-${Math.random()}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true)
    RETURNING id
  `;
  return row!.id;
}

describe("users.stripe_customer_id (#106 §5.1)", () => {
  it("exists and is nullable", async () => {
    const rows = await sql<
      { data_type: string; is_nullable: string }[]
    >`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'stripe_customer_id'
    `;
    expect(rows, "users.stripe_customer_id is missing").toHaveLength(1);
    // Nullable on purpose: an account that has never tried to pay us has no
    // Stripe customer, and inventing one for every registration would create
    // a Stripe object per signup.
    expect(rows[0]?.is_nullable).toBe("YES");
    expect(rows[0]?.data_type).toBe("character varying");
  });
});

describe("subscriptions (#106 §5.2)", () => {
  it("carries every column the state reading needs", async () => {
    const rows = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'subscriptions'
    `;
    const byName = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    for (const column of [
      "id",
      "user_id",
      "stripe_subscription_id",
      "tier",
      "status",
      "current_period_end",
      "cancel_at_period_end",
      "stripe_item_id",
      "has_pending_update",
      "pending_tier",
      "payable_invoice_url",
      "created_at",
      "updated_at",
      "deleted_at",
    ]) {
      expect(byName.has(column), `subscriptions.${column} is missing`).toBe(
        true,
      );
    }
    // The four that decide which situation an account is in must never be
    // absent: a null there would make the reading answer "unknown" for a
    // subscription that is perfectly well defined.
    expect(byName.get("user_id")).toBe("NO");
    expect(byName.get("stripe_subscription_id")).toBe("NO");
    expect(byName.get("tier")).toBe("NO");
    expect(byName.get("status")).toBe("NO");
  });

  it("lets one account hold several subscriptions over time", async () => {
    // Verifies acceptance item 7. A unique constraint on user_id would make
    // re-subscribing fail after the first subscription ended, and the person
    // hitting it would have already paid.
    const userId = await makeUser();
    try {
      await sql`
        INSERT INTO subscriptions (user_id, stripe_subscription_id, tier, status)
        VALUES (${userId}, 'sub_old', 'pro', 'canceled'),
               (${userId}, 'sub_new', 'team', 'active')
      `;
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM subscriptions WHERE user_id = ${userId}
      `;
      expect(rows[0]?.count).toBe("2");
    } finally {
      await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    }
  });

  it("refuses two rows for the same Stripe subscription", async () => {
    // The other half of the same decision: many rows per account, one row per
    // Stripe subscription. Without it a redelivered `created` event would
    // insert a second row for the same subscription and the account would
    // read as holding two memberships.
    const userId = await makeUser();
    try {
      await sql`
        INSERT INTO subscriptions (user_id, stripe_subscription_id, tier, status)
        VALUES (${userId}, 'sub_dup', 'pro', 'active')
      `;
      await expect(
        sql`
          INSERT INTO subscriptions (user_id, stripe_subscription_id, tier, status)
          VALUES (${userId}, 'sub_dup', 'pro', 'active')
        `,
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    }
  });

  it("defaults the two flags to false", async () => {
    const userId = await makeUser();
    try {
      const [row] = await sql<
        { cancel_at_period_end: boolean; has_pending_update: boolean }[]
      >`
        INSERT INTO subscriptions (user_id, stripe_subscription_id, tier, status)
        VALUES (${userId}, 'sub_flags', 'pro', 'active')
        RETURNING cancel_at_period_end, has_pending_update
      `;
      expect(row?.cancel_at_period_end).toBe(false);
      expect(row?.has_pending_update).toBe(false);
    } finally {
      await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    }
  });

  it("refuses a hard delete of an account that still has subscriptions", async () => {
    // ON DELETE RESTRICT, like the credit ledger's: accounts are soft-deleted,
    // so a hard delete that would orphan this history is refused by the
    // database rather than by convention.
    const userId = await makeUser();
    try {
      await sql`
        INSERT INTO subscriptions (user_id, stripe_subscription_id, tier, status)
        VALUES (${userId}, 'sub_fk', 'pro', 'active')
      `;
      await expect(
        sql`DELETE FROM users WHERE id = ${userId}`,
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    }
  });
});

describe("stripe_webhook_events (#106 §5.3)", () => {
  it("makes a redelivered event collide on the primary key", async () => {
    // This collision IS the idempotency: it is what tells the handler the
    // event has already been processed, inside the same transaction as the
    // tier change it guards.
    const eventId = `evt_${Date.now()}_${Math.random()}`;
    try {
      await sql`
        INSERT INTO stripe_webhook_events (event_id, type)
        VALUES (${eventId}, 'customer.subscription.updated')
      `;
      await expect(
        sql`
          INSERT INTO stripe_webhook_events (event_id, type)
          VALUES (${eventId}, 'customer.subscription.updated')
        `,
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM stripe_webhook_events WHERE event_id = ${eventId}`;
    }
  });

  it("has no deleted_at, because deleting a row would allow a replay", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
    `;
    const names = rows.map((r) => r.column_name);
    expect(names).toContain("created_at");
    expect(names).not.toContain("deleted_at");
  });
});
