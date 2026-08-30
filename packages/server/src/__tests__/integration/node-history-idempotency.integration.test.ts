// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * node_history generation idempotency — real-PG integration (#1618 Y).
 *
 * Pins the data invariant unit mocks cannot: a billed generation must
 * land in node_history EXACTLY ONCE no matter how many times the worker
 * records it (double-live concurrent executions, or a billed-redelivery
 * re-record). Mirrors the project_activities idempotency guard
 * (migration 0034); node_history gets the same treatment in 0036 — a
 * partial UNIQUE (task_id, node_id) WHERE status='success' + an
 * ON CONFLICT DO NOTHING record path.
 *
 * These are RED until 0036 + the idempotent repo path land: the current
 * `recordGenerationSuccess` is a plain INSERT, so two calls leave TWO rows.
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

import crypto from "node:crypto";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import { nodeHistoryService } from "@breatic/domain";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "node-history-idem-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a user + personal studio; returns the user id. */
async function insertUser(name: string): Promise<string> {
  const email = `nh-${seq++}@example.com`;
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const slug = `nh-p-${seq++}`;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${slug}, 'personal', ${name})
  `;
  return userId;
}

/** Insert a team studio + project owned by `ownerUserId`; returns project id. */
async function insertProject(ownerUserId: string): Promise<string> {
  const slug = `nh-studio-${seq++}`;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerUserId}, ${slug}, 'team', ${`S ${slug}`}) RETURNING id
  `;
  const pslug = `nh-proj-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studios[0]!.id}, ${ownerUserId}, ${`P ${pslug}`}, ${pslug}, 'private')
    RETURNING id
  `;
  return projects[0]!.id;
}

/** Create a real overwrite task; returns its id (FK target for node_history). */
async function createTask(userId: string, projectId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, project_id, space_id, task_type, mode)
    VALUES (${userId}, ${projectId}, ${crypto.randomUUID()}, 'image', 'overwrite')
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Count node_history rows for a (task, node) pair. */
async function countRows(taskId: string, nodeId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM node_history
    WHERE task_id = ${taskId} AND node_id = ${nodeId}
  `;
  return rows[0]!.n;
}

describe("node_history generation idempotency (#1618 Y)", () => {
  it("two recordGenerationSuccess with the same (taskId, nodeId) leave ONE row", async () => {
    const userId = await insertUser("Gen Author");
    const projectId = await insertProject(userId);
    const taskId = await createTask(userId, projectId);
    const nodeId = crypto.randomUUID();

    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/result.png",
      thumbnailUrl: "https://cdn.example.com/result.png",
      taskId,
      metadata: { model: "test-model", cost: 3, durationMs: 1200, params: {} },
    };

    // Two records for the same generation (double-live or billed-redelivery
    // re-record). The idempotent path collapses them to a single row.
    await nodeHistoryService.recordGenerationSuccess(opts);
    await nodeHistoryService.recordGenerationSuccess(opts);

    expect(await countRows(taskId, nodeId)).toBe(1);
  });

  it("concurrent records for the same (taskId, nodeId) still leave ONE row (double-live)", async () => {
    const userId = await insertUser("Race Author");
    const projectId = await insertProject(userId);
    const taskId = await createTask(userId, projectId);
    const nodeId = crypto.randomUUID();

    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/race.png",
      taskId,
      metadata: { model: "test-model", cost: 3, durationMs: 900, params: {} },
    };

    // Two executions of the SAME job hit the record path concurrently.
    await Promise.all([
      nodeHistoryService.recordGenerationSuccess(opts),
      nodeHistoryService.recordGenerationSuccess(opts),
    ]);

    expect(await countRows(taskId, nodeId)).toBe(1);
  });

  it("the same task targeting DIFFERENT nodes keeps one row PER node", async () => {
    const userId = await insertUser("Multi Node");
    const projectId = await insertProject(userId);
    const taskId = await createTask(userId, projectId);
    const nodeA = crypto.randomUUID();
    const nodeB = crypto.randomUUID();

    const base = {
      projectId,
      userId,
      content: "https://cdn.example.com/x.png",
      taskId,
      metadata: { model: "test-model", params: {} },
    };
    await nodeHistoryService.recordGenerationSuccess({ ...base, nodeId: nodeA });
    await nodeHistoryService.recordGenerationSuccess({ ...base, nodeId: nodeB });

    expect(await countRows(taskId, nodeA)).toBe(1);
    expect(await countRows(taskId, nodeB)).toBe(1);
  });

  it("listByNode returns the single recorded generation after a re-record", async () => {
    const userId = await insertUser("Recovery");
    const projectId = await insertProject(userId);
    const taskId = await createTask(userId, projectId);
    const nodeId = crypto.randomUUID();

    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/found.png",
      taskId,
      metadata: { model: "test-model", params: {} },
    };
    await nodeHistoryService.recordGenerationSuccess(opts);
    await nodeHistoryService.recordGenerationSuccess(opts);

    const page = await nodeHistoryService.listByNode(projectId, nodeId, {
      status: "success",
    });
    expect(page.total).toBe(1);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.content).toBe("https://cdn.example.com/found.png");
    expect(page.entries[0]!.taskId).toBe(taskId);
  });

  it("listByNode joins the operator's personal-studio display name (#1619)", async () => {
    // insertUser names the personal studio after the arg; the display name the
    // browse UI shows comes from that studio (pointer model), NOT the users
    // table — the same join the activity feed uses.
    const userId = await insertUser("Justin");
    const projectId = await insertProject(userId);
    const taskId = await createTask(userId, projectId);
    const nodeId = crypto.randomUUID();

    await nodeHistoryService.recordGenerationSuccess({
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/j.png",
      taskId,
      metadata: { model: "test-model", params: {} },
    });

    const page = await nodeHistoryService.listByNode(projectId, nodeId);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.operatorName).toBe("Justin");
    expect(page.entries[0]!.userId).toBe(userId);
  });
});

/** Count node_history upload rows for a node. */
async function countUploads(nodeId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM node_history
    WHERE node_id = ${nodeId} AND entry_type = 'upload'
  `;
  return rows[0]!.n;
}

describe("node_history upload idempotency (#173)", () => {
  // The cover job lives inside a BullMQ job that gets replayed whole (design
  // §6.4.1), and its last act is writing this row. Without a key, every replay
  // leaves the user another copy of the same upload in their node history.
  // One upload is one storage key — `upload_grants_storage_key_unique` already
  // says so — which makes the key the natural idempotency key here too.
  it("two recordUpload calls with the same storageKey leave ONE row", async () => {
    const userId = await insertUser("Upload Author");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/clip.mp4",
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
      metadata: { filename: "clip.mp4", size: 4096, mimeType: "video/mp4" },
    };

    await nodeHistoryService.recordUpload(opts);
    await nodeHistoryService.recordUpload(opts);

    expect(await countUploads(nodeId)).toBe(1);
  });

  it("concurrent recordUpload calls with the same storageKey still leave ONE row", async () => {
    const userId = await insertUser("Upload Race");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/race.mp4",
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
    };

    await Promise.all([
      nodeHistoryService.recordUpload(opts),
      nodeHistoryService.recordUpload(opts),
    ]);

    expect(await countUploads(nodeId)).toBe(1);
  });

  it("the second call returns the row the first one wrote", async () => {
    const userId = await insertUser("Upload Same Row");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/same.mp4",
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
    };

    const first = await nodeHistoryService.recordUpload(opts);
    const second = await nodeHistoryService.recordUpload(opts);

    expect(second.id).toBe(first.id);
  });

  // The replay writes the thumbnail the second time round when the first
  // attempt died before the cover was extracted, so the conflict must not
  // silently keep a row that says the video has no cover.
  it("a replay carrying a thumbnail fills one in that the first call left empty", async () => {
    const userId = await insertUser("Upload Late Cover");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const storageKey = `uploads/${crypto.randomUUID()}.mp4`;
    const base = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/late.mp4",
      storageKey,
    };

    await nodeHistoryService.recordUpload(base);
    await nodeHistoryService.recordUpload({
      ...base,
      thumbnailUrl: "https://cdn.example.com/late_cover.png",
    });

    expect(await countUploads(nodeId)).toBe(1);
    const page = await nodeHistoryService.listByNode(projectId, nodeId);
    expect(page.entries[0]!.thumbnailUrl).toBe(
      "https://cdn.example.com/late_cover.png",
    );
  });

  // The first-pass dedup hit records an upload without ever issuing a grant,
  // so it has no storage key. Two such uploads are two separate user actions
  // and each deserves its own history row.
  it("uploads with no storageKey are never collapsed together", async () => {
    const userId = await insertUser("Upload Keyless");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/existing.png",
    };

    await nodeHistoryService.recordUpload(opts);
    await nodeHistoryService.recordUpload(opts);

    expect(await countUploads(nodeId)).toBe(2);
  });

  it("different storage keys keep one row each", async () => {
    const userId = await insertUser("Upload Distinct");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const base = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/a.png",
    };

    await nodeHistoryService.recordUpload({
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });
    await nodeHistoryService.recordUpload({
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });

    expect(await countUploads(nodeId)).toBe(2);
  });
});
