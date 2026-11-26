// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The influencer attribution migration (inner#2157 design 7.1, V8).
 *
 * It adds the `influencers` table seeded with the one `official` row,
 * `influencer_operations`, and `users.influencer_code NOT NULL DEFAULT
 * 'official'` with a RESTRICT foreign key. Every account that exists when it
 * runs is credited to `official`, and nothing about it changes otherwise.
 *
 * The migration is found by name (the next number, `*influencer*.sql`), then
 * replayed inside a transaction that always rolls back.
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const migrations = new URL("../../../../core/src/db/migrations/", import.meta.url);
let sql: ReturnType<typeof postgres>;
let statements: string[];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "influencers-migration-test" } });
  const names = (await readdir(migrations)).filter((name) => /^\d{4}_.*influencer.*\.sql$/.test(name));
  expect(names.length, "exactly one product migration adds the influencer attribution").toBe(1);
  statements = (await readFile(new URL(names[0] ?? "", migrations), "utf8")).split("--> statement-breakpoint");
});

afterAll(async () => {
  await sql?.end({ timeout: 3 });
});

class Rollback extends Error {}
type Tx = postgres.TransactionSql;

/**
 * Undo the migration, run the body, and roll everything back.
 * @param body - Seeds, applies and asserts.
 */
async function replay(body: (tx: Tx) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await tx`ALTER TABLE users DROP COLUMN IF EXISTS influencer_code`;
      await tx`DROP TABLE IF EXISTS influencer_operations, influencers`;
      await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

/**
 * Run every statement of the migration.
 * @param tx - The replay transaction.
 */
async function apply(tx: Tx): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement);
}

/**
 * One account inserted the way fixtures do, naming no influencer.
 * @param tx - The replay transaction.
 * @returns Its id.
 */
async function account(tx: Tx): Promise<string> {
  const userId = randomUUID();
  await tx`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  return userId;
}

/**
 * Run a statement that must fail, inside a savepoint so the replay goes on.
 * @param tx - The replay transaction.
 * @param statement - The statement expected to fail.
 * @returns The Postgres error code it failed with.
 */
async function failureCode(tx: Tx, statement: () => Promise<unknown>): Promise<string> {
  try {
    await tx.savepoint(async () => {
      await statement();
    });
  } catch (err) {
    return (err as { code?: string }).code ?? "no code";
  }
  return "succeeded";
}

describe("influencer attribution migration", () => {
  it("credits every account that already exists to official (V8)", async () => {
    await replay(async (tx) => {
      const before = [await account(tx), await account(tx), await account(tx)];

      await apply(tx);

      const rows = await tx<{ id: string; influencer_code: string }[]>`
        SELECT id, influencer_code FROM users WHERE id = ANY(${before}) ORDER BY id`;
      expect(rows).toEqual([...before].sort().map((id) => ({ id, influencer_code: "official" })));
      const [{ others }] = (await tx<{ others: number }[]>`
        SELECT count(*)::int AS others FROM users WHERE influencer_code <> 'official'`) as unknown as [{ others: number }];
      expect(others).toBe(0);
    });
  });

  it("seeds exactly the official row, with no host and enabled", async () => {
    await replay(async (tx) => {
      await apply(tx);

      const rows = await tx`SELECT code, host, disabled_at FROM influencers ORDER BY code`;
      expect(rows).toEqual([{ code: "official", host: null, disabled_at: null }]);
    });
  });

  it("gives an account inserted without a code the official default", async () => {
    await replay(async (tx) => {
      await apply(tx);
      const userId = await account(tx);

      const [row] = await tx`SELECT influencer_code FROM users WHERE id = ${userId}`;
      expect(row).toEqual({ influencer_code: "official" });
    });
  });

  it("refuses an account naming an unregistered influencer", async () => {
    await replay(async (tx) => {
      await apply(tx);
      const id = randomUUID();

      expect(
        await failureCode(tx, () => tx`INSERT INTO users(id,email,influencer_code) VALUES (${id},${`${id}@example.test`},'nobody')`),
      ).toBe("23503");
    });
  });

  it("refuses to delete an influencer an account points at", async () => {
    await replay(async (tx) => {
      await apply(tx);
      await account(tx);

      expect(await failureCode(tx, () => tx`DELETE FROM influencers WHERE code = 'official'`)).toBe("23503");
    });
  });

  it("refuses to make an account's influencer_code null", async () => {
    await replay(async (tx) => {
      await apply(tx);
      const userId = await account(tx);

      expect(await failureCode(tx, () => tx`UPDATE users SET influencer_code = NULL WHERE id = ${userId}`)).toBe("23502");
    });
  });

  it("keeps a registered influencer and lets an account point at it", async () => {
    await replay(async (tx) => {
      await apply(tx);
      await tx`INSERT INTO influencers(code, host) VALUES ('alice', 'alice.partner.breatic.ai')`;
      const id = randomUUID();
      await tx`INSERT INTO users(id,email,influencer_code) VALUES (${id},${`${id}@example.test`},'alice')`;

      const [row] = await tx`SELECT u.influencer_code, i.host, i.disabled_at
        FROM users u JOIN influencers i ON i.code = u.influencer_code WHERE u.id = ${id}`;
      expect(row).toEqual({ influencer_code: "alice", host: "alice.partner.breatic.ai", disabled_at: null });
    });
  });

  it.each([
    ["an uppercase code", "Alice", "alice.partner.breatic.ai"],
    ["a code with an underscore", "al_ice", "alice.partner.breatic.ai"],
    ["an empty code", "", "alice.partner.breatic.ai"],
    ["a code longer than 32 characters", "a".repeat(33), "alice.partner.breatic.ai"],
    ["a host with capitals", "alice", "Alice.partner.breatic.ai"],
  ])("refuses %s", async (_label, code, host) => {
    await replay(async (tx) => {
      await apply(tx);

      expect(await failureCode(tx, () => tx`INSERT INTO influencers(code, host) VALUES (${code}, ${host})`)).toMatch(/^(23514|22001)$/);
    });
  });

  it("refuses a second influencer on a host already registered", async () => {
    await replay(async (tx) => {
      await apply(tx);
      await tx`INSERT INTO influencers(code, host) VALUES ('alice', 'alice.partner.breatic.ai')`;

      expect(
        await failureCode(tx, () => tx`INSERT INTO influencers(code, host) VALUES ('alice-two', 'alice.partner.breatic.ai')`),
      ).toBe("23505");
    });
  });

  it("indexes users by influencer_code for the influencer back office", async () => {
    await replay(async (tx) => {
      await apply(tx);

      const [{ indexed }] = (await tx<{ indexed: number }[]>`
        SELECT count(*)::int AS indexed FROM pg_indexes
        WHERE tablename = 'users' AND indexdef ~ '\\(influencer_code\\)'`) as unknown as [{ indexed: number }];
      expect(indexed).toBe(1);
    });
  });

  it("creates influencer_operations with a unique key, shaped like credit_grant_operations", async () => {
    await replay(async (tx) => {
      await apply(tx);

      const columns = await tx<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'influencer_operations' ORDER BY column_name`;
      expect(columns.map((c) => c.column_name)).toEqual([
        "created_at", "id", "key", "request_body", "request_hash", "requested_by", "result",
      ]);
      // Values shaped like a back-office call: a `bo-<uuid>` key, a sha256
      // request hash, an operator uuid and a refusal conclusion.
      const operation = {
        key: `bo-${randomUUID()}`,
        hash: "a".repeat(64),
        operator: randomUUID(),
        body: tx.json({ code: "alice", host: "alice.breatic.ai" }),
        result: tx.json({ status: "refused", reason: "host_invalid" }),
      };
      await tx`INSERT INTO influencer_operations(key, request_hash, requested_by, request_body, result)
        VALUES (${operation.key}, ${operation.hash}, ${operation.operator}, ${operation.body}, ${operation.result})`;
      expect(
        await failureCode(tx, () => tx`INSERT INTO influencer_operations(key, request_hash, requested_by, request_body, result)
          VALUES (${operation.key}, ${"b".repeat(64)}, ${operation.operator}, ${operation.body}, ${operation.result})`),
      ).toBe("23505");
    });
  });
});
