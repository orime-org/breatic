// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D Space task list (inner#1690): a model upload opens a Space-level
 * `node_tasks` row with no node, every member reads the same list, and the
 * row moves only through the same conditional writes the Canvas rows use.
 *
 * Driven through the real app and database; only the ingest Worker's open
 * and finish calls are doubles.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

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

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  getStreamRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  createQueue,
  env,
  type Redis,
} from "@breatic/core";
import { uploadFinishService, UPLOAD_FINISH_QUEUE, type UploadFinishJob } from "@breatic/domain";
import { resetOpenDouble } from "../helpers/ingest-open-double.js";
import { workerAnswers } from "@server/__tests__/integration/transfer-grant-fixtures.js";
import { closeFinishQueue, runQueuedFinish } from "@server/__tests__/helpers/queued-finish.js";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let subscriber: Redis;
const signals: { channel: string; message: Record<string, unknown> }[] = [];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "scene-task-list-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    signals.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
});

beforeEach(() => {
  resetOpenDouble();
  vi.clearAllMocks();
  signals.length = 0;
});

afterAll(async () => {
  await subscriber?.quit();
  await closeFinishQueue();
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * A session cookie for a user.
 * @param userId - Who signs in.
 * @returns The cookie header value.
 */
async function sessionFor(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * A user with their personal studio.
 * @returns The user and studio ids.
 */
async function seedUser(): Promise<{ userId: string; studioId: string }> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`stl-${seq++}-${crypto.randomUUID()}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`stl-s-${crypto.randomBytes(8).toString("hex")}`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studios[0]!.id}, ${userId}, 'admin')`;
  return { userId, studioId: studios[0]!.id };
}

/**
 * An owner with a project and a 3D Space id, plus a second editor and a viewer.
 * @returns Everyone's ids and cookies, the project and the Space.
 */
async function seedProject(): Promise<{
  owner: { userId: string; cookie: string };
  editor: { userId: string; cookie: string };
  viewer: { userId: string; cookie: string };
  studioId: string;
  projectId: string;
  spaceId: string;
}> {
  const owner = await seedUser();
  const slug = `stl-p-${crypto.randomBytes(8).toString("hex")}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${owner.studioId}, ${owner.userId}, ${slug}, ${slug}) RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${owner.userId}, 'owner', null)`;
  const editor = await seedUser();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${editor.userId}, 'editor', ${owner.userId})`;
  const viewer = await seedUser();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${viewer.userId}, 'viewer', ${owner.userId})`;
  return {
    owner: { userId: owner.userId, cookie: await sessionFor(owner.userId) },
    editor: { userId: editor.userId, cookie: await sessionFor(editor.userId) },
    viewer: { userId: viewer.userId, cookie: await sessionFor(viewer.userId) },
    studioId: owner.studioId,
    projectId,
    spaceId: crypto.randomUUID(),
  };
}

/**
 * A scene model ticket request.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function sceneBody(projectId: string, spaceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: projectId,
    purpose: "scene_model",
    space_id: spaceId,
    label: "Barn lamp",
    filename: "lamp.glb",
    content_type: "model/gltf-binary",
    size: 4096,
    client_hash: crypto.randomBytes(32).toString("hex"),
    ...overrides,
  };
}

/**
 * Send a JSON request.
 * @param method - HTTP method.
 * @param path - Path under /api/v1.
 * @param cookie - Session cookie.
 * @param payload - JSON body, when any.
 * @returns The response.
 */
async function call(method: string, path: string, cookie: string, payload?: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
}

/**
 * Ask for a scene model ticket and return its data.
 * @param cookie - Who asks.
 * @param payload - The body.
 * @returns The answer's data.
 */
async function ticket(cookie: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await call("POST", "/assets/upload-ticket", cookie, payload);
  // An opened upload answers 201, a dedup hit 200.
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/**
 * Complete an opened upload the way the browser does after its last part.
 * @param cookie - Who uploaded.
 * @param data - The ticket answer.
 */
async function complete(cookie: string, data: Record<string, unknown>): Promise<void> {
  const res = await app.request(`/api/v1/assets/uploads/${String(data.uploadId)}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-upload-token": String(data.token) },
    body: JSON.stringify({ parts: [{ partNumber: 1, etag: "e1" }] }),
  });
  expect(res.status).toBe(202);
}

interface TaskRow {
  id: string;
  node_id: string | null;
  space_id: string;
  action: string;
  status: string;
  label: string;
  asset_id: string | null;
  deleted_at: Date | null;
  started_by_user_id: string;
}

/**
 * The row a storage key opened.
 * @param storageKey - The grant's key.
 * @returns Its rows.
 */
async function rowsFor(storageKey: string): Promise<TaskRow[]> {
  return sql<TaskRow[]>`SELECT * FROM node_tasks WHERE storage_key = ${storageKey}`;
}

/**
 * One row by id.
 * @param id - The row id.
 * @returns The row.
 */
async function rowById(id: string): Promise<TaskRow> {
  const rows = await sql<TaskRow[]>`SELECT * FROM node_tasks WHERE id = ${id}`;
  return rows[0]!;
}

/**
 * The project's `asset:uploaded` activity rows.
 * @param projectId - The project.
 * @returns Their payloads.
 */
async function uploadActivities(projectId: string): Promise<Record<string, unknown>[]> {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM project_activities WHERE project_id = ${projectId} AND type = 'asset:uploaded'
  `;
  return rows.map((row) => row.payload);
}

/**
 * Wait until the signal subscriber has seen a message for the Space.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns The messages for it.
 */
async function signalsFor(projectId: string, spaceId: string): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const mine = signals.filter((s) => s.message.projectId === projectId && s.message.spaceId === spaceId).map((s) => s.message);
    if (mine.length > 0 || Date.now() > deadline) return mine;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Run one queued finish twice with the same job, the way a retried finish does.
 * @param storageKey - The upload.
 */
async function finishTwice(storageKey: string): Promise<void> {
  const queue = createQueue(UPLOAD_FINISH_QUEUE);
  try {
    const job = await queue.getJob(storageKey);
    if (job === undefined) throw new Error(`no finish queued for ${storageKey}`);
    const data = job.data as UploadFinishJob;
    await uploadFinishService.finishUpload(data);
    await uploadFinishService.finishUpload(data);
    await job.remove();
  } finally {
    await queue.close();
  }
}

/**
 * Open a scene upload and push its row past its deadline.
 * @param cookie - Who uploads.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns The ticket answer and the row id.
 */
async function openOverdue(cookie: string, projectId: string, spaceId: string): Promise<{ data: Record<string, unknown>; taskId: string }> {
  const data = await ticket(cookie, sceneBody(projectId, spaceId));
  const taskId = String(data.taskId);
  await sql`UPDATE node_tasks SET started_at = now() - (budget_ms + 60000) * interval '1 millisecond' WHERE id = ${taskId}`;
  return { data, taskId };
}

/**
 * Leave a running row the way the harvest leaves an overdue one, without
 * moving the upload's own deadline: a finish already under way when the row
 * is judged dead still completes, which is when a result arrives late.
 * @param taskId - The row.
 */
async function markExpired(taskId: string): Promise<void> {
  await sql`UPDATE node_tasks SET status = 'expired', error_message = 'expired', settled_at = now() WHERE id = ${taskId} AND status = 'running'`;
}

describe("scene model tickets open a Space-level row", () => {
  it("opens one running scene_import row with no node, labelled by the ticket, and signals the Space", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));

    const rows = await rowsFor(String(data.storageKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: data.taskId,
      node_id: null,
      space_id: spaceId,
      action: "scene_import",
      status: "running",
      label: "Barn lamp",
      asset_id: null,
      started_by_user_id: owner.userId,
    });
    expect(await signalsFor(projectId, spaceId)).toEqual([
      expect.objectContaining({ type: "project-space-tasks:changed", projectId, spaceId }),
    ]);
  });

  it.each([
    ["no space_id", { space_id: undefined }],
    ["no label", { label: undefined }],
    ["a blank label", { label: "   " }],
    ["a node", { node_id: crypto.randomUUID() }],
  ])("refuses a scene model ticket with %s", async (_name, overrides) => {
    const { owner, projectId, spaceId } = await seedProject();
    const res = await call("POST", "/assets/upload-ticket", owner.cookie, sceneBody(projectId, spaceId, overrides));
    expect(res.status).toBe(422);
  });

  it("answers a dedup hit with a done row that holds the asset, and writes no activity", async () => {
    const { owner, studioId, projectId, spaceId } = await seedProject();
    const hash = crypto.randomBytes(32).toString("hex");
    const assets = await sql<{ id: string }[]>`
      INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
      VALUES (${studioId}, ${hash}, ${`file/${hash}.glb`}, ${`https://cdn.test.invalid/${hash}.glb`}, 4096, 'model/gltf-binary', 'file', 'upload', ${owner.userId})
      RETURNING id
    `;
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId, { client_hash: hash }));

    expect(data.alreadyExists).toBe(true);
    const row = await rowById(String(data.taskId));
    expect(row).toMatchObject({ node_id: null, space_id: spaceId, action: "scene_import", status: "done", asset_id: assets[0]!.id, label: "Barn lamp" });
    expect(await uploadActivities(projectId)).toEqual([]);
    expect(await signalsFor(projectId, spaceId)).toHaveLength(1);
  });
});

describe("settling a scene upload", () => {
  it("lands done with the asset, writes one activity naming the model, and a repeated finish writes no second one", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    await complete(owner.cookie, data);
    signals.length = 0;

    workerAnswers({ contentType: "model/gltf-binary", sizeBytes: 4096 });
    try {
      await finishTwice(String(data.storageKey));
    } finally {
      vi.unstubAllGlobals();
    }

    const row = await rowById(String(data.taskId));
    expect(row.status).toBe("done");
    const assets = await sql<{ id: string; file_url: string }[]>`SELECT id, file_url FROM studio_assets WHERE id = ${row.asset_id}`;
    expect(assets).toHaveLength(1);
    expect(await uploadActivities(projectId)).toEqual([
      { fileUrl: assets[0]!.file_url, kind: "file", model: { name: "Barn lamp" } },
    ]);
    expect((await signalsFor(projectId, spaceId)).length).toBeGreaterThanOrEqual(1);
  });

  it("attaches a result that arrives after the row expired, and writes its activity once", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    const taskId = String(data.taskId);
    await complete(owner.cookie, data);
    await markExpired(taskId);

    workerAnswers({ contentType: "model/gltf-binary", sizeBytes: 4096 });
    try {
      await finishTwice(String(data.storageKey));
    } finally {
      vi.unstubAllGlobals();
    }

    const row = await rowById(taskId);
    expect(row.status).toBe("expired");
    expect(row.asset_id).not.toBeNull();
    expect(await uploadActivities(projectId)).toHaveLength(1);
  });

  it("leaves a failed row without the late result", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    const taskId = String(data.taskId);
    const failed = await call("POST", `/projects/${projectId}/three-d/${spaceId}/tasks/${taskId}/failure`, owner.cookie, { reason: "aborted" });
    expect(failed.status).toBe(200);
    expect((await rowById(taskId)).status).toBe("failed");
    await complete(owner.cookie, data);

    workerAnswers({ contentType: "model/gltf-binary", sizeBytes: 4096 });
    try {
      await runQueuedFinish(String(data.storageKey));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(await rowById(taskId)).toMatchObject({ status: "failed", asset_id: null });
    expect(await uploadActivities(projectId)).toEqual([]);
  });

  it("leaves a removed expired row without the late result", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    const taskId = String(data.taskId);
    await complete(owner.cookie, data);
    await markExpired(taskId);
    const removed = await call("DELETE", `/projects/${projectId}/three-d/${spaceId}/tasks/${taskId}`, owner.cookie);
    expect(removed.status).toBe(200);

    workerAnswers({ contentType: "model/gltf-binary", sizeBytes: 4096 });
    try {
      await runQueuedFinish(String(data.storageKey));
    } finally {
      vi.unstubAllGlobals();
    }

    const row = await rowById(taskId);
    expect(row.asset_id).toBeNull();
    expect(row.deleted_at).not.toBeNull();
    // The finish did register the model: only the removed row declined it.
    const registered = await sql`SELECT 1 FROM upload_grants WHERE storage_key = ${String(data.storageKey)} AND asset_id IS NOT NULL`;
    expect(registered).toHaveLength(1);
  });
});

describe("reading the Space's task list", () => {
  it("gives every member the same rows, newest first, with deadlines and the server's clock", async () => {
    const { owner, editor, viewer, projectId, spaceId } = await seedProject();
    const first = await ticket(owner.cookie, sceneBody(projectId, spaceId, { label: "First" }));
    const second = await ticket(editor.cookie, sceneBody(projectId, spaceId, { label: "Second" }));
    await ticket(owner.cookie, sceneBody(projectId, crypto.randomUUID(), { label: "Other Space" }));

    const before = Date.now();
    const res = await call("GET", `/projects/${projectId}/three-d/${spaceId}/tasks`, viewer.cookie);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        serverNow: string;
        tasks: { id: string; label: string; status: string; startedByUserId: string; startedAt: string; deadlineAt: string; assetId: string | null; errorMessage: string | null }[];
      };
    };

    expect(data.tasks.map((task) => task.id)).toEqual([second.taskId, first.taskId]);
    expect(data.tasks[0]).toMatchObject({ label: "Second", status: "running", startedByUserId: editor.userId, assetId: null, errorMessage: null });
    for (const task of data.tasks) {
      expect(Date.parse(task.deadlineAt) - Date.parse(task.startedAt)).toBe(2 * 60 * 60 * 1000);
    }
    expect(Math.abs(Date.parse(data.serverNow) - before)).toBeLessThan(60_000);
  });

  it("refuses someone outside the project", async () => {
    const { projectId, spaceId } = await seedProject();
    const stranger = await seedUser();
    const res = await call("GET", `/projects/${projectId}/three-d/${spaceId}/tasks`, await sessionFor(stranger.userId));
    expect([403, 404]).toContain(res.status);
  });

  it("expires rows that outran their budget on read, and signals the Space", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const { taskId } = await openOverdue(owner.cookie, projectId, spaceId);
    signals.length = 0;

    const res = await call("GET", `/projects/${projectId}/three-d/${spaceId}/tasks`, owner.cookie);
    const { data } = (await res.json()) as { data: { tasks: { id: string; status: string; errorMessage: string | null }[] } };

    expect(data.tasks.find((task) => task.id === taskId)).toMatchObject({ status: "expired", errorMessage: "expired" });
    expect(await signalsFor(projectId, spaceId)).toHaveLength(1);
  });
});

describe("removing a row", () => {
  it("removes a failed row and an expired row without a result, and signals", async () => {
    const { owner, editor, projectId, spaceId } = await seedProject();
    const failed = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    await call("POST", `/projects/${projectId}/three-d/${spaceId}/tasks/${String(failed.taskId)}/failure`, owner.cookie, { reason: "aborted" });
    const { taskId: expiredId } = await openOverdue(owner.cookie, projectId, spaceId);
    await call("GET", `/projects/${projectId}/three-d/${spaceId}/tasks`, owner.cookie);
    signals.length = 0;

    for (const id of [String(failed.taskId), expiredId]) {
      const res = await call("DELETE", `/projects/${projectId}/three-d/${spaceId}/tasks/${id}`, editor.cookie);
      expect(res.status).toBe(200);
      expect((await rowById(id)).deleted_at).not.toBeNull();
    }
    expect((await signalsFor(projectId, spaceId)).length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to remove a running row, a done row and an expired row that holds a result", async () => {
    const { owner, studioId, projectId, spaceId } = await seedProject();
    const running = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    const hash = crypto.randomBytes(32).toString("hex");
    await sql`
      INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
      VALUES (${studioId}, ${hash}, ${`file/${hash}.glb`}, ${`https://cdn.test.invalid/${hash}.glb`}, 4096, 'model/gltf-binary', 'file', 'upload', ${owner.userId})
    `;
    const done = await ticket(owner.cookie, sceneBody(projectId, spaceId, { client_hash: hash }));
    const { taskId: expiredId } = await openOverdue(owner.cookie, projectId, spaceId);
    await call("GET", `/projects/${projectId}/three-d/${spaceId}/tasks`, owner.cookie);
    await sql`UPDATE node_tasks SET asset_id = ${(await rowById(String(done.taskId))).asset_id} WHERE id = ${expiredId}`;

    for (const id of [String(running.taskId), String(done.taskId), expiredId]) {
      const res = await call("DELETE", `/projects/${projectId}/three-d/${spaceId}/tasks/${id}`, owner.cookie);
      expect(res.status).toBe(409);
      expect((await rowById(id)).deleted_at).toBeNull();
    }
  });

  it("refuses a viewer", async () => {
    const { owner, viewer, projectId, spaceId } = await seedProject();
    const failed = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    await call("POST", `/projects/${projectId}/three-d/${spaceId}/tasks/${String(failed.taskId)}/failure`, owner.cookie, { reason: "aborted" });
    const res = await call("DELETE", `/projects/${projectId}/three-d/${spaceId}/tasks/${String(failed.taskId)}`, viewer.cookie);
    expect(res.status).toBe(403);
  });

  it("answers 404 for a row of another Space or project", async () => {
    const one = await seedProject();
    const other = await seedProject();
    const failed = await ticket(one.owner.cookie, sceneBody(one.projectId, one.spaceId));
    await call("POST", `/projects/${one.projectId}/three-d/${one.spaceId}/tasks/${String(failed.taskId)}/failure`, one.owner.cookie, { reason: "aborted" });

    const wrongSpace = await call("DELETE", `/projects/${one.projectId}/three-d/${crypto.randomUUID()}/tasks/${String(failed.taskId)}`, one.owner.cookie);
    const wrongProject = await call("DELETE", `/projects/${other.projectId}/three-d/${one.spaceId}/tasks/${String(failed.taskId)}`, other.owner.cookie);
    expect(wrongSpace.status).toBe(404);
    expect(wrongProject.status).toBe(404);
  });
});

describe("the browser's failure report", () => {
  it("lets only the uploader report, and signals", async () => {
    const { owner, editor, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    const path = `/projects/${projectId}/three-d/${spaceId}/tasks/${String(data.taskId)}/failure`;
    signals.length = 0;

    expect((await call("POST", path, editor.cookie, { reason: "aborted" })).status).toBe(403);
    expect((await call("POST", path, owner.cookie, { reason: "aborted" })).status).toBe(200);
    expect(await rowById(String(data.taskId))).toMatchObject({ status: "failed" });
    expect((await signalsFor(projectId, spaceId)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("Canvas routes and Space-level rows stay apart", () => {
  it("answers 404 on the Canvas routes for a Space-level row", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const data = await ticket(owner.cookie, sceneBody(projectId, spaceId));
    const taskId = String(data.taskId);

    expect((await call("POST", `/canvas/node-tasks/${taskId}/failure`, owner.cookie, { reason: "aborted" })).status).toBe(404);
    const query = `project_id=${projectId}&space_id=${spaceId}&node_id=${crypto.randomUUID()}`;
    expect((await call("DELETE", `/canvas/node-tasks/${taskId}?${query}`, owner.cookie)).status).toBe(404);
    expect(await rowById(taskId)).toMatchObject({ status: "running", deleted_at: null });
  });

  it("still removes a done Canvas row", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    const nodeId = crypto.randomUUID();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO node_tasks (project_id, space_id, node_id, kind, action, status, started_by_user_id, budget_ms, label, settled_at)
      VALUES (${projectId}, ${spaceId}, ${nodeId}, 'upload', 'upload', 'done', ${owner.userId}, 600000, 'a.png', now())
      RETURNING id
    `;
    const res = await call("DELETE", `/canvas/node-tasks/${rows[0]!.id}?project_id=${projectId}&space_id=${spaceId}&node_id=${nodeId}`, owner.cookie);
    expect(res.status).toBe(200);
    expect((await rowById(rows[0]!.id)).deleted_at).not.toBeNull();
  });

  it("refuses a node-less row with any other action at the database", async () => {
    const { owner, projectId, spaceId } = await seedProject();
    await expect(sql`
      INSERT INTO node_tasks (project_id, space_id, node_id, kind, action, status, started_by_user_id, budget_ms, label)
      VALUES (${projectId}, ${spaceId}, null, 'upload', 'upload', 'running', ${owner.userId}, 600000, 'a.png')
    `).rejects.toThrow(/node_tasks/);
  });
});
