// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Migration 0086 (#288) on existing data: it lower-cases what was stored as
 * typed, and the unique index stops it before any row changes when two rows
 * would collapse onto one address. Each case replays the migration inside a transaction that
 * is rolled back, starting from the table as it was before 0086.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import postgres from "postgres";

const MIGRATION = new URL(
  "../../../../core/src/db/migrations/0086_users_email_normalized.sql",
  import.meta.url,
);

let sql: ReturnType<typeof postgres>;
let statements: string[];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
  statements = (await readFile(MIGRATION, "utf8")).split("--> statement-breakpoint");
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

/**
 * Run `body` against the table as it was before 0086, then undo everything.
 * @param body - Seeds rows and runs the migration; its result is returned.
 * @returns What `body` returned.
 */
async function beforeMigration<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (tx) => {
      await tx`ALTER TABLE users DROP CONSTRAINT users_email_normalized`;
      result = await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return result as T;
}

/** Insert an account with the address exactly as given. */
async function seed(tx: postgres.TransactionSql, email: string): Promise<void> {
  await tx`INSERT INTO users (email, membership_tier) VALUES (${email}, 'base')`;
}

describe("migration 0086 on existing addresses", () => {
  it("stores every address trimmed and lower-cased, then refuses unnormalized writes", async () => {
    const tag = crypto.randomUUID();
    const outcome = await beforeMigration(async (tx) => {
      await seed(tx, ` Mixed-${tag}@Example.TEST `);
      for (const statement of statements) await tx.unsafe(statement);
      const rows = await tx<{ email: string }[]>`SELECT email FROM users WHERE email LIKE ${`%${tag}%`}`;
      const refused = await tx
        .savepoint((sp) => sp`INSERT INTO users (email, membership_tier) VALUES (${`Late-${tag}@X.test`}, 'base')`)
        .then(() => null, (err: { code?: string }) => err.code);
      return { rows, refused };
    });
    expect(outcome.rows.map((r) => r.email)).toEqual([`mixed-${tag}@example.test`]);
    expect(outcome.refused).toBe("23514");
  });

  it("stops before changing any row when two addresses differ only in case, soft-deleted ones included", async () => {
    const tag = crypto.randomUUID();
    const outcome = await beforeMigration(async (tx) => {
      await seed(tx, `dup-${tag}@x.test`);
      await seed(tx, `Dup-${tag}@X.test`);
      await tx`UPDATE users SET deleted_at = now() WHERE email = ${`Dup-${tag}@X.test`}`;
      const error = await tx
        .savepoint((sp) => sp.unsafe(statements[0]!))
        .then(() => null, (err: { code?: string; detail?: string }) => err);
      const rows = await tx<{ email: string }[]>`SELECT email FROM users WHERE email ILIKE ${`dup-${tag}@x.test`} ORDER BY email`;
      return { error, rows };
    });
    expect(outcome.error).toMatchObject({ code: "23505" });
    expect(outcome.error?.detail).toContain(`dup-${tag}@x.test`);
    expect(outcome.rows.map((r) => r.email)).toEqual([`Dup-${tag}@X.test`, `dup-${tag}@x.test`]);
  });
});
