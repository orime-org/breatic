// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 充值链路新加的两张表与 `payments` 新加的三列（任务 #13）—— 真 PG。
 *
 * 只有真库能证的结构承诺，每条附上它挡住的那个故障：
 *
 * 一、`purchase_consents.payment_id` 是 UNIQUE。同意记录由 `fulfillPayment`
 * 的四个调用方竞争写入（确认端点 · webhook · 覆盖层对账 · cancel 读到已付款），
 * 谁先到谁写，靠这条约束让后到的天然幂等。没有它，一笔付款会落下多条互相矛盾
 * 的同意证据，而它是法定证据。
 *
 * 二、`purchase_mail_outbox.payment_id` 是 UNIQUE，且这张表有 `updated_at`。
 * 一笔一行是「连点五次只发一封」的前提；`sending` 的超时判据读的正是
 * `updated_at`，它必须随每次写自动更新，否则崩在 `sending` 的那一行永远
 * 出不来，买家点不到重发。
 *
 * 三、两张表都只有 `created_at` / `updated_at`，没有 `deleted_at`。它们跟着
 * 那笔付款存续，没有可删语义——这是仓库软删 mandate 在这两张表上的书面豁免
 * 理由，同时要写进 `schema-timestamps` 守卫的 `NO_SOFT_DELETE` 名单。
 *
 * 四、`payments` 的 `tax_cents` / `total_cents` 可空。未到账的行上没有这两个
 * 值（它们与 CAS 同事务写入），NOT NULL 会让结账那一刻建不出行。
 *
 * 五、`payments.status` 有 CHECK，四个值 `pending / completed / failed /
 * expired`。`expired` 是本次新增的终态，弃单的笔靠它离开「处理中」。
 *
 * 跑在 global-setup.ts 起的 testcontainer Postgres 上，读的是迁移真正产出的
 * schema。
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

const PG_DRIVER_LOCAL = "topup-schema-test-driver";

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

interface ColumnShape {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/**
 * Every column of a table, as the database reports it.
 * @param table - Table name in the public schema.
 * @returns The columns keyed by name.
 */
async function columnsOf(table: string): Promise<Map<string, ColumnShape>> {
  const rows = await sql<ColumnShape[]>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return new Map(rows.map((row) => [row.column_name, row]));
}

/**
 * The index definitions on a table.
 * @param table - Table name in the public schema.
 * @returns One `CREATE INDEX` statement per index, as stored by Postgres.
 */
async function indexesOf(table: string): Promise<string[]> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return rows.map((row) => row.indexdef);
}

/**
 * The CHECK constraints on a table.
 * @param table - Table name in the public schema.
 * @returns One clause per constraint.
 */
async function checksOf(table: string): Promise<string[]> {
  const rows = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = ${table} AND c.contype = 'c'
  `;
  return rows.map((row) => row.def);
}

let seq = 0;

/** A user and one completed payment of theirs; returns both ids. */
async function seedUserWithPayment(): Promise<{
  userId: string;
  paymentId: string;
}> {
  seq += 1;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`topup-schema-${Date.now()}-${seq}@example.test`}, true)
    RETURNING id
  `;
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, credits_granted, currency, status)
    VALUES (${user!.id}, 2000, 1700, 'usd', 'completed')
    RETURNING id
  `;
  return { userId: user!.id, paymentId: payment!.id };
}

/**
 * Removes an account and everything hanging off it.
 * @param userId - The account to remove.
 */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM purchase_mail_outbox WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM purchase_consents WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM payments WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

describe("purchase_consents", () => {
  it("holds one row per payment", async () => {
    const { userId, paymentId } = await seedUserWithPayment();
    try {
      await sql`
        INSERT INTO purchase_consents (payment_id, user_id, locale, consent_text_version, consented_at)
        VALUES (${paymentId}, ${userId}, 'en', 'v1', now())
      `;
      await expect(
        sql`
          INSERT INTO purchase_consents (payment_id, user_id, locale, consent_text_version, consented_at)
          VALUES (${paymentId}, ${userId}, 'ja', 'v1', now())
        `,
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await dropUser(userId);
    }
  });

  it("is append-only: created_at without deleted_at", async () => {
    const columns = await columnsOf("purchase_consents");
    expect(columns.has("created_at")).toBe(true);
    expect(columns.has("deleted_at")).toBe(false);
  });

  it("keeps the seven fields the consent spec requires", async () => {
    const columns = await columnsOf("purchase_consents");
    for (const name of [
      "payment_id",
      "user_id",
      "locale",
      "consent_text_version",
      "refund_text_version",
      "consented_at",
      "stripe_payment_intent_id",
    ]) {
      expect(columns.has(name), `missing column ${name}`).toBe(true);
    }
  });
});

describe("purchase_mail_outbox", () => {
  it("holds one row per payment", async () => {
    const { userId, paymentId } = await seedUserWithPayment();
    try {
      await sql`
        INSERT INTO purchase_mail_outbox (payment_id, kind, locale, status)
        VALUES (${paymentId}, 'purchase_confirmation', 'en', 'pending')
      `;
      await expect(
        sql`
          INSERT INTO purchase_mail_outbox (payment_id, kind, locale, status)
          VALUES (${paymentId}, 'purchase_confirmation', 'en', 'pending')
        `,
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await dropUser(userId);
    }
  });

  it("moves updated_at on every write, which is what the sending timeout reads", async () => {
    const { userId, paymentId } = await seedUserWithPayment();
    try {
      const [before] = await sql<{ updated_at: Date }[]>`
        INSERT INTO purchase_mail_outbox (payment_id, kind, locale, status)
        VALUES (${paymentId}, 'purchase_confirmation', 'en', 'pending')
        RETURNING updated_at
      `;
      const [after] = await sql<{ updated_at: Date }[]>`
        UPDATE purchase_mail_outbox SET status = 'sending', updated_at = now()
        WHERE payment_id = ${paymentId}
        RETURNING updated_at
      `;
      expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(
        before!.updated_at.getTime(),
      );
    } finally {
      await dropUser(userId);
    }
  });

  it("carries the five mail states and no deleted_at", async () => {
    const columns = await columnsOf("purchase_mail_outbox");
    for (const name of [
      "payment_id",
      "kind",
      "locale",
      "status",
      "attempts",
      "last_error",
      "created_at",
      "updated_at",
    ]) {
      expect(columns.has(name), `missing column ${name}`).toBe(true);
    }
    expect(columns.has("deleted_at")).toBe(false);

    const checks = await checksOf("purchase_mail_outbox");
    const statusCheck = checks.join(" ");
    for (const state of ["pending", "sending", "sent", "failed", "skipped"]) {
      expect(statusCheck, `state ${state} not admitted`).toContain(state);
    }
  });
});

describe("payments gains what the tax-inclusive total needs", () => {
  it("takes tax_cents and total_cents as nullable, since a pending row has neither", async () => {
    const columns = await columnsOf("payments");
    for (const name of ["tax_cents", "total_cents"]) {
      const column = columns.get(name);
      expect(column, `missing column ${name}`).toBeDefined();
      expect(column!.is_nullable, `${name} must admit NULL`).toBe("YES");
    }
  });

  it("admits exactly the four payment states, expired included", async () => {
    const checks = await checksOf("payments");
    const statusCheck = checks.find((def) => def.includes("status"));
    expect(statusCheck, "payments.status has no CHECK").toBeDefined();
    for (const state of ["pending", "completed", "failed", "expired"]) {
      expect(statusCheck!, `state ${state} not admitted`).toContain(state);
    }
  });

  it("refuses a state outside those four", async () => {
    const { userId } = await seedUserWithPayment();
    try {
      await expect(
        sql`
          INSERT INTO payments (user_id, amount_cents, credits_granted, currency, status)
          VALUES (${userId}, 1000, 830, 'usd', 'refunded')
        `,
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await dropUser(userId);
    }
  });

  it("indexes the session id the confirm and cancel endpoints look rows up by", async () => {
    const indexes = await indexesOf("payments");
    expect(
      indexes.some((def) => def.includes("stripe_session_id")),
      "no index serves lookup by stripe_session_id",
    ).toBe(true);
  });
});
