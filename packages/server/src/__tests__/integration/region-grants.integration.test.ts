// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Outside the global region the services' role may use every region table
 * and none of the global ones (inner#1955, acceptance 9): a stray global
 * query fails instead of reading the empty copy, and a table a later
 * migration adds is usable after the next migrate.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { applyRegionGrants, initCore } from "@breatic/core";

let sql: ReturnType<typeof postgres>;
const role = `region_app_${crypto.randomBytes(4).toString("hex")}`;

beforeAll(async () => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: "region-grants-test" } });
  await sql`CREATE ROLE ${sql(role)} NOLOGIN`;
});

afterAll(async () => {
  await sql`DROP TABLE IF EXISTS region_grants_probe`;
  // The grants live in both databases; each must let go of the role first.
  const yjs = postgres(inject("YJS_DATABASE_URL"), { max: 1, prepare: false });
  await yjs`DROP OWNED BY ${yjs(role)}`;
  await yjs.end({ timeout: 5 });
  await sql`DROP OWNED BY ${sql(role)}`;
  await sql`DROP ROLE ${sql(role)}`;
  await sql?.end({ timeout: 5 });
});

/**
 * Run one read as the services' role.
 * @param table - The table to read.
 * @returns The SQLSTATE it failed with, or null when it read.
 */
async function readAs(table: string): Promise<string | null> {
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${tx(role)}`;
      await tx`SELECT 1 FROM ${tx(table)} LIMIT 1`;
    });
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

describe("applyRegionGrants", () => {
  it("lets the role read region tables and refuses the global ones", async () => {
    await applyRegionGrants(role);

    expect(await readAs("studios")).toBeNull();
    expect(await readAs("projects")).toBeNull();
    expect(await readAs("region_outbox")).toBeNull();
    expect(await readAs("users")).toBe("42501");
    expect(await readAs("credit_lots")).toBe("42501");
    expect(await readAs("studio_directory")).toBe("42501");
  });

  it("covers a table added after the last grant once migrate grants again", async () => {
    await sql`CREATE TABLE region_grants_probe (id int)`;
    expect(await readAs("region_grants_probe")).toBe("42501");

    await applyRegionGrants(role);

    expect(await readAs("region_grants_probe")).toBeNull();
  });
});
