// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The schema mini-tools write into (inner#888): what a task row was doing,
 * the container job step, and one usage row per container task.
 *
 * Runs against the testcontainer Postgres started by @breatic/integration-tests/containers, so what
 * it reads is the schema the migration actually produced.
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

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user and one task they own.
 * @returns Both ids.
 */
async function seedTask(): Promise<{ userId: string; taskId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`mini-${tag}@test.local`}, true) RETURNING id
  `;
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, space_id, task_type, mode)
    VALUES (${user!.id}, ${crypto.randomUUID()}, 'video', 'append') RETURNING id
  `;
  return { userId: user!.id, taskId: task!.id };
}

/**
 * Insert one usage row.
 * @param userId - The actor.
 * @param operationKey - The row's operation key.
 * @param source - The row's source.
 * @returns The insert.
 */
function usageRow(userId: string, operationKey: string, source: string): Promise<unknown> {
  return sql`
    INSERT INTO agent_usage_records
      (operation_key, feature, source, actor_user_id, model, provider, cost_usd, cost_source, credits)
    VALUES (${operationKey}, 'mini_tool', ${source}, ${userId}, 'm', 'cloudflare', 0.01, 'computed', 1)
    ON CONFLICT DO NOTHING
  `;
}

describe("node_tasks.action", () => {
  it("is required and holds one of the four actions", async () => {
    const [column] = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'node_tasks' AND column_name = 'action'
    `;
    expect(column?.is_nullable).toBe("NO");
    const [check] = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'node_tasks_action_check'
    `;
    for (const action of ["upload", "generate", "understand", "mini_tool"]) {
      expect(check?.def).toContain(`'${action}'`);
    }
  });
});

describe("task_upstream_steps", () => {
  it("takes a container job step", async () => {
    const { taskId } = await seedTask();
    await expect(
      sql`INSERT INTO task_upstream_steps (task_id, position, kind, endpoint)
          VALUES (${taskId}, 0, 'container_job', 'MiniToolContainerStd1')`,
    ).resolves.toBeDefined();
  });
});

describe("agent_usage_records for container runs", () => {
  it("keeps one container row per operation key", async () => {
    const { userId, taskId } = await seedTask();
    const key = `task:${taskId}`;

    await usageRow(userId, key, "container");
    await usageRow(userId, key, "container");

    const rows = await sql`SELECT id FROM agent_usage_records WHERE operation_key = ${key}`;
    expect(rows).toHaveLength(1);
  });

  it("leaves every other source free to write several rows under one key", async () => {
    const { userId, taskId } = await seedTask();
    const key = `task:${taskId}`;

    await usageRow(userId, key, "model");
    await usageRow(userId, key, "model");

    const rows = await sql`SELECT id FROM agent_usage_records WHERE operation_key = ${key}`;
    expect(rows).toHaveLength(2);
  });
});
