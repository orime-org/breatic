// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two tables the lot-based credits model is built on (task #11,
 * migration 0061): `credit_lots` and `credit_ledger`.
 *
 * A lot is one top-up. Credits are spent lot by lot, oldest first, and only
 * out of lots designated to the studio doing the spending — so every question
 * the product asks about credits ("how much can this studio spend", "who paid
 * for this generation", "how much of this purchase is left to refund") is a
 * question about a row here.
 *
 * Structural promises no unit test can see, each with the failure it pins:
 *
 *   1. `credit_lots.payment_id` is NOT NULL and UNIQUE. This — and nothing
 *      else — is what makes a payment land exactly once. `payments` cannot
 *      hold that line: `stripe_payment_intent_id` has no unique index at all,
 *      and the one on `stripe_session_id` sits on a nullable column, where
 *      Postgres admits any number of NULLs. Without the constraint here, a
 *      redelivered webhook grants the credits a second time.
 *
 *   2. `credit_ledger.lot_id` is NULLABLE while `payer_user_id` is NOT NULL.
 *      With payments disabled — every local install and every self-hosted
 *      one — a generation still records what it used, but there is no lot to
 *      attribute it to. Making `lot_id` NOT NULL would either lose that usage
 *      record or force a fake lot; making `payer_user_id` nullable would drop
 *      the row out of the account ledger, which reads by payer.
 *
 *   3. `credit_ledger` has `created_at` and NEITHER `updated_at` NOR
 *      `deleted_at`. It is append-only: a row records that something already
 *      happened, and removing it would make that thing repeatable. This is
 *      the written reason the repository's soft-delete mandate is waived here.
 *
 *   4. Credits are `numeric(20,6)`, not double precision. A charge is a
 *      fraction of a cent and is summed across lots; binary floating point
 *      would leave a lot holding a residue no user could spend and no refund
 *      could return.
 *
 *   5. Both spend paths have an index that serves them: taking the next lot
 *      for a studio, and reading a studio's ledger. Their absence is a
 *      sequential scan on the hot path of every generation.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts, so what
 * it reads is the schema the migration actually produced.
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

const PG_DRIVER_LOCAL = "credits-schema-test-driver";

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
  numeric_precision: number | null;
  numeric_scale: number | null;
  column_default: string | null;
}

/**
 * Every column of a table, as the database reports it.
 * @param table - Table name in the public schema.
 * @returns The columns keyed by name.
 */
async function columnsOf(table: string): Promise<Map<string, ColumnShape>> {
  const rows = await sql<ColumnShape[]>`
    SELECT column_name, data_type, is_nullable,
           numeric_precision, numeric_scale, column_default
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

let seq = 0;

/** A user and one completed payment of theirs; returns both ids. */
async function seedUserWithPayment(): Promise<{
  userId: string;
  paymentId: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`lots-${seq++}@example.test`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const payments = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, status, credits_granted)
    VALUES (${userId}, 1000, 'completed', 880) RETURNING id
  `;
  return { userId, paymentId: payments[0]!.id };
}

describe("credit_lots", () => {
  it("carries the columns the model is defined in terms of", async () => {
    const cols = await columnsOf("credit_lots");

    // Asserted before anything is read out of the map: with the table
    // missing, every lookup below would yield undefined and the optional
    // chaining would let a "column is nullable" assertion quietly pass.
    expect(cols.size, "credit_lots does not exist").toBeGreaterThan(0);

    expect(cols.get("payment_id")?.is_nullable).toBe("NO");
    expect(cols.get("user_id")?.is_nullable).toBe("NO");
    expect(cols.get("lifecycle")?.is_nullable).toBe("NO");
    // Unassigned is the state a lot is born in, and it is spelled NULL.
    expect(cols.get("designated_studio_id")?.is_nullable).toBe("YES");
    expect(cols.get("refund_attempts")?.is_nullable).toBe("NO");
    expect(cols.get("refund_attempts")?.column_default).toMatch(/0/);
    // Soft delete, per the repository mandate.
    expect(cols.get("deleted_at")?.is_nullable).toBe("YES");
    expect(cols.get("created_at")?.is_nullable).toBe("NO");
    expect(cols.get("updated_at")?.is_nullable).toBe("NO");
  });

  it("holds credits as numeric(20,6), not floating point", async () => {
    const cols = await columnsOf("credit_lots");
    for (const name of ["purchased_credits", "remaining_credits"]) {
      const col = cols.get(name);
      expect(col?.data_type, `${name} is not numeric`).toBe("numeric");
      expect(col?.numeric_precision).toBe(20);
      expect(col?.numeric_scale).toBe(6);
      expect(col?.is_nullable).toBe("NO");
    }
  });

  it("refuses a second lot for the same payment", async () => {
    // The one guarantee that a redelivered webhook cannot grant twice.
    const { userId, paymentId } = await seedUserWithPayment();
    await sql`
      INSERT INTO credit_lots
        (payment_id, user_id, purchased_credits, remaining_credits, lifecycle)
      VALUES (${paymentId}, ${userId}, 880, 880, 'active')
    `;

    await expect(
      sql`
        INSERT INTO credit_lots
          (payment_id, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (${paymentId}, ${userId}, 880, 880, 'active')
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses a lifecycle outside the state machine", async () => {
    // The five states are the whole of §6.1. A row carrying anything else is
    // invisible to every query that filters on `active` — the credits would
    // simply stop existing for their owner, with nothing raised.
    const { userId, paymentId } = await seedUserWithPayment();
    await expect(
      sql`
        INSERT INTO credit_lots
          (payment_id, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (${paymentId}, ${userId}, 880, 880, 'pending')
      `,
    ).rejects.toThrow(/check constraint/i);
  });

  it("refuses a negative remaining balance", async () => {
    // Spending is a subtraction across lots; an off-by-one that overdraws one
    // of them must fail loudly here rather than leave a lot owing credits.
    const { userId, paymentId } = await seedUserWithPayment();
    await expect(
      sql`
        INSERT INTO credit_lots
          (payment_id, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (${paymentId}, ${userId}, 880, -1, 'active')
      `,
    ).rejects.toThrow(/check constraint/i);
  });

  it("indexes the two reads that happen on every charge", async () => {
    const defs = (await indexesOf("credit_lots")).join("\n");
    // Account overview, paged by time.
    expect(defs).toMatch(/\(user_id, created_at\)/);
    // "Next lot this studio may spend from", oldest first.
    expect(defs).toMatch(/\(designated_studio_id, lifecycle, created_at\)/);
  });
});

describe("旧模型退场（0062）", () => {
  it("credit_balances 整张表撤掉了", async () => {
    // 「未指定不能花」之后，账号总额不再是任何一个可花的数字。留着这张表，
    // 就会有人拿它去做判断。
    expect(await columnsOf("credit_balances")).toEqual(new Map());
  });

  it("credit_transactions 改名归档，行还在", async () => {
    // 旧行没有 lot 维度，迁不出「属于哪一笔」，所以新账从新表起。旧行留着
    // 只读，不参与任何查询。
    expect((await columnsOf("credit_transactions")).size).toBe(0);
    expect((await columnsOf("credit_transactions_archived")).size).toBeGreaterThan(0);
  });
});

describe("credit_ledger", () => {
  it("requires a payer but not a lot", async () => {
    const cols = await columnsOf("credit_ledger");
    expect(cols.size, "credit_ledger does not exist").toBeGreaterThan(0);

    // Who the credits belong to. Written even with payments disabled, where
    // the row records usage against a person but against no purchase.
    expect(cols.get("payer_user_id")?.is_nullable).toBe("NO");
    // Which purchase was drawn down — absent exactly in that case.
    expect(cols.get("lot_id")?.is_nullable).toBe("YES");
    // Who did the spending. A studio's guest may spend the admin's credits,
    // so this is a different person from the payer and is absent on top-ups.
    expect(cols.get("actor_user_id")?.is_nullable).toBe("YES");
    expect(cols.get("studio_id")?.is_nullable).toBe("YES");
    expect(cols.get("project_id")?.is_nullable).toBe("YES");
    expect(cols.get("entry_type")?.is_nullable).toBe("NO");
    expect(cols.get("amount")?.is_nullable).toBe("NO");
    expect(cols.get("amount")?.data_type).toBe("numeric");
    expect(cols.get("amount")?.numeric_precision).toBe(20);
    expect(cols.get("amount")?.numeric_scale).toBe(6);
  });

  it("is append-only: created_at only, no updated_at, no deleted_at", async () => {
    const cols = await columnsOf("credit_ledger");
    expect(cols.size, "credit_ledger does not exist").toBeGreaterThan(0);

    expect(cols.get("created_at")?.is_nullable).toBe("NO");
    expect(cols.has("updated_at")).toBe(false);
    expect(cols.has("deleted_at")).toBe(false);
  });

  it("refuses an entry type outside the six", async () => {
    // `topup` / `spend` / `refund` / `refund_rejected` from 0061, plus
    // `debt_incurred` / `debt_repayment` from 0063. Every sum over this table
    // filters on some of them, so a seventh spelling is money that no balance
    // and no ledger view accounts for.
    const { userId } = await seedUserWithPayment();
    await expect(
      sql`
        INSERT INTO credit_ledger (payer_user_id, entry_type, amount)
        VALUES (${userId}, 'deduct', -1)
      `,
    ).rejects.toThrow(/check constraint/i);
  });

  it("indexes the three views that read it", async () => {
    const defs = (await indexesOf("credit_ledger")).join("\n");
    // The account ledger, always taken by payer.
    expect(defs).toMatch(/\(payer_user_id, created_at DESC\)/i);
    // A studio's ledger.
    expect(defs).toMatch(/\(studio_id, created_at DESC\)/i);
    // Per-lot reconciliation: remaining_credits must equal the sum here.
    expect(defs).toMatch(/\(lot_id\)/);
    // "How much of my money has this studio spent" — the payer is part of
    // the question, so the studio-only index above cannot answer it.
    expect(defs).toMatch(/\(payer_user_id, studio_id, created_at DESC\)/i);
  });
});

describe("studio_credit_debts（0063）", () => {
  it("一个 studio 最多一行，欠多少是个不能为负的数", async () => {
    const cols = await columnsOf("studio_credit_debts");
    expect(cols.size, "studio_credit_debts does not exist").toBeGreaterThan(0);

    expect(cols.get("studio_id")?.is_nullable).toBe("NO");
    expect(cols.get("amount")?.is_nullable).toBe("NO");
    expect(cols.get("amount")?.data_type).toBe("numeric");
    expect(cols.get("amount")?.numeric_precision).toBe(20);
    expect(cols.get("amount")?.numeric_scale).toBe(6);
    expect(cols.get("amount")?.column_default).toBe("0");

    const defs = (await indexesOf("studio_credit_debts")).join("\n");
    expect(defs).toMatch(/CREATE UNIQUE INDEX.*\(studio_id\)/i);
  });

  it("没有 deleted_at —— 软删一行欠账就是让这笔债凭空消失", async () => {
    // 这张表存在的唯一目的就是记住这笔债。给它一个能把行藏起来的开关，
    // 跟它的目的正面冲突。studio 被删时债怎么处理是任务 #26 的业务决定。
    const cols = await columnsOf("studio_credit_debts");
    expect(cols.size, "studio_credit_debts does not exist").toBeGreaterThan(0);

    expect(cols.has("created_at")).toBe(true);
    expect(cols.has("updated_at")).toBe(true);
    expect(cols.has("deleted_at")).toBe(false);
  });

  it("欠账不能是负数", async () => {
    const { userId } = await seedUserWithPayment();
    const studios = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${userId}, ${`debt-neg-${seq++}-${Date.now()}`}, 'team', 'Debt')
      RETURNING id
    `;
    await expect(
      sql`
        INSERT INTO studio_credit_debts (studio_id, amount)
        VALUES (${studios[0]!.id}, -1)
      `,
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("欠账带进来的两个流水类型（0063）", () => {
  it("收 debt_incurred 和 debt_repayment", async () => {
    const { userId } = await seedUserWithPayment();
    for (const type of ["debt_incurred", "debt_repayment"]) {
      await expect(
        sql`
          INSERT INTO credit_ledger (payer_user_id, entry_type, amount)
          VALUES (${userId}, ${type}, -1)
        `,
      ).resolves.toBeDefined();
    }
  });
});

describe("退款期间这笔积分不属于任何 studio（0063）", () => {
  it("退款三态的笔不许带着 designation", async () => {
    // user 2026-08-21 定的规则：申请退款那一刻这笔就跟这个 studio 没关系了，
    // 而且在结果出来之前不能再指定给任何一个 studio。不变量 2（欠账时可花
    // 的笔加起来为 0）整个压在这条规则上，所以它得由数据库看着。
    //
    // 「退款流程里的笔扣不到」这个事实，从 0063 起由这一条加上引擎套件里的
    // 「不取未指定的笔」两条合成：退款态必然未指定，未指定的笔取不到。
    const { userId, paymentId } = await seedUserWithPayment();
    const studios = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${userId}, ${`debt-refund-${seq++}-${Date.now()}`}, 'team', 'Refund')
      RETURNING id
    `;
    const studioId = studios[0]!.id;
    const lots = await sql<{ id: string }[]>`
      INSERT INTO credit_lots
        (payment_id, user_id, purchased_credits, remaining_credits,
         designated_studio_id, lifecycle)
      VALUES (${paymentId}, ${userId}, 880, 880, ${studioId}, 'active')
      RETURNING id
    `;

    for (const lifecycle of ["refund_pending", "refunding", "refunded"]) {
      await expect(
        sql`UPDATE credit_lots SET lifecycle = ${lifecycle} WHERE id = ${lots[0]!.id}`,
      ).rejects.toThrow(/check constraint/i);
    }
  });

  it("解除指定之后才进得了退款态", async () => {
    const { userId, paymentId } = await seedUserWithPayment();
    const lots = await sql<{ id: string }[]>`
      INSERT INTO credit_lots
        (payment_id, user_id, purchased_credits, remaining_credits, lifecycle)
      VALUES (${paymentId}, ${userId}, 880, 880, 'active')
      RETURNING id
    `;
    await expect(
      sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lots[0]!.id}`,
    ).resolves.toBeDefined();
  });
});
