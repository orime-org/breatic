// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Migration 0125 drops the keys that would cross the global and regional
 * databases by what they join, so a database whose tables an earlier draft of
 * a migration built, naming the same key differently, migrates too (inner#1955).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const MIGRATION = resolve(__dirname, "../../../../core/src/db/migrations/0125_regions.sql");

let sql: ReturnType<typeof postgres>;
let dropKeys: string;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: "regions-migration-test" } });
  const statements = (await readFile(MIGRATION, "utf8")).split("--> statement-breakpoint");
  dropKeys = statements.find((statement) => statement.includes("FOR target IN"))!;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Ends the probe transaction without keeping anything. */
class RolledBack extends Error {}

describe("0125 dropping the keys across the region line", () => {
  it("drops a key whatever it is named, and leaves a region's own keys alone", async () => {
    const seen: { before: string[]; after: string[]; kept: number } = { before: [], after: [], kept: 0 };
    await sql
      .begin(async (tx) => {
        await tx`ALTER TABLE node_tasks ADD CONSTRAINT node_tasks_started_by_user_id_fkey
          FOREIGN KEY (started_by_user_id) REFERENCES users(id) NOT VALID`;
        const keys = async (): Promise<string[]> =>
          (await tx<{ conname: string }[]>`
            SELECT conname FROM pg_constraint
            WHERE contype = 'f' AND conrelid = 'node_tasks'::regclass AND confrelid = 'users'::regclass`).map((row) => row.conname);
        seen.before = await keys();
        const regional = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'node_tasks'::regclass AND confrelid <> 'users'::regclass`;
        await tx.unsafe(dropKeys);
        seen.after = await keys();
        const left = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'node_tasks'::regclass AND confrelid <> 'users'::regclass`;
        seen.kept = left[0]!.n - regional[0]!.n;
        throw new RolledBack();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RolledBack)) throw err;
      });

    expect(seen.before).toEqual(["node_tasks_started_by_user_id_fkey"]);
    expect(seen.after).toEqual([]);
    expect(seen.kept).toBe(0);
  });
});
