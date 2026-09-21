// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `credit_sources` — what a lot of credits came from (task #259).
 *
 * Every lot points at one source, and a source has a kind: a payment today,
 * a compensation, a gift or a discount later. The table exists because the
 * column it replaces was called `payment_id` and was NOT NULL, which spelled
 * "a lot always comes from a payment" into the schema — and back-office
 * compensation credits have a compensation record and no payment at all.
 *
 * Structural promises, each with the failure it pins:
 *
 *   1. `credit_lots.source_id` is NOT NULL and UNIQUE. This is what makes a
 *      payment grant credits exactly once: a redelivered webhook reaches the
 *      same source and is refused at the insert. The constraint moved here
 *      from `payment_id` and has to keep doing that job.
 *
 *   2. A payment shares its source's primary key — `payments.id` IS the
 *      source id — so no payment row carries a column pointing somewhere
 *      else, and the two can never drift apart.
 *
 *   3. `payments.source_kind` is a constant column, and the foreign key is
 *      composite: `(id, source_kind) → credit_sources (id, kind)`. Without
 *      it the database would accept a payment row whose source says
 *      `kind='gift'`, and `kind` is the only column that says where a lot's
 *      money came from.
 *
 *   4. `credit_sources` has `created_at` and no `deleted_at`. A receipt that
 *      can vanish leaves lots pointing at nothing; this is the written reason
 *      the soft-delete mandate is waived here.
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

const PG_DRIVER_LOCAL = "credit-sources-schema-test-driver";

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
  is_nullable: string;
  column_default: string | null;
}

/**
 * Every column of a table, as the database reports it.
 * @param table - Table name in the public schema.
 * @returns The columns keyed by name.
 */
async function columnsOf(table: string): Promise<Map<string, ColumnShape>> {
  const rows = await sql<ColumnShape[]>`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return new Map(rows.map((row) => [row.column_name, row]));
}

let seq = 0;

/**
 * One account.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`src-${seq++}@example.test`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * One source of the given kind, opened directly.
 * @param kind - Which kind of receipt it is.
 * @returns Its id.
 */
async function seedSource(kind: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind)
    VALUES (gen_random_uuid(), ${kind}) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * One completed payment, with the source row it is the child of.
 * @param userId - Who paid.
 * @returns The payment id, which is also the source id.
 */
async function seedPayment(userId: string): Promise<string> {
  const id = await seedSource("payment");
  await sql`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${id}, ${userId}, 1000, 'completed', 880)
  `;
  return id;
}

describe("credit_sources", () => {
  it("carries a kind and keeps its receipts forever", async () => {
    const cols = await columnsOf("credit_sources");

    // Asserted before anything is read out of the map: with the table
    // missing, every lookup below would yield undefined and the optional
    // chaining would let a "column is nullable" assertion quietly pass.
    expect(cols.size, "credit_sources does not exist").toBeGreaterThan(0);

    expect(cols.get("kind")?.is_nullable).toBe("NO");
    expect(cols.get("created_at")?.is_nullable).toBe("NO");
    // Append-only: a receipt outlives the credits it opened.
    expect(cols.has("deleted_at")).toBe(false);
  });

  it("refuses a kind nobody defined", async () => {
    await expect(seedSource("bribe")).rejects.toThrow(
      /credit_sources_kind_check/,
    );
  });

  it("holds a compensation that no payment paid for", async () => {
    // The whole reason the table exists: back-office compensation credits
    // have a compensation record and no payment, and the column this
    // replaces could not express that.
    const userId = await seedUser();
    const sourceId = await seedSource("compensation");

    await sql`
      INSERT INTO credit_lots
        (source_id, user_id, purchased_credits, remaining_credits, lifecycle)
      VALUES (${sourceId}, ${userId}, 500, 500, 'active')
    `;

    const rows = await sql<{ kind: string }[]>`
      SELECT s.kind FROM credit_lots l
      JOIN credit_sources s ON s.id = l.source_id
      WHERE l.source_id = ${sourceId}
    `;
    expect(rows[0]?.kind).toBe("compensation");
  });
});

describe("a payment as a kind of source", () => {
  it("is its source — same id, no second column pointing at it", async () => {
    const userId = await seedUser();
    const paymentId = await seedPayment(userId);

    const rows = await sql<{ kind: string }[]>`
      SELECT kind FROM credit_sources WHERE id = ${paymentId}
    `;
    expect(rows[0]?.kind).toBe("payment");
    expect((await columnsOf("payments")).has("source_id")).toBe(false);
  });

  it("cannot exist without its source row", async () => {
    const userId = await seedUser();

    await expect(
      sql`
        INSERT INTO payments (user_id, amount_cents, status, credits_granted)
        VALUES (${userId}, 1000, 'completed', 880)
      `,
    ).rejects.toThrow(/payments_source_fk/);
  });

  it("cannot be filed under a kind that is not payment", async () => {
    // The composite key is what holds this line. Without it the database
    // takes a payment whose source says `gift`, and `kind` is the only
    // column that says where a lot's money came from.
    const userId = await seedUser();
    const giftId = await seedSource("gift");

    await expect(
      sql`
        INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
        VALUES (${giftId}, ${userId}, 1000, 'completed', 880)
      `,
    ).rejects.toThrow(/payments_source_fk/);
  });
});

describe("credit_lots.source_id", () => {
  it("is what makes a payment grant credits exactly once", async () => {
    const userId = await seedUser();
    const paymentId = await seedPayment(userId);
    const lot = sql`
      INSERT INTO credit_lots
        (source_id, user_id, purchased_credits, remaining_credits, lifecycle)
      VALUES (${paymentId}, ${userId}, 880, 880, 'active')
    `;
    await lot;

    // The second one is the redelivered webhook.
    await expect(
      sql`
        INSERT INTO credit_lots
          (source_id, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (${paymentId}, ${userId}, 880, 880, 'active')
      `,
    ).rejects.toThrow(/credit_lots_source_id_idx/);
  });

  it("cannot point at a receipt that was never opened", async () => {
    const userId = await seedUser();

    await expect(
      sql`
        INSERT INTO credit_lots
          (source_id, user_id, purchased_credits, remaining_credits, lifecycle)
        VALUES (gen_random_uuid(), ${userId}, 880, 880, 'active')
      `,
    ).rejects.toThrow(/credit_lots_source_id_fk/);
  });
});
