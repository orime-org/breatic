// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { useInternalApp } from "./internal-api-harness.js";
import { GRANT_ADMIN, expectGrantTables, grantBody, grantKey, seedPersonal } from "./operator-credit-grant-fixtures.js";
import type { PersonalFixture } from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("credit-grant-schema");
/** End a migration fixture while restoring its database transaction. */
class Rollback extends Error {}

/** Execute a real SQL transaction and restore the schema and fixture data afterward. */
async function rolledBack<T>(run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await suite.sql.begin(async (tx) => { result = await run(tx); throw new Rollback(); }).catch((error: unknown) => {
    if (!(error instanceof Rollback)) throw error;
  });
  return result as T;
}

/** Store a valid immutable operation for independently constructed constraint fixtures. */
async function insertOperation(tx: postgres.TransactionSql, fx: PersonalFixture, key: string, sourceId: string, lotId: string): Promise<void> {
  const body = grantBody(fx);
  const result = { status: "applied", operation: { key, accountId: fx.userId, adminId: GRANT_ADMIN, requestHash: "a".repeat(64), recordedAt: "2026-10-31T00:00:00.000Z" },
    sourceId, sourceKind: "compensation", lotId, personalStudioId: fx.studioId, grantedCredits: "100.000000", repaidCredits: "0.000000", remainingCredits: "100.000000", debtBefore: "0.000000", debtAfter: "0.000000" };
  await tx`insert into credit_grant_operations(key,request_hash,target_user_id,requested_by,request_body,result)
    values(${key},${"a".repeat(64)},${fx.userId},${GRANT_ADMIN},${tx.json({ ...body })},${tx.json(result)})`;
}

/** Build one parent/child receipt using the agreed product schema fields. */
async function insertCompensation(tx: postgres.TransactionSql, fx: PersonalFixture, key: string, id = randomUUID(), changes: { credits?: string; kind?: string; reason?: string | null; admin?: string | null; parent?: boolean } = {}): Promise<string> {
  if (changes.parent !== false) await tx`insert into credit_sources(id,kind) values(${id},'compensation')`;
  await tx`insert into credit_compensations(id,source_kind,target_user_id,personal_studio_id,credits,reason,operation_key,requested_by)
    values(${id},${changes.kind ?? "compensation"},${fx.userId},${fx.studioId},${changes.credits ?? "100.000000"}::numeric,
    ${changes.reason === undefined ? "Service compensation" : changes.reason},${key},${changes.admin === undefined ? GRANT_ADMIN : changes.admin})`;
  return id;
}

/** Find the product migration by the table it introduces, independent of its journal number. */
async function migrationStatements(): Promise<string[]> {
  const directory = new URL("../../../../core/src/db/migrations/", import.meta.url);
  const candidates: { name: string; source: string }[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".sql")) continue;
    const source = await readFile(new URL(name, directory), "utf8");
    if (/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?credit_gifts"?\b/i.test(source)) candidates.push({ name, source });
  }
  expect(candidates.map((entry) => entry.name), "one migration must install the operator source receipts").toHaveLength(1);
  return candidates[0]!.source.split("--> statement-breakpoint");
}

/** Reconstruct the old gift-source shape before replaying the actual migration SQL. */
async function oldGiftData(tx: postgres.TransactionSql, fixtures: readonly PersonalFixture[], unclassified = false): Promise<{ sourceId: string; userId: string; studioId: string; credits: string; createdAt: string }[]> {
  await tx`drop table credit_compensations,credit_gifts,credit_grant_operations cascade`;
  await tx`truncate credit_sources cascade`;
  const expected: { sourceId: string; userId: string; studioId: string; credits: string; createdAt: string }[] = [];
  for (const [index, fx] of fixtures.entries()) {
    const sourceId = unclassified && index === 0 ? randomUUID() : fx.userId;
    const at = `2020-01-0${index + 1}T00:00:00.123456Z`;
    await tx`insert into credit_sources(id,kind,created_at) values(${sourceId},'gift',${at}::text::timestamptz)`;
    await tx`insert into credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,designated_studio_id,lifecycle,created_at,deleted_at)
      values(${sourceId},'gift',${fx.userId},100,${index === 1 ? "0" : "100"}::numeric,${fx.studioId},${index === 1 ? "depleted" : "active"},${at}::text::timestamptz,${index === 2 ? at : null}::text::timestamptz)`;
    expected.push({ sourceId, userId: fx.userId, studioId: fx.studioId, credits: "100.000000", createdAt: at });
  }
  return expected;
}

describe("operator grant schema constraints and historical gift migration", () => {
  it("P15 installs all source children and the immutable decision table", async () => { await expectGrantTables(suite.sql); });

  it.each([
    ["source kind", { kind: "gift" }, "23514"],
    ["missing source parent", { parent: false }, "23503"],
    ["zero quantity", { credits: "0" }, "23514"],
    ["negative quantity", { credits: "-1" }, "23514"],
    ["out-of-column quantity", { credits: "100000000000000.00" }, "22003"],
  ] as const)("P15 rejects a receipt with %s", async (_label, changes, code) => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    await expect(suite.sql.begin(async (tx) => {
      const key = grantKey();
      await insertOperation(tx, fx, key, randomUUID(), randomUUID());
      await insertCompensation(tx, fx, key, randomUUID(), changes);
    })).rejects.toMatchObject({ code });
    expect(await suite.sql`select id from credit_compensations where target_user_id=${fx.userId}`).toEqual([]);
  });

  it.each([{ reason: null }, { reason: "" }, { admin: null }])("P15 rejects incomplete operator metadata %#", async (change) => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    const operation = suite.sql.begin(async (tx) => {
      const key = grantKey();
      await insertOperation(tx, fx, key, randomUUID(), randomUUID());
      await insertCompensation(tx, fx, key, randomUUID(), change);
    });
    await expect(operation).rejects.toMatchObject({ code: expect.stringMatching(/^2350[23]$|^23514$/) });
    expect(await suite.sql`select id from credit_compensations where target_user_id=${fx.userId}`).toEqual([]);
  });

  it("P15 checks the deferred operation relationship at commit", async () => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    const key = grantKey();
    await expect(suite.sql.begin(async (tx) => { await insertCompensation(tx, fx, key); })).rejects.toMatchObject({ code: "23503" });
    expect(await suite.sql`select id from credit_compensations where target_user_id=${fx.userId}`).toEqual([]);
    const created = await rolledBack(async (tx) => {
      const source = await insertCompensation(tx, fx, key);
      await insertOperation(tx, fx, key, source, randomUUID());
      await tx`set constraints all immediate`;
      return tx`select operation_key from credit_compensations where id=${source}`;
    });
    expect(created).toEqual([{ operation_key: key }]);
  });

  it("P15 permits one receipt and one lot for an operation and source", async () => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    await expect(suite.sql.begin(async (tx) => {
      const key = grantKey();
      const first = await insertCompensation(tx, fx, key);
      await insertOperation(tx, fx, key, first, randomUUID());
      await insertCompensation(tx, fx, key);
    })).rejects.toMatchObject({ code: "23505" });
    await expect(suite.sql.begin(async (tx) => {
      const key = grantKey();
      const id = await insertCompensation(tx, fx, key);
      await insertOperation(tx, fx, key, id, randomUUID());
      for (let index = 0; index < 2; index++) await tx`
        insert into credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,designated_studio_id,lifecycle)
        values(${id},'compensation',${fx.userId},100,100,${fx.studioId},'active')`;
    })).rejects.toMatchObject({ code: "23505" });
  });

  it.each(["registration", "operator"])("P15 enforces the complete %s gift-receipt shape", async (origin) => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    await expect(suite.sql.begin(async (tx) => {
      const id = origin === "registration" ? fx.userId : randomUUID();
      await tx`insert into credit_sources(id,kind) values(${id},'gift')`;
      await tx`insert into credit_gifts(id,source_kind,origin,target_user_id,personal_studio_id,credits,reason,operation_key,requested_by)
        values(${id},'gift',${origin},${fx.userId},${fx.studioId},50,null,null,${origin === "registration" ? GRANT_ADMIN : null})`;
    })).rejects.toMatchObject({ code: "23514" });
    expect(await suite.sql`select id from credit_gifts where target_user_id=${fx.userId}`).toEqual([]);
  });

  it("P16 backfills active, depleted and soft-deleted registration receipts from historical facts", async () => {
    const statements = await migrationStatements();
    await expectGrantTables(suite.sql);
    const fixtures = await Promise.all(Array.from({ length: 3 }, () => seedPersonal(suite.sql, "grant-backfill")));
    const result = await rolledBack(async (tx) => {
      const originals = await oldGiftData(tx, fixtures);
      for (const statement of statements) await tx.unsafe(statement);
      const rows = await tx<{ id: string; target_user_id: string; personal_studio_id: string; credits: string; created_at: string; origin: string; operation_key: string | null; requested_by: string | null; reason: string | null }[]>`
        select id,target_user_id,personal_studio_id,credits::text,
          to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
          origin,operation_key,requested_by,reason from credit_gifts order by created_at`;
      return { originals, rows };
    });
    expect(result.rows).toEqual(result.originals.map((row) => ({ id: row.sourceId, target_user_id: row.userId, personal_studio_id: row.studioId, credits: row.credits,
      created_at: row.createdAt, origin: "registration", operation_key: null, requested_by: null, reason: null })));
  });

  it("P16 refuses an unclassifiable historical gift and restores the prior schema transaction", async () => {
    const statements = await migrationStatements();
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql, "grant-bad-backfill");
    const before = await suite.sql`select count(*)::int as n from credit_gifts`;
    await expect(rolledBack(async (tx) => {
      await oldGiftData(tx, [fx], true);
      for (const statement of statements) await tx.unsafe(statement);
    })).rejects.toThrowError();
    await expectGrantTables(suite.sql);
    expect(await suite.sql`select count(*)::int as n from credit_gifts`).toEqual(before);
  });
});
