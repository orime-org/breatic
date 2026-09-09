// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the R2 ingest pipeline needs the tables to hold (task #173).
 *
 * The upload grant is the only row that survives between the moment a ticket
 * is signed and the moment the ingest Worker reports back, so everything the
 * server will need at report time has to be on it. Two of those columns are
 * load bearing in a way no unit test can see:
 *
 *   1. `lease_gen` goes away. A node carries several tasks at once (#186), so
 *      an upload's grant fences nothing: the report settles the row the ticket
 *      opened, found by the storage key both sides already hold.
 *   2. `content_hash` goes away. It holds a hash the client claimed, and the
 *      ledger key becomes the one the Worker computes; a column nobody reads
 *      is a column someone will read by mistake.
 *
 * And on the asset side, a video row needs to name its cover: dedup hits
 * resolve to an existing video row, and without that link the node comes back
 * without the cover it already has.
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

const PG_DRIVER_LOCAL = "ingest-schema-test-driver";

/**
 * Columns the report handler reads off the grant. The context ones were
 * uploaded by the browser at ticket time and checked against the user's
 * permissions before landing here, which is why the report can trust them.
 */
const GRANT_COLUMNS = [
  "project_id",
  "node_id",
  "space_id",
  "source",
  "tool_name",
  "derived",
  "filename",
  "voided_at",
  "expires_at",
] as const;

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

describe("upload_grants carries everything the report and the sweep need", () => {
  it("has every column the report handler reads", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'upload_grants'
        AND column_name IN ${sql([...GRANT_COLUMNS])}
      ORDER BY column_name
    `;
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [...GRANT_COLUMNS].sort(),
    );
  });

  it("keeps expires_at an absolute instant, not wall-clock text", async () => {
    const rows = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'upload_grants'
        AND column_name = 'expires_at'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe("timestamp with time zone");
  });

  it("no longer carries lease_gen — an upload's outcome settles its own task row", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'upload_grants'
        AND column_name = 'lease_gen'
    `;
    expect(rows).toEqual([]);
  });

  it("no longer carries content_hash — the ledger key is the one the Worker computes", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'upload_grants'
        AND column_name = 'content_hash'
    `;
    expect(rows).toHaveLength(0);
  });

  it("keeps storage_key unique, so one key names at most one grant", async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'upload_grants'
        AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%storage_key%'
    `;
    expect(rows).toHaveLength(1);
  });
});

describe("studio_assets links a video to its cover", () => {
  it("has cover_asset_id, nullable, only videos ever carry one", async () => {
    const rows = await sql<{ is_nullable: string; data_type: string }[]>`
      SELECT is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'studio_assets'
        AND column_name = 'cover_asset_id'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("YES");
    expect(rows[0]?.data_type).toBe("uuid");
  });

  it("points cover_asset_id at studio_assets itself, with a restricting delete", async () => {
    const rows = await sql<{ delete_rule: string; foreign_table: string }[]>`
      SELECT rc.delete_rule, ccu.table_name AS foreign_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_schema = 'public' AND tc.table_name = 'studio_assets'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'cover_asset_id'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.foreign_table).toBe("studio_assets");
    expect(rows[0]?.delete_rule).toBe("RESTRICT");
  });
});
