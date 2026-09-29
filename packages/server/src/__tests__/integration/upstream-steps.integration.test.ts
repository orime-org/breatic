// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two tables behind a run that makes more than one upstream call (#2156,
 * design §15): a task's steps, and the studio's cache of cloned voices,
 * vocals and elements.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts, so what
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
import { initCore } from "@breatic/core";
import { assetRepo, upstreamCloneRepo, upstreamStepRepo } from "@breatic/domain";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user and the studio they created.
 * @returns Both ids.
 */
async function seedStudio(): Promise<{ userId: string; studioId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`steps-${tag}@test.local`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`steps-${tag}`}, 'personal', 'Steps') RETURNING id
  `;
  return { userId: user!.id, studioId: studio!.id };
}

/**
 * A task row for a user.
 * @param userId - The owner.
 * @returns The task id.
 */
async function seedTask(userId: string): Promise<string> {
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, space_id, task_type, mode)
    VALUES (${userId}, ${crypto.randomUUID()}, 'audio', 'append') RETURNING id
  `;
  return task!.id;
}

/**
 * The columns a table has, by name.
 * @param table - The table name.
 * @returns Column names.
 */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
  `;
  return rows.map((r) => r.column_name);
}

describe("studio_upstream_clones", () => {
  it("answers the id recorded for a source, and nothing for another", async () => {
    const { studioId } = await seedStudio();

    expect(await upstreamCloneRepo.recordClone(studioId, "vocal", "sha-a", "vocal-1")).toBe(true);

    expect(await upstreamCloneRepo.findClone(studioId, "vocal", "sha-a")).toBe("vocal-1");
    expect(await upstreamCloneRepo.findClone(studioId, "vocal", "sha-b")).toBeNull();
    expect(await upstreamCloneRepo.findClone(studioId, "voice", "sha-a")).toBeNull();
  });

  it("keeps the first of two clones of the same source", async () => {
    const { studioId } = await seedStudio();
    await upstreamCloneRepo.recordClone(studioId, "voice", "sha-a", "first");

    expect(await upstreamCloneRepo.recordClone(studioId, "voice", "sha-a", "second")).toBe(false);
    expect(await upstreamCloneRepo.findClone(studioId, "voice", "sha-a")).toBe("first");
  });

  it("does not answer one studio's clone to another", async () => {
    const a = await seedStudio();
    const b = await seedStudio();
    await upstreamCloneRepo.recordClone(a.studioId, "element", "sha-a:cat", "el-1");

    expect(await upstreamCloneRepo.findClone(b.studioId, "element", "sha-a:cat")).toBeNull();
  });

  it("forgets a clone the upstream no longer knows, and takes a new one for that source", async () => {
    const { studioId } = await seedStudio();
    await upstreamCloneRepo.recordClone(studioId, "voice", "sha-a", "gone");

    await upstreamCloneRepo.retireClone(studioId, "voice", "gone");

    expect(await upstreamCloneRepo.findClone(studioId, "voice", "sha-a")).toBeNull();
    expect(await upstreamCloneRepo.recordClone(studioId, "voice", "sha-a", "fresh")).toBe(true);
    expect(await upstreamCloneRepo.findClone(studioId, "voice", "sha-a")).toBe("fresh");
    const rows = await sql`SELECT upstream_id, deleted_at FROM studio_upstream_clones WHERE studio_id = ${studioId}`;
    expect(rows).toHaveLength(2);
  });

  it("refuses a kind outside voice, vocal and element", async () => {
    const { studioId } = await seedStudio();
    await expect(
      sql`INSERT INTO studio_upstream_clones (studio_id, kind, source_key, upstream_id)
          VALUES (${studioId}, 'song', 'sha', 'x')`,
    ).rejects.toThrow(/studio_upstream_clones_kind_check/);
  });

  it("is soft-deleted and timestamped", async () => {
    expect(await columnsOf("studio_upstream_clones")).toEqual(
      expect.arrayContaining(["created_at", "updated_at", "deleted_at"]),
    );
  });
});

describe("the cache key of a clone source", () => {
  it("is the hash of the studio's asset stored under the source's key, and nothing for another studio", async () => {
    const a = await seedStudio();
    const b = await seedStudio();
    const key = `audio/2026-09-28/${crypto.randomUUID()}.mp3`;
    await sql`
      INSERT INTO studio_assets
        (studio_id, produced_by_user_id, content_hash, storage_key, file_url, mime_type, kind, source, size_bytes)
      VALUES (${a.studioId}, ${a.userId}, 'sha-vocal', ${key}, ${`https://example.test/${key}`}, 'audio/mpeg', 'audio', 'upload', 10)
    `;

    expect(await assetRepo.findHashByStorageKey(a.studioId, key)).toBe("sha-vocal");
    expect(await assetRepo.findHashByStorageKey(b.studioId, key)).toBeNull();
  });
});

describe("task_upstream_steps", () => {
  const PLAN = [
    { kind: "upload_reference", endpoint: "mureka-ai/create-upload-id", itemIndex: null },
    { kind: "vocal", endpoint: "mureka-ai/vocal-clone", itemIndex: null },
    { kind: "generate", endpoint: "mureka-ai/mureka-v9.5/generate-song", itemIndex: null },
  ] as const;

  it("writes a task's steps once, in order, all pending", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);

    const steps = await upstreamStepRepo.ensureSteps(taskId, PLAN);

    expect(steps.map((s) => [s.position, s.kind, s.status])).toEqual([
      [0, "upload_reference", "pending"],
      [1, "vocal", "pending"],
      [2, "generate", "pending"],
    ]);
  });

  it("answers the steps already written when the task is delivered again", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);
    const first = await upstreamStepRepo.ensureSteps(taskId, PLAN);
    await upstreamStepRepo.markSubmitted(first[0]!.id, "pred-1");

    const again = await upstreamStepRepo.ensureSteps(taskId, [PLAN[2]]);

    expect(again.map((s) => s.kind)).toEqual(["upload_reference", "vocal", "generate"]);
    expect(again[0]).toMatchObject({ status: "submitted", predictionId: "pred-1" });
  });

  it("records what a step answered and what it cost besides its prediction", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);
    const [step] = await upstreamStepRepo.ensureSteps(taskId, [PLAN[0]]);

    await upstreamStepRepo.recordInline(step!.id, { description: "a cat" }, 0.0021);
    await upstreamStepRepo.markDone(step!.id, { reference_id: "163346078760961" });

    const [row] = await upstreamStepRepo.listSteps(taskId);
    expect(row).toMatchObject({
      status: "done",
      output: { description: "a cat", reference_id: "163346078760961" },
      inlineCostUsd: 0.0021,
    });
  });

  it("marks a step failed with the upstream's words, keeping what it already learned", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);
    const [step] = await upstreamStepRepo.ensureSteps(taskId, [PLAN[0]]);
    await upstreamStepRepo.recordInline(step!.id, { description: "a cat" }, 0);

    await upstreamStepRepo.markFailed(step!.id, "audio too short");

    const [row] = await upstreamStepRepo.listSteps(taskId);
    expect(row).toMatchObject({ status: "failed", output: { description: "a cat", error: "audio too short" } });
  });

  it("refuses a status or a kind the executor does not know", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);
    await expect(
      sql`INSERT INTO task_upstream_steps (task_id, position, kind, endpoint, status)
          VALUES (${taskId}, 0, 'generate', 'x', 'running')`,
    ).rejects.toThrow(/task_upstream_steps_status_check/);
    await expect(
      sql`INSERT INTO task_upstream_steps (task_id, position, kind, endpoint)
          VALUES (${taskId}, 0, 'upload', 'x')`,
    ).rejects.toThrow(/task_upstream_steps_kind_check/);
  });

  it("has created_at and updated_at and no deleted_at: a step follows its task", async () => {
    const columns = await columnsOf("task_upstream_steps");
    expect(columns).toEqual(expect.arrayContaining(["created_at", "updated_at"]));
    expect(columns).not.toContain("deleted_at");
  });
});
