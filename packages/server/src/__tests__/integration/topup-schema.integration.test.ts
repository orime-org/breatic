// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two tables the top-up flow adds, plus the three new `payments` columns
 * (task #13) — against a real Postgres.
 *
 * These are the structural promises only a real database can prove. Each one
 * comes with the failure it holds back:
 *
 * 1. `purchase_consents.payment_id` is UNIQUE. Consent rows are written by the
 * four callers of `fulfillPayment` racing each other (the confirm endpoint,
 * the webhook, the overlay reconciliation, and cancel finding the payment
 * already paid). Whoever gets there first writes; the constraint is what makes
 * every later arrival idempotent for free. Without it a single payment ends up
 * with several contradictory consent records — and consent is legal evidence.
 *
 * 2. `purchase_mail_outbox.payment_id` is UNIQUE, and the table carries
 * `updated_at`. One row per payment is the precondition for "five clicks send
 * one mail"; the timeout that rescues a row stuck in `sending` reads exactly
 * `updated_at`, so it has to move on every write. If it does not, a row that
 * died in `sending` never comes back out and the buyer can never trigger a
 * resend.
 *
 * 3. Neither table has `deleted_at` — only `created_at` / `updated_at`. They
 * live and die with their payment and have no deletable meaning. That is the
 * written justification for exempting them from the repository's soft-delete
 * mandate, and it also has to go into the `NO_SOFT_DELETE` list of the
 * `schema-timestamps` guard.
 *
 * 4. `payments.tax_cents` and `payments.total_cents` are nullable. A row that
 * has not been paid yet has neither value (both are written in the same
 * transaction as the CAS), so NOT NULL would make the row impossible to create
 * at checkout time.
 *
 * 5. `payments.status` has a CHECK over four values: `pending / completed /
 * failed / expired`. `expired` is the terminal state added here — it is how an
 * abandoned checkout leaves "in progress".
 *
 * Runs against the testcontainer Postgres that global-setup.ts brings up, so
 * what it reads is the schema the migrations actually produce.
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
        INSERT INTO purchase_mail_outbox (payment_id, status)
        VALUES (${paymentId}, 'pending')
      `;
      await expect(
        sql`
          INSERT INTO purchase_mail_outbox (payment_id, status)
          VALUES (${paymentId}, 'pending')
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
        INSERT INTO purchase_mail_outbox (payment_id, status)
        VALUES (${paymentId}, 'pending')
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
