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
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import { nodeHistoryService, nodeTaskService } from "@breatic/domain";

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

/** The numbers an upload lands with, for tests about something else. */
const UPLOAD_MEDIA = { width: 1, height: 1, duration: null, mimeType: "image/png", size: 1 };
// What a text result lands with: it has none of the five numbers.
const NO_MEDIA = { width: null, height: null, duration: null, mimeType: null, size: null };

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
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studios[0]!.id}, ${ownerUserId}, ${`P ${pslug}`}, ${pslug})
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
    await nodeHistoryService.recordGenerationSuccess({ ...opts, media: NO_MEDIA });
    await nodeHistoryService.recordGenerationSuccess({ ...opts, media: NO_MEDIA });

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
      nodeHistoryService.recordGenerationSuccess({ ...opts, media: NO_MEDIA }),
      nodeHistoryService.recordGenerationSuccess({ ...opts, media: NO_MEDIA }),
    ]);

    expect(await countRows(taskId, nodeId)).toBe(1);
  });

  it("a second live run of the same job with a different result resolves to the first row", async () => {
    const userId = await insertUser("Two Runs Author");
    const projectId = await insertProject(userId);
    const taskId = await createTask(userId, projectId);
    const nodeId = crypto.randomUUID();
    const base = { projectId, nodeId, userId, taskId, metadata: { model: "m" } };

    // Each live run persists its own output, so the two results differ and
    // only (task_id, node_id) ties them together.
    const first = await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA,
      ...base,
      content: "https://cdn.example.com/run-1.png",
    });
    const second = await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA,
      ...base,
      content: "https://cdn.example.com/run-2.png",
    });

    expect(second.id).toBe(first.id);
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
    await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA, ...base, nodeId: nodeA });
    await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA, ...base, nodeId: nodeB });

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
    await nodeHistoryService.recordGenerationSuccess({ ...opts, media: NO_MEDIA });
    await nodeHistoryService.recordGenerationSuccess({ ...opts, media: NO_MEDIA });

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

    await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA,
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
  // Applying an ingest report ends with writing this row, and the same report
  // can arrive twice: a client can call the finish endpoint again, and a
  // generation that files its own output is inside a BullMQ job that gets
  // replayed whole. Without a key, every arrival leaves the user another copy
  // of the same upload in their node history.
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

    await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });
    await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });

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
      nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA }),
      nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA }),
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

    const first = await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });
    const second = await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });

    expect(second.entry.id).toBe(first.entry.id);
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

    await nodeHistoryService.recordUpload({ ...base, media: UPLOAD_MEDIA });
    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
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
  // so it has no storage key. A node's history holds each content once
  // (#2186), so a second keyless upload of the same content adds nothing.
  it("keyless uploads of the same content collapse into one row", async () => {
    const userId = await insertUser("Upload Keyless");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/existing.png",
    };

    await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });
    await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });

    expect(await countUploads(nodeId)).toBe(1);
  });

  it("different storage keys holding different content keep one row each", async () => {
    const userId = await insertUser("Upload Distinct");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const base = { projectId, nodeId, userId };

    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      content: "https://cdn.example.com/a.png",
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });
    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      content: "https://cdn.example.com/b.png",
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });

    expect(await countUploads(nodeId)).toBe(2);
  });
});

describe("knowing whether the upload row was newly written (#173)", () => {
  // Applying an ingest report writes two downstreams: this row and the project
  // activity feed. Only this one has a key of its own, so the feed learns
  // from it whether a repeated report is writing something new — one flag
  // instead of a second idempotency column on a second table.
  it("reports the first write as inserted and the replay as not", async () => {
    const userId = await insertUser("Insert Flag");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/flag.mp4",
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
    };

    expect((await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA })).inserted).toBe(true);
    expect((await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA })).inserted).toBe(false);
  });

  // The feed follows the history (#2186): content already in this node's
  // history is not a new upload, keyless or not.
  it("reports a keyless upload of content already in the history as not inserted", async () => {
    const userId = await insertUser("Keyless Flag");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/keyless.png",
    };

    expect((await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA })).inserted).toBe(true);
    expect((await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA })).inserted).toBe(false);
  });

  it("reports an upload under a new key of content already in the history as not inserted", async () => {
    const userId = await insertUser("New Key Same Content");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const base = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/same-bytes.png",
    };

    const first = await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });
    const second = await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });
});

/** The live success rows a node's history holds, oldest first. */
async function liveSuccessRows(
  nodeId: string,
): Promise<{ id: string; created_at: Date; content: string; thumbnail_url: string | null }[]> {
  return sql<{ id: string; created_at: Date; content: string; thumbnail_url: string | null }[]>`
    SELECT id, created_at, content, thumbnail_url FROM node_history
    WHERE node_id = ${nodeId} AND status = 'success' AND deleted_at IS NULL
    ORDER BY created_at, id
  `;
}

describe("one history row per content per node (#2186)", () => {
  // A1 + A2 for each way content reaches a node. The first arrival writes the
  // row; any later arrival of the same content writes nothing and is answered
  // with the row that already stands, its id and time untouched.

  it("a generation whose result is already in the history adds no row", async () => {
    const userId = await insertUser("Same Result");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const content = "https://cdn.example.com/same-result.png";
    const base = { projectId, nodeId, userId, content, metadata: { model: "m" } };

    const first = await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA,
      ...base,
      taskId: await createTask(userId, projectId),
    });
    const second = await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA,
      ...base,
      taskId: await createTask(userId, projectId),
    });

    const rows = await liveSuccessRows(nodeId);
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.created_at.getTime()).toBe(first.createdAt.getTime());
  });

  it("an upload under a new key of content already in the history adds no row", async () => {
    const userId = await insertUser("Same Upload");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const base = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/same-upload.png",
    };

    const first = await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });
    const second = await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.png`,
    });

    const rows = await liveSuccessRows(nodeId);
    expect(rows).toHaveLength(1);
    expect(second.entry.id).toBe(first.entry.id);
    expect(rows[0]!.created_at.getTime()).toBe(first.entry.createdAt.getTime());
  });

  it("a keyless upload (the dedup hit) of content already in the history adds no row", async () => {
    const userId = await insertUser("Same Dedup Hit");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/same-dedup.png",
    };

    const first = await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });
    const second = await nodeHistoryService.recordUpload({ ...opts, media: UPLOAD_MEDIA });

    const rows = await liveSuccessRows(nodeId);
    expect(rows).toHaveLength(1);
    expect(second.entry.id).toBe(first.entry.id);
    expect(rows[0]!.created_at.getTime()).toBe(first.entry.createdAt.getTime());
  });

  it("a snapshot of words already in the history adds no row", async () => {
    const userId = await insertUser("Same Snapshot");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const opts = { projectId, nodeId, userId, content: "A red bicycle." };

    const first = await nodeHistoryService.recordSnapshot(opts);
    const second = await nodeHistoryService.recordSnapshot(opts);

    const rows = await liveSuccessRows(nodeId);
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(rows[0]!.created_at.getTime()).toBe(first.createdAt.getTime());
  });

  // The rule is per content, across sources: a generation landing what an
  // upload already put there is the same content.
  it("content that arrived by one source is not added again by another", async () => {
    const userId = await insertUser("Cross Source");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const content = "https://cdn.example.com/cross.png";

    const upload = await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      projectId,
      nodeId,
      userId,
      content,
    });
    const generated = await nodeHistoryService.recordGenerationSuccess({ media: NO_MEDIA,
      projectId,
      nodeId,
      userId,
      content,
      taskId: await createTask(userId, projectId),
      metadata: {},
    });

    expect(await liveSuccessRows(nodeId)).toHaveLength(1);
    expect(generated.id).toBe(upload.entry.id);
  });

  it("the same content on two different nodes keeps one row on each", async () => {
    const userId = await insertUser("Two Nodes");
    const projectId = await insertProject(userId);
    const nodeA = crypto.randomUUID();
    const nodeB = crypto.randomUUID();
    const content = "https://cdn.example.com/shared.png";

    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA, projectId, nodeId: nodeA, userId, content });
    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA, projectId, nodeId: nodeB, userId, content });

    expect(await liveSuccessRows(nodeA)).toHaveLength(1);
    expect(await liveSuccessRows(nodeB)).toHaveLength(1);
  });

  // The conflict on content fills an empty thumbnail the same way the replay
  // on the storage key does, and never clears one.
  it("a later upload of the same content fills a thumbnail the existing row lacks", async () => {
    const userId = await insertUser("Late Cover Same Content");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const base = {
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/cover-later.mp4",
    };

    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
    });
    await nodeHistoryService.recordUpload({ media: UPLOAD_MEDIA,
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
      thumbnailUrl: "https://cdn.example.com/cover-later_cover.png",
    });

    const rows = await liveSuccessRows(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.thumbnail_url).toBe("https://cdn.example.com/cover-later_cover.png");
  });

  // A6: a failed generation carries no content, so the rule does not touch it.
  it("two failed generations on one node both stay", async () => {
    const userId = await insertUser("Two Failures");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();

    for (let i = 0; i < 2; i++) {
      await nodeHistoryService.recordGenerationFailure({
        projectId,
        nodeId,
        userId,
        errorMessage: "upstream refused",
        taskId: await createTask(userId, projectId),
      });
    }

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM node_history
      WHERE node_id = ${nodeId} AND status = 'failed' AND deleted_at IS NULL
    `;
    expect(rows[0]!.n).toBe(2);
  });

  // A8: the rule lives in the database, so a write that goes around every
  // repo entry point is refused too.
  it("the database refuses a second live success row with the same content", async () => {
    const userId = await insertUser("Direct Insert");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const content = "https://cdn.example.com/direct.png";
    const insert = (): Promise<unknown> => sql`
      INSERT INTO node_history (project_id, node_id, user_id, entry_type, status, content)
      VALUES (${projectId}, ${nodeId}, ${userId}, 'upload', 'success', ${content})
    `;

    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });

  // The constraint covers live rows only: a soft-deleted row does not hold
  // its content against a new one.
  it("a soft-deleted row does not block the same content again", async () => {
    const userId = await insertUser("Soft Deleted");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const content = "https://cdn.example.com/again.png";

    const first = await nodeHistoryService.recordSnapshot({
      projectId,
      nodeId,
      userId,
      content,
    });
    await sql`UPDATE node_history SET deleted_at = now() WHERE id = ${first.id}`;
    const second = await nodeHistoryService.recordSnapshot({
      projectId,
      nodeId,
      userId,
      content,
    });

    expect(second.id).not.toBe(first.id);
    expect(await liveSuccessRows(nodeId)).toHaveLength(1);
  });
});

describe("migration 0087 on a history that already holds duplicates (#2186 A7)", () => {
  const MIGRATION = new URL(
    "../../../../core/src/db/migrations/0087_node_history_unique_content.sql",
    import.meta.url,
  );
  const ROLLBACK = new Error("rollback");

  it("keeps the earliest row of each content per node, and the index builds", async () => {
    const userId = await insertUser("Migration Dedup");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const otherNode = crypto.randomUUID();
    const [dedup, index] = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint");

    // Everything runs in one transaction that is rolled back: the index is
    // dropped only for its duration, so no other suite sees it missing.
    await sql
      .begin(async (tx) => {
        await tx`DROP INDEX node_history_success_content_unique`;
        const insert = async (node: string, content: string, at: string): Promise<string> => {
          const rows = await tx<{ id: string }[]>`
            INSERT INTO node_history
              (project_id, node_id, user_id, entry_type, status, content, created_at)
            VALUES (${projectId}, ${node}, ${userId}, 'snapshot', 'success', ${content}, ${at})
            RETURNING id
          `;
          return rows[0]!.id;
        };
        const kept = await insert(nodeId, "same words", "2026-09-01T00:00:00Z");
        await insert(nodeId, "same words", "2026-09-02T00:00:00Z");
        await insert(nodeId, "same words", "2026-09-03T00:00:00Z");
        const other = await insert(nodeId, "other words", "2026-09-02T12:00:00Z");
        const elsewhere = await insert(otherNode, "same words", "2026-09-04T00:00:00Z");

        await tx.unsafe(dedup!);
        await tx.unsafe(index!);

        const live = await tx<{ id: string }[]>`
          SELECT id FROM node_history
          WHERE node_id IN (${nodeId}, ${otherNode}) AND deleted_at IS NULL
          ORDER BY created_at
        `;
        expect(live.map((r) => r.id)).toEqual([kept, other, elsewhere]);
        const built = await tx`
          SELECT 1 FROM pg_indexes WHERE indexname = 'node_history_success_content_unique'
        `;
        expect(built).toHaveLength(1);
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
  });

  it("a task row whose history row was soft-deleted still lists its content", async () => {
    const userId = await insertUser("Soft Deleted Pointer");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const entry = await nodeHistoryService.recordSnapshot({
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/kept-by-task.png",
    });
    await sql`
      INSERT INTO node_tasks
        (project_id, space_id, node_id, kind, status,
         started_by_user_id, started_at, budget_ms, label, node_history_id)
      VALUES
        (${projectId}, ${crypto.randomUUID()}, ${nodeId}, 'upload', 'done',
         ${userId}, now(), 600000, 'pointer.png', ${entry.id})
    `;
    await sql`UPDATE node_history SET deleted_at = now() WHERE id = ${entry.id}`;

    const [row] = await nodeTaskService.listLive({ projectId, nodeId });

    expect(row?.nodeHistoryId).toBe(entry.id);
    expect(row?.content).toBe("https://cdn.example.com/kept-by-task.png");
  });
});

describe("history rows carry the media a result landed with (#2184)", () => {
  // What the node was given when this content first landed on it, so restoring
  // the row can give it back the same seven fields.
  const media = { width: 1920, height: 1080, duration: 5.04, mimeType: "video/mp4", size: 734_003 };
  const onEntry = {
    mediaWidth: 1920,
    mediaHeight: 1080,
    duration: 5.04,
    mimeType: "video/mp4",
    size: 734_003,
  };

  it("a generation row reads back the media it was written with", async () => {
    const userId = await insertUser("Media Gen");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();

    await nodeHistoryService.recordGenerationSuccess({
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/media-gen.mp4",
      thumbnailUrl: "https://cdn.example.com/media-gen.jpg",
      taskId: await createTask(userId, projectId),
      metadata: { model: "m" },
      media,
    });

    const { entries } = await nodeHistoryService.listByNode(projectId, nodeId, {});
    expect(entries[0]).toMatchObject(onEntry);
  });

  it("an upload row reads back the media it was written with", async () => {
    const userId = await insertUser("Media Upload");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();

    await nodeHistoryService.recordUpload({
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/media-upload.mp4",
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
      media,
    });

    const { entries } = await nodeHistoryService.listByNode(projectId, nodeId, {});
    expect(entries[0]).toMatchObject(onEntry);
  });

  it("a medium with no such numbers reads back null for each", async () => {
    const userId = await insertUser("Media Empty");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();

    await nodeHistoryService.recordUpload({
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/media-image.png",
      storageKey: `uploads/${crypto.randomUUID()}.png`,
      media: { width: 640, height: 480, duration: null, mimeType: "image/png", size: 1024 },
    });

    const { entries } = await nodeHistoryService.listByNode(projectId, nodeId, {});
    expect(entries[0]).toMatchObject({
      mediaWidth: 640,
      mediaHeight: 480,
      duration: null,
      mimeType: "image/png",
      size: 1024,
    });
  });

  it("a row written before the media columns reads back null for all five", async () => {
    const userId = await insertUser("Media Old");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();

    await nodeHistoryService.recordSnapshot({
      projectId,
      nodeId,
      userId,
      content: "a snapshot has no media",
    });

    const { entries } = await nodeHistoryService.listByNode(projectId, nodeId, {});
    expect(entries[0]).toMatchObject({
      mediaWidth: null,
      mediaHeight: null,
      duration: null,
      mimeType: null,
      size: null,
    });
  });

  it("the same content arriving again keeps the media the first arrival wrote", async () => {
    const userId = await insertUser("Media Same");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const base = { projectId, nodeId, userId, content: "https://cdn.example.com/media-same.mp4" };

    await nodeHistoryService.recordUpload({
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
      media,
    });
    await nodeHistoryService.recordUpload({
      ...base,
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
      media: { width: 1, height: 1, duration: 1, mimeType: "video/webm", size: 1 },
    });

    const { entries } = await nodeHistoryService.listByNode(projectId, nodeId, {});
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject(onEntry);
  });

  it("the task list hands back the media of the row its task points at", async () => {
    const userId = await insertUser("Media Task List");
    const projectId = await insertProject(userId);
    const nodeId = crypto.randomUUID();
    const recorded = await nodeHistoryService.recordUpload({
      projectId,
      nodeId,
      userId,
      content: "https://cdn.example.com/media-task.mp4",
      storageKey: `uploads/${crypto.randomUUID()}.mp4`,
      media,
    });
    await sql`
      INSERT INTO node_tasks
        (project_id, space_id, node_id, kind, status,
         started_by_user_id, started_at, budget_ms, label, node_history_id)
      VALUES
        (${projectId}, ${crypto.randomUUID()}, ${nodeId}, 'upload', 'done',
         ${userId}, now(), 600000, 'media-task.mp4', ${recorded.entry.id})
    `;

    const [row] = await nodeTaskService.listLive({ projectId, nodeId });

    expect(row).toMatchObject(onEntry);
  });
});
