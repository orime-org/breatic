// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two tables behind a run that makes more than one upstream call (#2156,
 * design §15): a task's steps, and the studio's cache of cloned voices,
 * vocals and elements.
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
import { initCore } from "@breatic/core";
import { assetRepo, taskService, upstreamCloneRepo, upstreamStepRepo } from "@breatic/domain";

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
  it("answers the live clones of the sources asked about, an element's by its sha256 prefix, on every upstream", async () => {
    const { studioId } = await seedStudio();
    expect(await upstreamCloneRepo.recordClone(studioId, "wavespeed", "vocal", "sha-a", "vocal-1")).toBe(true);
    await upstreamCloneRepo.recordClone(studioId, "fal", "vocal", "sha-a", "vocal-fal");
    await upstreamCloneRepo.recordClone(studioId, "wavespeed", "element", "sha-a:Element 1", "el-1");
    await upstreamCloneRepo.recordClone(studioId, "wavespeed", "voice", "sha-b", "voice-b");
    await upstreamCloneRepo.recordClone(studioId, "wavespeed", "voice", "sha-a-longer", "not-a");

    const live = await upstreamCloneRepo.liveClonesFor(studioId, ["sha-a"]);

    expect(live.map((c) => [c.upstream, c.kind, c.sourceKey, c.upstreamId]).sort()).toEqual([
      ["fal", "vocal", "sha-a", "vocal-fal"],
      ["wavespeed", "element", "sha-a:Element 1", "el-1"],
      ["wavespeed", "vocal", "sha-a", "vocal-1"],
    ]);
    expect(await upstreamCloneRepo.liveClonesFor(studioId, [])).toEqual([]);
  });

  it("keeps the first of two clones of the same source on one upstream", async () => {
    const { studioId } = await seedStudio();
    await upstreamCloneRepo.recordClone(studioId, "wavespeed", "voice", "sha-a", "first");

    expect(await upstreamCloneRepo.recordClone(studioId, "wavespeed", "voice", "sha-a", "second")).toBe(false);
    expect((await upstreamCloneRepo.liveClonesFor(studioId, ["sha-a"])).map((c) => c.upstreamId)).toEqual(["first"]);
  });

  it("does not answer one studio's clone to another", async () => {
    const a = await seedStudio();
    const b = await seedStudio();
    await upstreamCloneRepo.recordClone(a.studioId, "wavespeed", "element", "sha-a:cat", "el-1");

    expect(await upstreamCloneRepo.liveClonesFor(b.studioId, ["sha-a"])).toEqual([]);
  });

  it("forgets a clone the upstream no longer knows, on that upstream alone, and takes a new one for that source", async () => {
    const { studioId } = await seedStudio();
    await upstreamCloneRepo.recordClone(studioId, "wavespeed", "voice", "sha-a", "gone");
    await upstreamCloneRepo.recordClone(studioId, "fal", "voice", "sha-a", "gone");

    await upstreamCloneRepo.retireClone(studioId, "wavespeed", "voice", "gone");

    expect((await upstreamCloneRepo.liveClonesFor(studioId, ["sha-a"])).map((c) => c.upstream)).toEqual(["fal"]);
    expect(await upstreamCloneRepo.recordClone(studioId, "wavespeed", "voice", "sha-a", "fresh")).toBe(true);
    const rows = await sql`SELECT upstream_id, deleted_at FROM studio_upstream_clones WHERE studio_id = ${studioId} AND upstream = 'wavespeed'`;
    expect(rows).toHaveLength(2);
  });

  it("refuses a kind outside voice, vocal and element", async () => {
    const { studioId } = await seedStudio();
    await expect(
      sql`INSERT INTO studio_upstream_clones (studio_id, upstream, kind, source_key, upstream_id)
          VALUES (${studioId}, 'wavespeed', 'song', 'sha', 'x')`,
    ).rejects.toThrow(/studio_upstream_clones_kind_check/);
  });

  it("is soft-deleted and timestamped", async () => {
    expect(await columnsOf("studio_upstream_clones")).toEqual(
      expect.arrayContaining(["created_at", "updated_at", "deleted_at"]),
    );
  });
});

describe("the cache key of a clone source", () => {
  // Storage keys are tenant-neutral: a node pasted from another studio keeps
  // the url, and the bytes under it are the same bytes, so the key still
  // finds their hash. The clone row the hash keys stays per studio.
  it("is the hash of the asset stored under the source's key, whichever studio registered it", async () => {
    const a = await seedStudio();
    const key = `audio/2026-09-28/${crypto.randomUUID()}.mp3`;
    await sql`
      INSERT INTO studio_assets
        (studio_id, produced_by_user_id, content_hash, storage_key, file_url, mime_type, kind, source, size_bytes)
      VALUES (${a.studioId}, ${a.userId}, 'sha-vocal', ${key}, ${`https://example.test/${key}`}, 'audio/mpeg', 'audio', 'upload', 10)
    `;

    expect(await assetRepo.findHashByStorageKey(key)).toBe("sha-vocal");
    expect(await assetRepo.findHashByStorageKey(`audio/2026-09-28/${crypto.randomUUID()}.mp3`)).toBeNull();
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

  // Design 15.1: finishFailedRun calls this once the run settles; a done step
  // keeps its state and the open ones take the reason.
  it("fails the open steps with the reason and keeps the finished ones", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);
    const [done, submitted, pending] = await upstreamStepRepo.ensureSteps(taskId, PLAN);
    await upstreamStepRepo.markDone(done!.id, { reference_id: "163346078760961" });
    await upstreamStepRepo.markSubmitted(submitted!.id, "pred-2");

    await upstreamStepRepo.failOpenSteps(taskId, "upstream refused");

    const rows = await upstreamStepRepo.listSteps(taskId);
    expect(rows.map((r) => r.status)).toEqual(["done", "failed", "failed"]);
    expect(rows[1]).toMatchObject({ predictionId: "pred-2", output: { error: "upstream refused" } });
    expect(rows[2]?.output).toMatchObject({ error: "upstream refused" });
    expect(pending?.status).toBe("pending");
  });

  // A failed attempt with a retry still to come marks the task row; the retry
  // resumes from the steps, so they keep their state.
  it("leaves the steps alone when only the task row is marked failed", async () => {
    const { userId } = await seedStudio();
    const taskId = await seedTask(userId);
    const [, submitted] = await upstreamStepRepo.ensureSteps(taskId, PLAN);
    await upstreamStepRepo.markSubmitted(submitted!.id, "pred-2");

    await taskService.markFailed(taskId, "poll timed out");

    const rows = await upstreamStepRepo.listSteps(taskId);
    expect(rows.map((r) => r.status)).toEqual(["pending", "submitted", "pending"]);
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
