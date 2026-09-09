// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the node task table has to hold, and what it must NOT hold (task #186).
 *
 * A node used to carry one handling lease, so "is this node busy" was a
 * boolean and the database enforced nothing. The table replaces that with one
 * row per task, and two of its properties are load bearing in a way no unit
 * test can see:
 *
 *   1. Nothing may make a second running row on the same node impossible. A
 *      partial unique index of the shape `(node_id) WHERE status = 'running'`
 *      would read as a reasonable guard and would silently restore the single
 *      lease this task exists to remove. The suite asserts the absence.
 *   2. `node_history_id` points at the row that already holds the result, so
 *      the task table stores no copy of the content. A task whose deadline
 *      passed before its report arrived keeps `expired` AND gets this column
 *      filled — that pairing is what lets the user pull the result back.
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

const PG_DRIVER_LOCAL = "node-tasks-schema-test-driver";

/**
 * Every column the task table needs. The context ones (`project_id`,
 * `space_id`, `node_id`) are what an event needs to name its document, and
 * they are checked against the caller's permissions before a row is written.
 */
const TASK_COLUMNS = [
  "id",
  "project_id",
  "space_id",
  "node_id",
  "kind",
  "status",
  "started_by_user_id",
  "started_at",
  "settled_at",
  "budget_ms",
  "label",
  "error_message",
  "node_history_id",
  "task_id",
  "storage_key",
  "created_at",
  "updated_at",
  "deleted_at",
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

describe("node_tasks holds one row per task", () => {
  it("has every column the task lifecycle reads", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'node_tasks'
        AND column_name IN ${sql([...TASK_COLUMNS])}
      ORDER BY column_name
    `;
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [...TASK_COLUMNS].sort(),
    );
  });

  it("keeps started_at an absolute instant — the countdown reads it", async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'node_tasks'
        AND column_name = 'started_at'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe("timestamp with time zone");
    expect(rows[0]?.is_nullable).toBe("NO");
  });

  it("requires budget_ms on every row — the timer is set from it", async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'node_tasks'
        AND column_name = 'budget_ms'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe("integer");
    expect(rows[0]?.is_nullable).toBe("NO");
  });

  it("points at the history row instead of copying the result", async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'node_tasks'
        AND column_name = 'node_history_id'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe("uuid");
    // Nullable: a running row has no result yet, and a failed one never will.
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  it("restricts deleting a history row a task still points at", async () => {
    const rows = await sql<{ delete_rule: string }[]>`
      SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = rc.constraint_name
       AND kcu.constraint_schema = rc.constraint_schema
      WHERE kcu.table_schema = 'public'
        AND kcu.table_name = 'node_tasks'
        AND kcu.column_name = 'node_history_id'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delete_rule).toBe("RESTRICT");
  });

  it("carries deleted_at, because finishing a task hides the row and keeps it", async () => {
    const rows = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'node_tasks'
        AND column_name = 'deleted_at'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe("timestamp with time zone");
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  it("indexes the pair every read starts from", async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'node_tasks'
        AND indexdef ILIKE '%project_id%' AND indexdef ILIKE '%node_id%'
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("nothing in the schema caps how many tasks a node may run", () => {
  it("has no unique index over node_id", async () => {
    // An absence assertion passes for free while the table is missing, which
    // would read as "no cap exists" when in fact nothing exists. Anchor it.
    const table = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'node_tasks'
    `;
    expect(table[0]?.n).toBe("1");

    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'node_tasks'
        AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%node_id%'
    `;
    expect(rows.map((r) => r.indexname)).toEqual([]);
  });

  it("takes a second running row on the same node", async () => {
    // The integration database starts empty, so the row this case needs has
    // to be seeded here. Reading whatever happens to be lying around would
    // make the case depend on suite order.
    const users = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`nts-${crypto.randomUUID()}@example.com`}, true) RETURNING id
    `;
    const userId = users[0]!.id;
    const studios = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${userId}, ${`nts-${crypto.randomUUID()}`}, 'personal', 'P')
      RETURNING id
    `;
    const slug = `nts-${crypto.randomUUID()}`;
    const projects = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
      VALUES (${studios[0]!.id}, ${userId}, ${slug}, ${slug}, 'private')
      RETURNING id
    `;
    const projectId = projects[0]!.id;
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    const insert = (label: string) => sql`
      INSERT INTO node_tasks
        (project_id, space_id, node_id, kind, status,
         started_by_user_id, started_at, budget_ms, label)
      VALUES
        (${projectId}, ${spaceId}, ${nodeId}, 'upload', 'running',
         ${userId}, now(), 600000, ${label})
      RETURNING id
    `;

    try {
      const first = await insert("first.png");
      const second = await insert("second.png");
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);

      const live = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM node_tasks
        WHERE node_id = ${nodeId} AND status = 'running' AND deleted_at IS NULL
      `;
      expect(live[0]?.n).toBe("2");
    } finally {
      await sql`DELETE FROM node_tasks WHERE node_id = ${nodeId}`;
    }
  });
});
