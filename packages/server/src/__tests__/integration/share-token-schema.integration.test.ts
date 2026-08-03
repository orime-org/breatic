// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The share token every waiting-for-an-answer request carries (task #25).
 *
 * All five flows — studio invite, project invite, studio transfer, project
 * transfer, role upgrade — are reached through one landing page at
 * `/decision?token=`, so each request row owns the token that names it. The
 * token replaces the Redis-held invite tokens: it lives and dies with the row,
 * which is what lets the LINK stay valid while the THING it points at expires.
 *
 * Three structural promises, none of which a unit test can see:
 *
 *   1. Every request table has the column, and it is NOT NULL — a row without a
 *      token is a request nobody can reach from an email.
 *   2. The column is unique per table, so a token names at most one row.
 *   3. Lookup must find soft-deleted rows too, so the index cannot be partial
 *      on `deleted_at IS NULL`: a request whose project was deleted has to be
 *      distinguishable from a forged token, and that only works if the row is
 *      still findable. This suite pins that the index has no predicate.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core — the core barrel pulls agent/llm →
// the `ai` SDK → @opentelemetry/api, whose ESM build uses bare relative imports
// Node's native ESM rejects. This suite never calls any ai function.
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

const PG_DRIVER_LOCAL = "share-token-schema-test-driver";

/** Every table that holds a request someone is waiting to answer. */
const REQUEST_TABLES = [
  "studio_invitations",
  "project_invitations",
  "role_upgrade_requests",
  "project_transfers",
  "studio_transfers",
] as const;

/** One unique index per table, named after it. */
const TOKEN_INDEXES = REQUEST_TABLES.map((t) => `${t}_share_token_key`);

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

describe("every request table carries a share token", () => {
  it("all five tables have the column", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'share_token'
        AND table_name IN ${sql([...REQUEST_TABLES])}
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      [...REQUEST_TABLES].sort(),
    );
  });

  it("the column is NOT NULL on every one of them", async () => {
    const rows = await sql<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'share_token'
        AND table_name IN ${sql([...REQUEST_TABLES])}
    `;
    expect(rows).toHaveLength(REQUEST_TABLES.length);
    for (const row of rows) {
      expect(row.is_nullable, `${row.table_name}.share_token`).toBe("NO");
    }
  });

  it("all five unique indexes are present", async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ${sql([...TOKEN_INDEXES])}
      ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname).sort()).toEqual([...TOKEN_INDEXES].sort());
  });

  it("no index is partial on deleted_at — a dead request must stay findable", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ${sql([...TOKEN_INDEXES])}
    `;
    // Assert the set is complete BEFORE looping: with no indexes at all the
    // loop body never runs and this test would pass green while proving
    // nothing. That failure mode is the whole reason this line exists.
    expect(rows).toHaveLength(TOKEN_INDEXES.length);
    for (const row of rows) {
      // A `WHERE` clause here would let a soft-deleted row's token be reused,
      // and would make "this request is gone" indistinguishable from "this
      // token was never real" — the landing page has to tell those apart.
      expect(row.indexdef, `${row.indexname} must have no predicate`).not.toMatch(
        /\bWHERE\b/i,
      );
    }
  });
});

describe("a token names at most one request", () => {
  it("the same token cannot be inserted twice into one table", async () => {
    const tag = `st-dup-${Date.now()}`;
    const [{ id: inviterId }] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`${tag}-a@example.com`}, true) RETURNING id
    `;
    const [{ id: firstInvitee }] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`${tag}-b@example.com`}, true) RETURNING id
    `;
    const [{ id: secondInvitee }] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`${tag}-c@example.com`}, true) RETURNING id
    `;
    const [{ id: studioId }] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${inviterId}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
    `;

    const token = "a".repeat(64);
    await sql`
      INSERT INTO studio_invitations
        (studio_id, invited_user_id, role, invited_by, status, expires_at, share_token)
      VALUES (${studioId}, ${firstInvitee}, 'guest', ${inviterId}, 'pending',
              now() + interval '7 days', ${token})
    `;

    await expect(
      sql`
        INSERT INTO studio_invitations
          (studio_id, invited_user_id, role, invited_by, status, expires_at, share_token)
        VALUES (${studioId}, ${secondInvitee}, 'guest', ${inviterId}, 'pending',
                now() + interval '7 days', ${token})
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
