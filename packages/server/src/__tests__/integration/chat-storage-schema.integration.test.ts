// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Structural promises of the chat storage layer (PR-3).
 *
 * Two tables replace one JSONB column:
 *
 *   1. `current_conversations` — the pointer that answers "which conversation
 *      is this user writing to in this project". The whole front-end contract
 *      rests on it: the client never sends a conversation id, so the server has
 *      to hold one. Its primary key IS the uniqueness guarantee, which is what
 *      lets "switch conversation" be a single atomic upsert.
 *
 *   2. `conversation_messages` — one row per message, `parts` holding the
 *      heterogeneous pieces of that message. `conversations.messages` used to
 *      hold the entire array in a single column, so every append rewrote and
 *      re-compressed the whole document and locked the conversation row.
 *
 * These promises are invisible to unit tests: a primary key, a partial unique
 * index and an FK delete rule only exist in the migration, so only a real
 * Postgres can prove they are there. The behavioural half (pointer switching,
 * turn numbering under concurrency, cascade soft delete) lives in
 * chat-storage-behaviour.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";

const PG_DRIVER_LOCAL = "chat-storage-schema-test-driver";

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
 * Column names of a table, as Postgres actually has them.
 * @param table Table name in the public schema.
 * @returns Every column name declared on that table.
 */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.map((r) => r.column_name);
}

/**
 * The columns making up a table's primary key, in key order.
 * @param table Table name in the public schema.
 * @returns Primary-key column names ordered by their position in the key.
 */
async function primaryKeyOf(table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = ${table}
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `;
  return rows.map((r) => r.column_name);
}

/**
 * The ON DELETE rule of the foreign key sitting on one column.
 * @param table Referencing table name.
 * @param column Referencing column name.
 * @returns The declared delete rule, or null when the column has no FK.
 */
async function deleteRuleOf(table: string, column: string): Promise<string | null> {
  const rows = await sql<{ delete_rule: string }[]>`
    SELECT rc.delete_rule
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = rc.constraint_name
     AND kcu.constraint_schema = rc.constraint_schema
    WHERE kcu.table_schema = 'public'
      AND kcu.table_name = ${table}
      AND kcu.column_name = ${column}
  `;
  return rows[0]?.delete_rule ?? null;
}

/**
 * Index definitions on a table, as `CREATE INDEX` statements.
 * @param table Table name in the public schema.
 * @returns One SQL definition string per index.
 */
async function indexDefsOf(table: string): Promise<string[]> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return rows.map((r) => r.indexdef);
}

describe("current_conversations — the pointer the client never sends", () => {
  it("keys on (user_id, project_id), so one row per user per project", async () => {
    expect(await primaryKeyOf("current_conversations")).toEqual(["user_id", "project_id"]);
  });

  it("stores a conversation id, not a timestamp to sort by", async () => {
    const cols = await columnsOf("current_conversations");
    expect(cols).toContain("conversation_id");

    const notNull = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'current_conversations'
        AND column_name = 'conversation_id'
    `;
    expect(notNull[0]?.is_nullable).toBe("NO");
  });

  it("holds every reference with RESTRICT", async () => {
    expect(await deleteRuleOf("current_conversations", "user_id")).toBe("RESTRICT");
    expect(await deleteRuleOf("current_conversations", "project_id")).toBe("RESTRICT");
    expect(await deleteRuleOf("current_conversations", "conversation_id")).toBe("RESTRICT");
  });

  it("has created_at and deliberately has no deleted_at", async () => {
    const cols = await columnsOf("current_conversations");
    // `created_at` is mandatory on every table, no exceptions.
    expect(cols).toContain("created_at");
    // A pointer row is overwritten, never soft-deleted: the carve-out is
    // registered in the schema-timestamps ESLint rule, which is where the
    // guard actually reads (a migration comment is invisible to it).
    expect(cols).not.toContain("deleted_at");
  });
});

describe("conversation_messages — one row per message", () => {
  it("has the columns a message is made of", async () => {
    const cols = await columnsOf("conversation_messages");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "conversation_id",
        "user_id",
        "role",
        "turn_index",
        "seq",
        "parts",
        "created_at",
        "updated_at",
        "deleted_at",
      ]),
    );
  });

  it("makes (conversation_id, turn_index, seq) unique", async () => {
    const defs = await indexDefsOf("conversation_messages");
    const unique = defs.filter((d) => d.includes("UNIQUE"));
    expect(
      unique.some(
        (d) =>
          d.includes("conversation_id") && d.includes("turn_index") && d.includes("seq"),
      ),
    ).toBe(true);
  });

  it("needs no second index for reads — the unique one already orders them", async () => {
    // Message order IS (turn_index, seq), which is exactly the unique index's
    // key, so every read path is served by it. A separate (conversation_id,
    // created_at) index would only add write amplification.
    const defs = await indexDefsOf("conversation_messages");
    const nonPk = defs.filter((d) => !d.includes("_pkey"));
    expect(nonPk).toHaveLength(1);
  });

  it("holds its references with RESTRICT, so deletes never cascade silently", async () => {
    expect(await deleteRuleOf("conversation_messages", "conversation_id")).toBe("RESTRICT");
    expect(await deleteRuleOf("conversation_messages", "user_id")).toBe("RESTRICT");
  });

  it("defaults parts to an empty array rather than null", async () => {
    const rows = await sql<{ column_default: string | null; is_nullable: string }[]>`
      SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'conversation_messages'
        AND column_name = 'parts'
    `;
    expect(rows[0]?.is_nullable).toBe("NO");
    expect(rows[0]?.column_default ?? "").toContain("[]");
  });
});

describe("the old JSONB column is gone", () => {
  it("no longer exists on conversations", async () => {
    // Leaving it behind would leave two sources of truth for the same data,
    // and the next person to read the schema has no way to tell which one
    // is live. The migration backfills and drops it in one transaction.
    expect(await columnsOf("conversations")).not.toContain("messages");
  });
});
