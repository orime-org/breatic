// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The three deferred-decision request tables and the uniqueness they rest on.
 *
 * Role-upgrade requests, project transfers and studio transfers each get their
 * own table (task #28), because living as a row in `notifications` left them
 * with no status column, no uniqueness and no expiry — see the design doc.
 * This suite pins the two structural promises the rest of the feature is built
 * on, both of which are invisible to unit tests:
 *
 *   1. At most ONE live pending request per key. Enforced by a partial unique
 *      index, which Drizzle's table builder cannot emit — it exists only in the
 *      migration, so only a real Postgres can prove it is there.
 *   2. Reaching a terminal status FREES that key. The index predicate cannot
 *      reference `now()` (a partial index predicate must be immutable), so a
 *      timed-out row keeps `status = 'pending'` and holds its slot until
 *      something flips it — the same trap the invite tables hit (#1769). The
 *      create path reaps stale pendings before inserting; this suite proves the
 *      slot actually frees once the status moves.
 *
 * Grain differs by table and is deliberate: role-upgrade is one pending per
 * (project, requester) so different viewers can each ask; a transfer is one
 * pending per CONTAINER, since a project has exactly one owner and can never be
 * offered to two people at once.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed so this suite needs no API key and makes no provider
// request. Without the stub, CI — which sets no key anywhere — would get an
// AI_LoadAPIKeyError delivered as an `error` stream part: the stream still
// ends cleanly and every assertion still passes, so the suite would quietly
// stop covering what it appears to cover. A machine that does have a key
// would issue a real request instead.
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

const PG_DRIVER_LOCAL = "request-tables-schema-test-driver";

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

let seq = 0;

async function seedProject(): Promise<{ userId: string; studioId: string; projectId: string }> {
  const tag = `rt-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  return { userId: user!.id, studioId: studio!.id, projectId: project!.id };
}

async function insertUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`rt-u-${seq++}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

const EXPECTED_TABLES = [
  "role_upgrade_requests",
  "project_transfers",
  "studio_transfers",
] as const;

const EXPECTED_INDEXES = [
  "role_upgrade_requests_one_pending",
  "project_transfers_one_pending",
  "studio_transfers_one_pending",
] as const;

// These three catalog queries use postgres.js's `IN ${sql([...])}` list form,
// which expands to one scalar parameter per element. The tempting
// `= ANY(${sql.array([...])})` is TIMING-DEPENDENT and must not be used here:
// `sql.array` types a string array as OID 25 (scalar text — `inferType` has no
// string branch, so it falls through to the `|| 25` default), and the real
// array OID is patched in from `typeArrayMap`, a shared map that starts empty
// and is filled by a `pg_type` query when a pooled connection comes up. Serialize
// a parameter before that lands and Postgres receives scalar text, answering
// "op ANY/ALL (array) requires array on right side".
describe("the three request tables exist with their uniqueness", () => {
  it("all three tables are present", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ${sql([...EXPECTED_TABLES])}
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it("all three partial unique indexes are present", async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ${sql([...EXPECTED_INDEXES])}
      ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname).sort()).toEqual([...EXPECTED_INDEXES].sort());
  });

  it("every one of them has a NOT NULL expires_at", async () => {
    const rows = await sql<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'expires_at'
        AND table_name IN ${sql([...EXPECTED_TABLES])}
    `;
    expect(rows).toHaveLength(EXPECTED_TABLES.length);
    expect(rows.every((r) => r.is_nullable === "NO")).toBe(true);
  });
});

describe("one live pending per key, and a terminal status frees it", () => {
  it("a project may hold only one pending transfer, whoever it is offered to", async () => {
    const { userId: owner, projectId } = await seedProject();
    const first = await insertUser();
    const second = await insertUser();

    await sql`
      INSERT INTO project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${projectId}, ${owner}, ${first}, 'pending', now() + interval '7 days', replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
    `;

    // Same project, a different recipient: the grain is the CONTAINER, so this
    // must be refused even though no (project, recipient) pair repeats.
    await expect(
      sql`
        INSERT INTO project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${projectId}, ${owner}, ${second}, 'pending', now() + interval '7 days', replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
      `,
    ).rejects.toThrow(/project_transfers_one_pending/);
  });

  it("flipping the held row to a terminal status frees the slot", async () => {
    const { userId: owner, projectId } = await seedProject();
    const first = await insertUser();
    const second = await insertUser();

    await sql`
      INSERT INTO project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${projectId}, ${owner}, ${first}, 'pending', now() - interval '1 day', replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
    `;
    // What the create-path reaper does: a timed-out pending is flipped to
    // 'expired', which leaves the index predicate.
    await sql`
      UPDATE project_transfers SET status = 'expired'
      WHERE project_id = ${projectId} AND status = 'pending' AND expires_at <= now()
    `;

    await sql`
      INSERT INTO project_transfers (project_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${projectId}, ${owner}, ${second}, 'pending', now() + interval '7 days', replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
    `;

    const rows = await sql<{ status: string; c: number }[]>`
      SELECT status, count(*)::int AS c FROM project_transfers
      WHERE project_id = ${projectId} GROUP BY status ORDER BY status
    `;
    expect(rows).toEqual([
      { status: "expired", c: 1 },
      { status: "pending", c: 1 },
    ]);
  });

  it("role-upgrade is keyed per requester, so two viewers may each have one pending", async () => {
    const { projectId } = await seedProject();
    const viewerA = await insertUser();
    const viewerB = await insertUser();

    for (const viewer of [viewerA, viewerB]) {
      await sql`
        INSERT INTO role_upgrade_requests
          (project_id, requester_user_id, requested_role, status, expires_at, share_token)
      VALUES (${projectId}, ${viewer}, 'editor', 'pending', now() + interval '7 days', replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
      `;
    }

    // But the same viewer twice is refused.
    await expect(
      sql`
        INSERT INTO role_upgrade_requests
          (project_id, requester_user_id, requested_role, status, expires_at, share_token)
      VALUES (${projectId}, ${viewerA}, 'editor', 'pending', now() + interval '7 days', replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''))
      `,
    ).rejects.toThrow(/role_upgrade_requests_one_pending/);
  });
});
