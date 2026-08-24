// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The membership tier column on `users` (task #16, migration 0052).
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
import { initCore, getDefaultMembershipTier } from "@breatic/core";
import * as userRepo from "@server/modules/auth/user.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

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
    // default is the one we meant. A row landing on `self_hosted` would carry
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

  it("puts a newly registered account on the configured tier, not the column default", async () => {
    // The two defaults are different things and this is the case that keeps
    // them apart. The column default backstops a write that names no tier;
    // where a REGISTRATION lands is a deployment decision, and the field that
    // carries it is the one thing distinguishing a self-hosted install from
    // ours.
    //
    // Gate 2 caught the config field being read, validated, frozen into
    // memory, and then never called: every new account fell through to the
    // column default instead. On a self-hosted install that is `base`, whose
    // team-studio ceiling is zero — so nobody there could create even one
    // team studio, and the refusal told them to upgrade on a deployment with
    // nothing to upgrade to.
    //
    // What this case can prove depends on the config it runs against, and
    // saying so out loud is the point of this check.
    //
    // The repository's config/membership.yaml is the file a self-hosted
    // install ships with, so `default_tier` there is `self_hosted` and the
    // assertion below discriminates: deleting the write from createUser makes
    // it fail. Measured, not assumed.
    //
    // Our own deployment is expected to set `base` (design §6.3). Under that
    // value the write and the column default produce the same row, so nothing
    // black-box can tell them apart and this case would pass with the write
    // gone. That is a property of the configuration, not a defect — but it
    // must not pass silently, so the check below fails loudly and says what
    // was lost rather than letting the case quietly stop testing anything.
    expect(
      getDefaultMembershipTier(),
      "config/membership.yaml now sets default_tier to the same value as the " +
        "users.membership_tier column default, so this case can no longer " +
        "tell 'createUser wrote the tier' apart from 'the column default " +
        "applied'. The behaviour is still required; it is this test that " +
        "stopped being able to see it.",
    ).not.toBe("base");

    const email = `tier-reg-${Date.now()}-${Math.random()}@example.test`;
    const user = await userRepo.createUser({ email });
    try {
      const [row] = await sql<{ membership_tier: string }[]>`
        SELECT membership_tier FROM users WHERE id = ${user.id}
      `;
      expect(row?.membership_tier).toBe(getDefaultMembershipTier());
    } finally {
      await sql`DELETE FROM users WHERE email = ${email}`;
    }
  });
});
