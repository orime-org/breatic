// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The membership tier column on `users` (task #16, migration 0051).
 *
 * A tier decides capacity and collaboration scale — storage, team studios,
 * projects, members, simultaneous writable connections. It lives on the
 * account because it follows the person: every studio they administer reads
 * its ceilings from their tier, and a studio transfer moves the studio onto
 * whoever ends up administering it.
 *
 * Structural promises a unit test cannot see:
 *
 *   1. The column exists and is NOT NULL — an account with no tier has no
 *      ceilings at all, and every quota check would have to invent a fallback.
 *   2. It carries a database-level default, which is what lets the migration
 *      add a NOT NULL column to a table that already has rows.
 *   3. An INSERT that names no tier lands on `base`, the most restrictive one.
 *      A row that silently arrived on an unlimited tier is the failure this
 *      pins: it would be invisible until someone audited the table.
 *
 * The database default is deliberately NOT the same thing as the deployment's
 * `default_tier` in `config/membership.yaml`. The config decides where newly
 * registered accounts land and is what makes an install self-hosted or ours;
 * this default only backstops a write that names no tier at all.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";

const PG_DRIVER_LOCAL = "membership-tier-schema-test-driver";

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

describe("users.membership_tier", () => {
  it("exists, is NOT NULL, and defaults to base", async () => {
    const rows = await sql<
      {
        data_type: string;
        character_maximum_length: number | null;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      SELECT data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'membership_tier'
    `;

    // Asserted before reading rows[0]: with no column at all the field
    // accesses below would each read undefined and could still be made to
    // pass, which would leave this suite green on a missing migration.
    expect(rows, "users.membership_tier is missing").toHaveLength(1);

    const col = rows[0];
    expect(col?.data_type).toBe("character varying");
    expect(col?.character_maximum_length).toBe(16);
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/'base'/);
  });

  it("gives a row that names no tier the most restrictive one", async () => {
    // The structural check above says a default exists; this one says the
    // default is the one we meant. A row landing on `enterprise` would carry
    // ceilings nobody reaches, and nothing would surface it.
    const email = `tier-default-${Date.now()}-${Math.random()}@example.test`;
    const [row] = await sql<{ membership_tier: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${email}, true)
      RETURNING membership_tier
    `;
    try {
      expect(row?.membership_tier).toBe("base");
    } finally {
      await sql`DELETE FROM users WHERE email = ${email}`;
    }
  });
});
