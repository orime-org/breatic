// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Migration 0126 and the constraints it adds, against real Postgres
 * (inner#1968, test spec area A: A-21 to A-26).
 *
 * The constraint cases insert into the migrated database and check the
 * Postgres error code, so a refusal for any other reason (a missing table, a
 * bad fixture) does not pass for a constraint. Each constraint case first
 * inserts a valid row of the same shape.
 *
 * The two data cases (A-21, A-24) replay the part of the migration that
 * touches one table inside a transaction that is rolled back: the column is
 * dropped, a row from before the migration is written, and the statements of
 * 0126 that name the table are run again. Placement: the spec puts these at
 * core integration; core has no integration harness.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";

const MIGRATION = new URL("../../../../core/src/db/migrations/0126_operation_ledger.sql", import.meta.url);

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operation-ledger-schema-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

class Rollback extends Error {}

/**
 * Run `body` in a transaction that is always rolled back.
 * @param body - Seeds, replays and reads.
 * @returns What `body` returned.
 */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (tx) => {
      result = await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return result as T;
}

/**
 * The statements of 0126 that mention every one of `needles`.
 * @param needles - Substrings a statement must contain.
 * @returns The statements, in file order.
 */
async function statementsNaming(...needles: string[]): Promise<string[]> {
  const text = await readFile(MIGRATION, "utf8");
  const picked = text.split("--> statement-breakpoint").filter((s) => needles.every((n) => s.includes(n)));
  expect(picked.length).toBeGreaterThan(0);
  return picked;
}

interface Account {
  userId: string;
  studioId: string;
  projectId: string;
}

/**
 * A user administering a team studio with a project.
 * @param db - Where to write.
 * @returns The ids.
 */
async function account(db: postgres.Sql | postgres.TransactionSql = sql): Promise<Account> {
  const userId = randomUUID();
  const studioId = randomUUID();
  const projectId = randomUUID();
  await db`insert into users(id, email, email_verified) values (${userId}, ${`${userId}@example.test`}, true)`;
  await db`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`ls-${studioId}`}, 'team', 'Ledger')`;
  await db`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await db`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`ls-${projectId}`}, 'Ledger')`;
  return { userId, studioId, projectId };
}

/**
 * Insert one enterprise agreement with chosen operation fields.
 * @param userId - Its account.
 * @param extra - Values for the two new columns; omitted columns are left out of the insert.
 * @param extra.monthly - `monthly_operations`.
 * @param extra.running - `running_tasks_per_user`.
 * @returns The insert's promise.
 */
function insertAgreement(userId: string, extra: { monthly?: number; running?: number } = {}): Promise<unknown> {
  const row: Record<string, unknown> = {
    user_id: userId, expires_at: "2099-01-01T00:00:00Z", entry_timezone: "UTC", contract_number: "ENT-A22",
    team_studios: 1, projects_per_studio: 1, concurrent_editors: 1, studio_members: 1, project_members: 1, storage_bytes: 1,
    fallback_tier: "base", revision: 1,
  };
  if (extra.monthly !== undefined) row.monthly_operations = extra.monthly;
  if (extra.running !== undefined) row.running_tasks_per_user = extra.running;
  return sql`insert into enterprise_memberships ${sql(row)}`;
}

/**
 * The Postgres error code a statement fails with.
 * @param run - The statement.
 * @returns Its SQLSTATE, or "ok" when it succeeded.
 */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe("0126 operation ledger migration", () => {
  it("A-21 an agreement written before the migration gets 16000 operations and 10 running tasks", async () => {
    const statements = await statementsNaming("enterprise_memberships");
    const values = await rolledBack(async (tx) => {
      await tx`alter table enterprise_memberships drop column if exists monthly_operations cascade, drop column if exists running_tasks_per_user cascade`;
      const { userId } = await account(tx);
      await tx`insert into enterprise_memberships(user_id, expires_at, entry_timezone, contract_number, team_studios, projects_per_studio, concurrent_editors, studio_members, project_members, storage_bytes, fallback_tier, revision)
        values (${userId}, '2099-01-01T00:00:00Z', 'UTC', 'ENT-A21', 1, 1, 1, 1, 1, 1, 'base', 1)`;
      for (const statement of statements) await tx.unsafe(statement);
      const [row] = await tx<{ monthly_operations: number; running_tasks_per_user: number }[]>`
        select monthly_operations, running_tasks_per_user from enterprise_memberships where user_id = ${userId}`;
      return row;
    });
    expect(values).toEqual({ monthly_operations: 16000, running_tasks_per_user: 10 });
  });

  it("A-22 the agreement CHECKs refuse -1 operations and 0 or 31 running tasks, and accept 1 and 30", async () => {
    const codes: Record<string, string> = {};
    codes.monthlyMinus1 = await codeOf(async () => insertAgreement((await account()).userId, { monthly: -1 }));
    codes.running0 = await codeOf(async () => insertAgreement((await account()).userId, { running: 0 }));
    codes.running31 = await codeOf(async () => insertAgreement((await account()).userId, { running: 31 }));
    codes.running1 = await codeOf(async () => insertAgreement((await account()).userId, { running: 1 }));
    codes.running30 = await codeOf(async () => insertAgreement((await account()).userId, { running: 30 }));
    expect(codes).toEqual({ monthlyMinus1: "23514", running0: "23514", running31: "23514", running1: "ok", running30: "ok" });
  });

  it("A-23 a charge request accepts kind operation_overage and refuses an unknown kind by credit_charge_requests_kind_check", async () => {
    const a = await account();
    const insert = (kind: string) => sql`insert into credit_charge_requests(kind, actor_user_id, reference_id, project_id, amount)
      values (${kind}, ${a.userId}, ${`operation:${randomUUID()}`}, ${a.projectId}, 0.5)`;
    await expect(insert("operation_overage")).resolves.toBeDefined();
    let refused: { code?: string; constraint_name?: string } = {};
    try {
      await insert("foo");
    } catch (err) {
      refused = err as { code?: string; constraint_name?: string };
    }
    expect(refused).toMatchObject({ code: "23514", constraint_name: "credit_charge_requests_kind_check" });
  });

  it("A-24 backfills studio_id on existing charge requests from their project, and leaves it empty without one", async () => {
    const statements = await statementsNaming("credit_charge_requests", "studio_id");
    const values = await rolledBack(async (tx) => {
      await tx`alter table credit_charge_requests drop column if exists studio_id cascade`;
      const a = await account(tx);
      const [withProject] = await tx<{ id: string }[]>`insert into credit_charge_requests(kind, actor_user_id, reference_id, project_id, amount)
        values ('task', ${a.userId}, ${randomUUID()}, ${a.projectId}, 1) returning id`;
      const [without] = await tx<{ id: string }[]>`insert into credit_charge_requests(kind, actor_user_id, reference_id, project_id, amount)
        values ('operation', ${a.userId}, ${randomUUID()}, null, 1) returning id`;
      for (const statement of statements) await tx.unsafe(statement);
      const rows = await tx<{ id: string; studio_id: string | null }[]>`
        select id, studio_id from credit_charge_requests where id in (${withProject!.id}, ${without!.id})`;
      return { studioId: a.studioId, byId: Object.fromEntries(rows.map((r) => [r.id, r.studio_id])), withProject: withProject!.id, without: without!.id };
    });
    expect(values.byId[values.withProject]).toBe(values.studioId);
    expect(values.byId[values.without]).toBeNull();
  });

  it("A-25 the ledger constraints refuse each of the seven broken rows", async () => {
    const a = await account();
    const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      operation_key: `task:${randomUUID()}`, kind: "generation", account_user_id: a.userId, studio_id: a.studioId, project_id: a.projectId,
      actor_user_id: a.userId, status: "reserved", admitted_as: "covered", expires_at: new Date(Date.now() + 3_600_000), ...over,
    });
    const insert = (r: Record<string, unknown>) => () => sql`insert into operation_ledger ${sql(r)}`;
    // The baseline shape is accepted, so every refusal below is the constraint's.
    expect(await codeOf(insert(row()))).toBe("ok");
    const taken = row();
    expect(await codeOf(insert(taken))).toBe("ok");
    const now = new Date();
    const codes = {
      countedWithoutSlot: await codeOf(insert(row({ status: "counted", slot: null, period_start: now, counted_at: now }))),
      releasedWithoutTime: await codeOf(insert(row({ status: "released", released_at: null }))),
      heldWithoutHold: await codeOf(insert(row({ admitted_as: "held", overage_hold: null }))),
      deferredWithoutAsset: await codeOf(insert(row({ kind: "upload", operation_key: `upload:${a.userId}:${randomUUID()}`, status: "deferred", asset_id: null }))),
      generationWithoutProject: await codeOf(insert(row({ project_id: null }))),
      unknownKind: await codeOf(insert(row({ kind: "foo" }))),
      duplicateKey: await codeOf(insert(row({ operation_key: taken.operation_key }))),
    };
    expect(codes).toEqual({
      countedWithoutSlot: "23514",
      releasedWithoutTime: "23514",
      heldWithoutHold: "23514",
      deferredWithoutAsset: "23514",
      generationWithoutProject: "23514",
      unknownKind: "23514",
      duplicateKey: "23505",
    });
  });

  it("A-26 operation_ledger has no deleted_at; both spend-limit tables have one", async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('operation_ledger', 'studio_spend_limits', 'studio_member_spend_limits')`;
    const columns = (table: string) => rows.filter((r) => r.table_name === table).map((r) => r.column_name);
    expect(columns("operation_ledger")).toEqual(expect.arrayContaining(["operation_key", "created_at"]));
    expect(columns("operation_ledger")).not.toContain("deleted_at");
    expect(columns("studio_spend_limits")).toEqual(expect.arrayContaining(["studio_id", "deleted_at"]));
    expect(columns("studio_member_spend_limits")).toEqual(expect.arrayContaining(["studio_id", "user_id", "deleted_at"]));
  });
});
