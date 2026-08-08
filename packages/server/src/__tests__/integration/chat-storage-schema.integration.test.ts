// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Structural promises of the chat message table (PR-3).
 *
 * `conversation_messages` holds one row per message, with `parts` carrying the
 * heterogeneous pieces of that message. It replaces `conversations.messages`,
 * a single column holding the entire array, where every append rewrote and
 * re-compressed the whole document while holding a lock on the conversation
 * row.
 *
 * These promises are invisible to unit tests: a unique index and an FK delete
 * rule exist only in the migration, so only a real Postgres can prove they are
 * there. The behaviour they support — turn numbering under concurrency, cascade
 * soft delete, the round trip through parts — lives in
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
