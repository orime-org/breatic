// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * 0134 adds what the product needs to receive from the billing service
 * (inner#1993 §4.2, §4.6): `payment_receipts`, `commerce_requests` and the
 * `commerce_outbox` pair. It only adds; the backfill gives every completed
 * payment its receipt, copied from the payment row, and nothing else.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const migration = new URL("../../../../core/src/db/migrations/0134_commerce_receiving.sql", import.meta.url);
let sql: ReturnType<typeof postgres>;
let statements: string[];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-receiving-migration-test" } });
  statements = (await readFile(migration, "utf8")).split("--> statement-breakpoint");
});

afterAll(async () => {
  await sql?.end({ timeout: 3 });
});

class Rollback extends Error {}
type Tx = postgres.TransactionSql;

/**
 * Replay 0134 against payments seeded inside a transaction that always rolls back.
 * @param body - Seeds, applies and asserts.
 */
async function replay(body: (tx: Tx) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await tx`DROP TABLE payment_receipts, commerce_requests, commerce_outbox_dead_letters, commerce_outbox`;
      // Other files leave payments behind; the backfill reads every payment,
      // so this replay sees only its own. The rollback restores theirs.
      await tx`TRUNCATE credit_sources CASCADE`;
      await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

/**
 * Run every statement of 0134.
 * @param tx - The replay transaction.
 */
async function apply(tx: Tx): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement);
}

/**
 * One account.
 * @param tx - The replay transaction.
 * @returns Its id.
 */
async function account(tx: Tx): Promise<string> {
  const userId = randomUUID();
  await tx`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  return userId;
}

/**
 * One payment with its credit source.
 * @param tx - The replay transaction.
 * @param row - The payment's columns.
 * @param row.userId - The buyer.
 * @param row.status - Its status.
 * @param row.amountCents - The pre-tax face value.
 * @param row.taxCents - The tax Stripe worked out, or null.
 * @param row.totalCents - The total Stripe worked out, or null.
 * @param row.credits - The credits granted.
 * @param row.createdAt - When it was ordered.
 * @returns Its id.
 */
async function payment(
  tx: Tx,
  row: { userId: string; status: string; amountCents: number; taxCents: number | null; totalCents: number | null; credits: number; createdAt: string },
): Promise<string> {
  const id = randomUUID();
  await tx`INSERT INTO credit_sources(id,kind) VALUES (${id},'payment')`;
  await tx`INSERT INTO payments(id,source_kind,user_id,amount_cents,currency,status,credits_granted,tax_cents,total_cents,created_at)
    VALUES (${id},'payment',${row.userId},${row.amountCents},'usd',${row.status},${row.credits},${row.taxCents},${row.totalCents},${row.createdAt})`;
  return id;
}

describe("0134_commerce_receiving", () => {
  it("gives every completed payment a receipt copied from it, and no other payment one", async () => {
    await replay(async (tx) => {
      const userId = await account(tx);
      const completed = await payment(tx, { userId, status: "completed", amountCents: 1000, taxCents: 90, totalCents: 1090, credits: 1000, createdAt: "2026-09-01T10:00:00.000Z" });
      const untaxed = await payment(tx, { userId, status: "completed", amountCents: 500, taxCents: null, totalCents: null, credits: 500, createdAt: "2026-09-02T10:00:00.000Z" });
      for (const status of ["pending", "failed", "expired"]) {
        await payment(tx, { userId, status, amountCents: 700, taxCents: null, totalCents: null, credits: 0, createdAt: "2026-09-03T10:00:00.000Z" });
      }

      await apply(tx);

      const receipts = await tx`SELECT id, source_kind, user_id, amount_cents, tax_cents, total_cents, currency, credits_granted::text AS credits, ordered_at
        FROM payment_receipts ORDER BY ordered_at`;
      expect(receipts).toEqual([
        { id: completed, source_kind: "payment", user_id: userId, amount_cents: 1000, tax_cents: 90, total_cents: 1090, currency: "usd", credits: "1000.000000", ordered_at: new Date("2026-09-01T10:00:00.000Z") },
        { id: untaxed, source_kind: "payment", user_id: userId, amount_cents: 500, tax_cents: null, total_cents: null, currency: "usd", credits: "500.000000", ordered_at: new Date("2026-09-02T10:00:00.000Z") },
      ]);
    });
  });

  it("refuses a receipt with no payment credit source behind it", async () => {
    await replay(async (tx) => {
      await apply(tx);
      const userId = await account(tx);
      await expect(
        tx`INSERT INTO payment_receipts(id,user_id,amount_cents,currency,credits_granted,ordered_at) VALUES (${randomUUID()},${userId},100,'usd',100,now())`,
      ).rejects.toThrow(/payment_receipts_source_fk/);
    });
  });

  it("keeps one request record per key", async () => {
    await replay(async (tx) => {
      await apply(tx);
      await tx`INSERT INTO commerce_requests(key,kind,request_hash,status,answer) VALUES ('grant:p-1','grant',${"a".repeat(64)},'applied','{}'::jsonb)`;
      // Each refusal in a savepoint of its own: the first would otherwise leave
      // the transaction aborted and the second would fail for that reason.
      await expect(
        tx.savepoint((sp) => sp`INSERT INTO commerce_requests(key,kind,request_hash,status,answer) VALUES ('grant:p-1','grant',${"b".repeat(64)},'applied','{}'::jsonb)`),
      ).rejects.toThrow(/commerce_requests_key_key/);
      await expect(
        tx.savepoint((sp) => sp`INSERT INTO commerce_requests(key,kind,request_hash,status,answer) VALUES ('grant:p-2','grant',${"a".repeat(64)},'pending','{}'::jsonb)`),
      ).rejects.toThrow(/commerce_requests_status_check/);
    });
  });

  it("numbers outbox rows in insertion order and gives each its own delivery id", async () => {
    await replay(async (tx) => {
      await apply(tx);
      const first = await tx`INSERT INTO commerce_outbox(aggregate_key,type,payload) VALUES ('lot:a','lot_refund_lifecycle','{}'::jsonb) RETURNING id, seq`;
      const second = await tx`INSERT INTO commerce_outbox(aggregate_key,type,payload) VALUES ('lot:a','lot_refund_lifecycle','{}'::jsonb) RETURNING id, seq`;
      expect(BigInt(second[0]!.seq as string)).toBeGreaterThan(BigInt(first[0]!.seq as string));
      expect(second[0]!.id).not.toBe(first[0]!.id);
      const [unsent] = await tx`SELECT count(*)::int AS n FROM commerce_outbox WHERE sent_at IS NULL AND next_attempt_at <= now()`;
      expect(unsent).toEqual({ n: 2 });
    });
  });
});
