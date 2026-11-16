// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * No foreign key crosses between global and regional tables (inner#1955) —
 * real PG, after every migration.
 *
 * A region's database holds global tables empty, so a regional row pointing
 * at `users` could never be written there, and a global row pointing at a
 * Studio could never be written in the global region for a Studio that lives
 * elsewhere. A table split by row (`both`) holds account rows globally and
 * Studio rows regionally, so it may point at regional tables, never at global
 * ones.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { TABLE_PLACEMENT } from "@breatic/core";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Whether a key from one placement to another can hold in every region.
 * @param from - The referencing table's placement.
 * @param to - The referenced table's placement.
 * @returns True when both ends live in the same database.
 */
function holdsEverywhere(from: string, to: string): boolean {
  if (from === to) return true;
  return (from === "regional" || from === "both") && (to === "regional" || to === "both");
}

describe("foreign keys", () => {
  it("never cross between global and regional tables", async () => {
    const keys = await sql<{ from_table: string; column: string; to_table: string }[]>`
      SELECT c.conrelid::regclass::text AS from_table, a.attname AS column, c.confrelid::regclass::text AS to_table
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    `;
    const crossing = keys
      .filter((key) => TABLE_PLACEMENT[key.from_table] !== undefined && TABLE_PLACEMENT[key.to_table] !== undefined)
      .filter((key) => !holdsEverywhere(TABLE_PLACEMENT[key.from_table]!, TABLE_PLACEMENT[key.to_table]!))
      .map((key) => `${key.from_table}.${key.column} -> ${key.to_table}`);

    expect(keys.length).toBeGreaterThan(0);
    expect(crossing).toEqual([]);
  });
});
