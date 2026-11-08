// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * 3D model generation in a 3D Space (inner#1691): a submission holds its
 * estimate, opens one Space-level `generate` row with no node and queues one
 * job; the Space's task list shows it beside imports, a timed-out row is
 * checked against the queue before it may be removed, and the worker settles
 * it through the same conditional writes the import rows use.
 *
 * Driven through the real app and database with payments on. The queue is the
 * real BullMQ queue with no worker behind it, so a queued job stays waiting;
 * the `ai` module is stubbed as in the other server integration suites.
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

// `taskService.setJobId` is wrapped in a spy that delegates to the real one,
// so one case can make recording the job id fail after the job was queued.
// A plain `vi.spyOn` cannot redefine the non-configurable ESM export.
const { setJobIdSpy } = vi.hoisted(() => ({ setJobIdSpy: vi.fn() }));
vi.mock("@breatic/domain", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  const realTasks = actual.taskService as { setJobId: (...args: unknown[]) => Promise<void> };
  setJobIdSpy.mockImplementation((...args: unknown[]) => realTasks.setJobId(...args));
  return { ...actual, taskService: { ...realTasks, setJobId: setJobIdSpy } };
});

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { Queue } from "bullmq";
import {
  initCore,
  getRedis,
  getStreamRedis,
  getStorageAdapter,
  setSession,
  sessionCookieName,
  loadLocales,
  createQueue,
  env,
  type Redis,
} from "@breatic/core";
import { ceilToCreditCent, extractPromptText, SCENE_OBJECT_NAME_MAX, SceneObjectValuesSchema } from "@breatic/shared";
import { estimateTaskCredits, resolveProjectImageInputs, sceneTaskService, taskService } from "@breatic/domain";
import { seedDesignatedLot } from "@server/__tests__/integration/studio-credit-fixtures.js";
import type { Hono } from "hono";

initCore({
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  // The catalog serves a model only when its provider has a key; nothing here
  // calls WaveSpeed, since no worker runs behind the queue.
  WAVESPEED_API_KEY: "unused_by_this_suite",
});
loadLocales();

const T23D = "tripo-h3.1-t23d";
const I23D = "tripo-h3.1-i23d";
const MULTIVIEW = "tripo-h3.1-multiview";

let sql: ReturnType<typeof postgres>;
let app: Hono;
let subscriber: Redis;
let publicUrl: (key: string) => string;
const signals: { channel: string; message: Record<string, unknown> }[] = [];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 3,
    prepare: false,
    connection: { application_name: "three-d-generation-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  const storage = await getStorageAdapter();
  publicUrl = (key) => storage.publicUrl(key);
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    signals.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
});

beforeEach(() => {
  setJobIdSpy.mockClear();
  signals.length = 0;
});

afterAll(async () => {
  await subscriber?.quit();
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

interface Member {
  userId: string;
  cookie: string;
}

interface Seeded {
  owner: Member;
  editor: Member;
  viewer: Member;
  studioId: string;
  projectId: string;
  spaceId: string;
}

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
 * A verified user with a session.
 * @returns The id and cookie.
 */
async function seedMember(): Promise<Member> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`tdg-${seq++}-${crypto.randomUUID()}@example.com`}, true) RETURNING id
  `;
  const userId = rows[0]!.id;
  return { userId, cookie: await sessionFor(userId) };
}

/**
 * A team studio its owner administers, a project in it with an editor and a
 * viewer, and a 3D Space id. The studio holds `credits` designated credits.
 * @param credits - What the studio can spend; 0 seeds no purchase at all.
 * @returns Everyone's ids and cookies, the project and the Space.
 */
async function seedProject(credits = 100_000): Promise<Seeded> {
  const owner = await seedMember();
  const tag = crypto.randomBytes(8).toString("hex");
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner.userId}, ${`tdg-s-${tag}`}, 'team', 'Generation') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${owner.userId}, 'admin')`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${owner.userId}, ${`tdg-p-${tag}`}, ${`tdg-p-${tag}`}) RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${owner.userId}, 'owner', null)`;
  const editor = await seedMember();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${editor.userId}, 'editor', ${owner.userId})`;
  const viewer = await seedMember();
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${viewer.userId}, 'viewer', ${owner.userId})`;
  if (credits > 0) await seedDesignatedLot(sql, { userId: owner.userId, studioId, projectId }, credits);
  return { owner, editor, viewer, studioId, projectId, spaceId: crypto.randomUUID() };
}

interface SeededAsset {
  assetId: string;
  url: string;
}

/**
 * A registered asset in the studio, referenced by the project.
 * @param s - Whose studio and project.
 * @param kind - What the asset is.
 * @param displayName - Its name in the Project, or null for a backend upload.
 * @returns Its id and registered address.
 */
async function seedAsset(s: Seeded, kind: "image" | "video" | "file", displayName: string | null = null): Promise<SeededAsset> {
  const hash = crypto.randomBytes(32).toString("hex");
  const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : "glb";
  const mime = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "model/gltf-binary";
  const storageKey = `${kind}/2026-11-07/${hash}.${ext}`;
  const url = publicUrl(storageKey);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
    VALUES (${s.studioId}, ${hash}, ${storageKey}, ${url}, 4096, ${mime}, ${kind}, 'upload', ${s.owner.userId})
    RETURNING id
  `;
  const assetId = rows[0]!.id;
  await sql`INSERT INTO project_asset_refs (project_id, asset_id, display_name) VALUES (${s.projectId}, ${assetId}, ${displayName})`;
  return { assetId, url };
}

/**
 * Send a JSON request.
 * @param method - HTTP method.
 * @param path - Path under /api/v1.
 * @param cookie - Session cookie.
 * @param payload - JSON body, when any.
 * @param idempotencyKey - The request's key, when it carries one.
 * @returns The response.
 */
async function call(method: string, path: string, cookie: string, payload?: unknown, idempotencyKey?: string): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie,
      ...(idempotencyKey !== undefined && { "Idempotency-Key": idempotencyKey }),
    },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
}

/**
 * A text-to-3D submission with every setting stated.
 * @param overrides - Fields a case varies.
 * @returns The body.
 */
function textBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "t23d",
    model: T23D,
    prompt: "a red barn lamp",
    params: { ...TEXT_SETTINGS, negative_prompt: "blurry" },
    origin: "space",
    ...overrides,
  };
}

/**
 * The settings a text submission states. `delight` is stated but its
 * condition (texture on and v3.5) does not hold, so it is not sent.
 */
const TEXT_SETTINGS = {
  texture: true,
  pbr: false,
  texture_quality: "detailed",
  texture_version: "v3.0",
  delight: true,
  geometry_quality: "standard",
  smart_low_poly: false,
  generate_parts: false,
  face_limit: 10_000,
  auto_size: false,
  export_uv: true,
  model_seed: 7,
};

/** What `resolveParams` makes of {@link TEXT_SETTINGS}: `delight` dropped, empty integers absent. */
const RESOLVED_TEXT_SETTINGS = {
  texture: true,
  pbr: false,
  texture_quality: "detailed",
  texture_version: "v3.0",
  geometry_quality: "standard",
  smart_low_poly: false,
  generate_parts: false,
  face_limit: 10_000,
  auto_size: false,
  export_uv: true,
  model_seed: 7,
};

/**
 * Submit a generation.
 * @param s - Where.
 * @param cookie - Who submits.
 * @param body - The submission.
 * @param key - The request's Idempotency-Key.
 * @returns The response.
 */
async function submit(s: Seeded, cookie: string, body: Record<string, unknown>, key: string = crypto.randomUUID()): Promise<Response> {
  return call("POST", `/projects/${s.projectId}/three-d/${s.spaceId}/generations`, cookie, body, key);
}

interface SubmitAnswer {
  task_id: string;
  row_id: string;
  status: "pending" | "failed";
}

/**
 * Submit a generation that must be admitted.
 * @param s - Where.
 * @param body - The submission.
 * @returns The answer's data.
 */
async function admitted(s: Seeded, body: Record<string, unknown> = textBody()): Promise<SubmitAnswer> {
  const res = await submit(s, s.owner.cookie, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { data: SubmitAnswer }).data;
}

interface RowRecord {
  id: string;
  node_id: string | null;
  space_id: string;
  kind: string;
  action: string;
  status: string;
  label: string;
  origin: string | null;
  task_id: string | null;
  asset_id: string | null;
  error_message: string | null;
  deleted_at: Date | null;
  started_by_user_id: string;
}

/**
 * The Space's rows, newest first.
 * @param s - Which Space.
 * @returns Its rows.
 */
async function spaceRows(s: Seeded): Promise<RowRecord[]> {
  return sql<RowRecord[]>`SELECT * FROM node_tasks WHERE project_id = ${s.projectId} AND space_id = ${s.spaceId} ORDER BY started_at DESC`;
}

/**
 * One row by id.
 * @param id - The row.
 * @returns It.
 */
async function rowById(id: string): Promise<RowRecord> {
  const rows = await sql<RowRecord[]>`SELECT * FROM node_tasks WHERE id = ${id}`;
  return rows[0]!;
}

interface TaskRecord {
  id: string;
  user_id: string;
  status: string;
  task_type: string;
  model: string | null;
  params: Record<string, unknown>;
  arq_job_id: string | null;
}

/**
 * The project's `tasks` rows.
 * @param s - Which project.
 * @returns Them.
 */
async function taskRows(s: Seeded): Promise<TaskRecord[]> {
  return sql<TaskRecord[]>`SELECT id, user_id, status, task_type, model, params, arq_job_id FROM tasks WHERE project_id = ${s.projectId}`;
}

/**
 * The holds of the project's studio.
 * @param s - Whose studio.
 * @returns Them.
 */
async function holds(s: Seeded): Promise<{ reference_id: string; status: string; amount: string }[]> {
  return sql<{ reference_id: string; status: string; amount: string }[]>`
    SELECT reference_id, status, amount::text AS amount FROM credit_holds WHERE studio_id = ${s.studioId}
  `;
}

/**
 * Wait until the subscriber has seen a signal for the Space.
 * @param s - Which Space.
 * @returns The messages for it.
 */
async function signalsFor(s: Seeded): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const mine = signals.filter((x) => x.message.projectId === s.projectId && x.message.spaceId === s.spaceId).map((x) => x.message);
    if (mine.length > 0 || Date.now() > deadline) return mine;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Capture every job the `tasks` queue is handed while `run` runs.
 * @param run - What to do.
 * @param fail - Refuse the `execute-task` job instead of queueing it.
 * @returns The job data handed over.
 */
async function capturingJobs(run: () => Promise<void>, fail = false): Promise<Record<string, unknown>[]> {
  const handed: Record<string, unknown>[] = [];
  const original = Queue.prototype.add;
  const add = vi.spyOn(Queue.prototype, "add").mockImplementation(function (this: Queue, ...args: Parameters<Queue["add"]>) {
    if (this.name === "tasks" && args[0] === "execute-task") {
      handed.push(args[1] as Record<string, unknown>);
      if (fail) return Promise.reject(new Error("the queue's Redis is unreachable"));
    }
    return original.apply(this, args);
  });
  try {
    await run();
  } finally {
    add.mockRestore();
  }
  return handed;
}

/**
 * Push a row past its deadline, without judging it.
 * @param rowId - The row.
 */
async function makeOverdue(rowId: string): Promise<void> {
  await sql`UPDATE node_tasks SET started_at = now() - (budget_ms + 60000) * interval '1 millisecond' WHERE id = ${rowId}`;
}

/**
 * Push a row past its deadline and let the list judge it expired.
 * @param s - Its Space.
 * @param rowId - The row.
 */
async function expire(s: Seeded, rowId: string): Promise<void> {
  await makeOverdue(rowId);
  const res = await call("GET", `/projects/${s.projectId}/three-d/${s.spaceId}/tasks`, s.owner.cookie);
  expect(res.status).toBe(200);
  expect((await rowById(rowId)).status).toBe("expired");
}

/**
 * Take a run's job off the queue, as a finished job leaves it.
 * @param taskId - The run.
 */
async function endJob(taskId: string): Promise<void> {
  const [task] = await sql<{ arq_job_id: string | null }[]>`SELECT arq_job_id FROM tasks WHERE id = ${taskId}`;
  const queue = createQueue("tasks");
  try {
    const job = task?.arq_job_id ? await queue.getJob(task.arq_job_id) : undefined;
    await job?.remove();
  } finally {
    await queue.close();
  }
}

/**
 * Record a run as charged with a stored result, as the worker leaves it.
 * @param taskId - The run.
 * @param result - The stored model.
 */
async function markBilledWith(taskId: string, result: SeededAsset): Promise<void> {
  await sql`
    UPDATE tasks SET status = 'completed', billed_at = now(), completed_at = now(),
      result = ${sql.json({ outputs: [{ url: result.url, asset_id: result.assetId }] })}
    WHERE id = ${taskId}
  `;
}

/**
 * Insert a node-less row straight into the table.
 * @param s - Where.
 * @param fields - The row's own fields.
 * @returns The insert, for a case to await or expect a rejection from.
 */
async function insertSpaceRow(s: Seeded, fields: { action: string; kind: string; origin: string | null; status?: string }): Promise<string> {
  const tasks = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, model)
    VALUES (${s.owner.userId}, ${s.projectId}, ${s.spaceId}, 'three_d', 'append', ${T23D}) RETURNING id
  `;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO node_tasks (project_id, space_id, node_id, kind, action, status, started_by_user_id, budget_ms, label, task_id, origin)
    VALUES (${s.projectId}, ${s.spaceId}, null, ${fields.kind}, ${fields.action}, ${fields.status ?? "running"}, ${s.owner.userId}, 7200000, 'Tripo H3.1', ${tasks[0]!.id}, ${fields.origin})
    RETURNING id
  `;
  return rows[0]!.id;
}

describe("the migration", () => {
  it("accepts a node-less generate row whose origin is space or agent", async () => {
    const s = await seedProject(0);
    const space = await insertSpaceRow(s, { kind: "generation", action: "generate", origin: "space" });
    const agent = await insertSpaceRow(s, { kind: "generation", action: "generate", origin: "agent" });
    expect(await rowById(space)).toMatchObject({ node_id: null, action: "generate", origin: "space" });
    expect(await rowById(agent)).toMatchObject({ node_id: null, action: "generate", origin: "agent" });
  });

  it("refuses an origin other than space or agent", async () => {
    const s = await seedProject(0);
    await expect(insertSpaceRow(s, { kind: "generation", action: "generate", origin: "canvas" })).rejects.toThrow(/node_tasks_origin/);
  });

  it("still refuses a node-less row with any action besides scene_import and generate", async () => {
    const s = await seedProject(0);
    await expect(insertSpaceRow(s, { kind: "generation", action: "understand", origin: "space" })).rejects.toThrow(/node_tasks_space_row_check/);
  });

  it("keeps the import failure report off a generate row", async () => {
    const s = await seedProject(0);
    const rowId = await insertSpaceRow(s, { kind: "generation", action: "generate", origin: "space" });
    const res = await call("POST", `/projects/${s.projectId}/three-d/${s.spaceId}/tasks/${rowId}/failure`, s.owner.cookie, { reason: "aborted" });
    expect(res.status).toBe(404);
    expect(await rowById(rowId)).toMatchObject({ status: "running", deleted_at: null });
  });
});

describe("submitting a generation: refusals leave nothing behind", () => {
  /**
   * Nothing this Space's submissions could have left.
   * @param s - The Space.
   */
  async function expectNothingLeft(s: Seeded): Promise<void> {
    expect(await taskRows(s)).toEqual([]);
    expect(await spaceRows(s)).toEqual([]);
    expect(await holds(s)).toEqual([]);
  }

  it("refuses a viewer with 403", async () => {
    const s = await seedProject();
    const res = await submit(s, s.viewer.cookie, textBody());
    expect(res.status).toBe(403);
    await expectNothingLeft(s);
  });

  it.each([
    ["an image model in text mode", { mode: "t23d", model: I23D }],
    ["the text model in image mode", { mode: "i23d", model: T23D, prompt: undefined }],
    ["a Canvas model", { mode: "t23d", model: "flux-schnell" }],
  ])("refuses %s with 422", async (_name, overrides) => {
    const s = await seedProject();
    const res = await submit(s, s.owner.cookie, textBody(overrides));
    expect(res.status).toBe(422);
    await expectNothingLeft(s);
  });

  it.each([
    ["two images on the single-image entry", I23D, 2],
    ["one image on the multi-view entry", MULTIVIEW, 1],
    ["five images on the multi-view entry", MULTIVIEW, 5],
  ])("refuses %s with 422", async (_name, model, count) => {
    const s = await seedProject();
    const images: string[] = [];
    for (let i = 0; i < count; i++) images.push((await seedAsset(s, "image", `view-${i}.png`)).assetId);
    const res = await submit(s, s.owner.cookie, { mode: "i23d", model, params: {}, image_asset_ids: images, origin: "space" });
    expect(res.status).toBe(422);
    await expectNothingLeft(s);
  });

  it("refuses a video asset in the left view slot with 422 naming the slot", async () => {
    const s = await seedProject();
    const front = await seedAsset(s, "image", "front.png");
    const left = await seedAsset(s, "video", "clip.mp4");
    const res = await submit(s, s.owner.cookie, {
      mode: "i23d", model: MULTIVIEW, params: {}, image_asset_ids: [front.assetId, left.assetId], origin: "space",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/left/i);
    await expectNothingLeft(s);
  });

  it("refuses an asset id the project does not reference with 422", async () => {
    const s = await seedProject();
    const res = await submit(s, s.owner.cookie, {
      mode: "i23d", model: I23D, params: {}, image_asset_ids: [crypto.randomUUID()], origin: "space",
    });
    expect(res.status).toBe(422);
    await expectNothingLeft(s);
  });

  it("refuses a setting a forced value changes (texture off while PBR defaults on) with 422 naming the rule", async () => {
    const s = await seedProject();
    const res = await submit(s, s.owner.cookie, textBody({ params: { texture: false } }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/pbr/i);
    await expectNothingLeft(s);
  });

  it("refuses a face limit outside the low-poly bounds with 422", async () => {
    const s = await seedProject();
    const res = await submit(s, s.owner.cookie, textBody({ params: { ...TEXT_SETTINGS, smart_low_poly: true, face_limit: 30_000 } }));
    expect(res.status).toBe(422);
    await expectNothingLeft(s);
  });

  it("refuses with 402 when the studio cannot cover the estimate, leaving no task, row or hold", async () => {
    const s = await seedProject(0);
    const res = await submit(s, s.owner.cookie, textBody());
    expect(res.status).toBe(402);
    await expectNothingLeft(s);
  });
});

describe("submitting a generation: admission", () => {
  it("answers 201 pending with one task, one generate row, one hold and one queued job naming the row", async () => {
    const s = await seedProject();
    let answer: SubmitAnswer | undefined;
    const jobs = await capturingJobs(async () => {
      answer = await admitted(s);
    });

    expect(answer).toEqual({ task_id: expect.any(String), row_id: expect.any(String), status: "pending" });
    const tasks = await taskRows(s);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: answer!.task_id, user_id: s.owner.userId, task_type: "three_d", model: T23D });
    const { input_asset_ids: textInputs, ...textParams } = tasks[0]!.params;
    expect(textParams).toEqual({ ...RESOLVED_TEXT_SETTINGS, prompt: "a red barn lamp", negative_prompt: "blurry" });
    expect(textInputs ?? []).toEqual([]);

    const rows = await spaceRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: answer!.row_id,
      node_id: null,
      kind: "generation",
      action: "generate",
      status: "running",
      origin: "space",
      task_id: answer!.task_id,
      label: "a red barn lamp",
      asset_id: null,
      started_by_user_id: s.owner.userId,
    });

    const estimate = await estimateTaskCredits(T23D, {
      params: { ...RESOLVED_TEXT_SETTINGS, negative_prompt: "blurry" },
      prompt: "a red barn lamp",
    });
    const held = await holds(s);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ reference_id: answer!.task_id, status: "held" });
    expect(Number(held[0]!.amount)).toBe(ceilToCreditCent(estimate));

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      taskId: answer!.task_id,
      projectId: s.projectId,
      spaceId: s.spaceId,
      taskType: "three_d",
      model: T23D,
      targetNodeIds: [],
      sceneRowId: answer!.row_id,
    });
    expect(await signalsFor(s)).toEqual([expect.objectContaining({ projectId: s.projectId, spaceId: s.spaceId })]);
  });

  it("stores the single image's registered address and asset id for the single-image entry", async () => {
    const s = await seedProject();
    const front = await seedAsset(s, "image", "front.png");
    const answer = await admitted(s, { mode: "i23d", model: I23D, params: {}, image_asset_ids: [front.assetId], origin: "agent" });

    const [task] = await taskRows(s);
    expect(task!.model).toBe(I23D);
    expect(task!.params).toMatchObject({ image: front.url, input_asset_ids: [front.assetId] });
    expect(task!.params).not.toHaveProperty("images");
    expect(await rowById(answer.row_id)).toMatchObject({ origin: "agent", action: "generate" });
  });

  it("hands the worker the image address and keeps the asset ids, which only the list and a retry read, out of the job", async () => {
    const s = await seedProject();
    const front = await seedAsset(s, "image", "front.png");
    const jobs = await capturingJobs(async () => {
      await admitted(s, { mode: "i23d", model: I23D, params: {}, image_asset_ids: [front.assetId], origin: "space" });
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.params).toMatchObject({ image: front.url });
    expect(jobs[0]!.params).not.toHaveProperty("input_asset_ids");
    const [task] = await taskRows(s);
    expect(task!.params).toMatchObject({ input_asset_ids: [front.assetId] });
  });

  it("stores the views' addresses and asset ids in front, left, back, right order for the multi-view entry", async () => {
    const s = await seedProject();
    const views = [
      await seedAsset(s, "image", "front.png"),
      await seedAsset(s, "image", "left.png"),
      await seedAsset(s, "image", "back.png"),
      await seedAsset(s, "image", "right.png"),
    ];
    await admitted(s, { mode: "i23d", model: MULTIVIEW, params: {}, image_asset_ids: views.map((v) => v.assetId), origin: "space" });

    const [task] = await taskRows(s);
    expect(task!.model).toBe(MULTIVIEW);
    expect(task!.params).toMatchObject({ images: views.map((v) => v.url), input_asset_ids: views.map((v) => v.assetId) });
    expect(task!.params).not.toHaveProperty("image");
  });

  it("answers a replay of the same Idempotency-Key with the same task and still one row and one hold", async () => {
    const s = await seedProject();
    const key = crypto.randomUUID();
    const first = await submit(s, s.owner.cookie, textBody(), key);
    expect(first.status, await first.clone().text()).toBe(201);
    const original = await first.json();
    const replay = await submit(s, s.owner.cookie, textBody(), key);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(original);

    expect(await taskRows(s)).toHaveLength(1);
    expect(await spaceRows(s)).toHaveLength(1);
    expect(await holds(s)).toHaveLength(1);
  });

  it("answers 201 failed when queueing throws: the row fails as internal, the hold is released, the task fails, and the Space is signalled", async () => {
    const s = await seedProject();
    let answer: SubmitAnswer | undefined;
    await capturingJobs(async () => {
      answer = await admitted(s);
    }, true);

    expect(answer).toEqual({ task_id: expect.any(String), row_id: expect.any(String), status: "failed" });
    expect(await rowById(answer!.row_id)).toMatchObject({ status: "failed", error_message: "internal", deleted_at: null });
    expect(await holds(s)).toEqual([expect.objectContaining({ reference_id: answer!.task_id, status: "released" })]);
    const [task] = await taskRows(s);
    expect(task!.status).toBe("failed");
    expect((await signalsFor(s)).length).toBeGreaterThanOrEqual(1);
  });

  it("still answers 201 pending with a running row when recording the job id throws after queueing", async () => {
    const s = await seedProject();
    setJobIdSpy.mockRejectedValueOnce(new Error("the connection dropped"));
    const answer = await admitted(s);

    expect(setJobIdSpy).toHaveBeenCalledTimes(1);
    expect(answer.status).toBe("pending");
    expect(await rowById(answer.row_id)).toMatchObject({ status: "running" });
    expect(await holds(s)).toEqual([expect.objectContaining({ reference_id: answer.task_id, status: "held" })]);
  });
});

describe("the row's label", () => {
  it("labels a text run by its cleaned prompt", async () => {
    const s = await seedProject();
    const prompt = "<p>A <b>red</b> barn lamp</p>";
    const answer = await admitted(s, textBody({ prompt }));
    expect((await rowById(answer.row_id)).label).toBe(extractPromptText(prompt));
    expect((await rowById(answer.row_id)).label).not.toMatch(/</);
  });

  it("cuts a long prompt with characters outside the basic plane to what a scene object's name holds", async () => {
    const s = await seedProject();
    const answer = await admitted(s, textBody({ prompt: `🐉 ${"a".repeat(400)}` }));
    const { label } = await rowById(answer.row_id);
    expect(label.length).toBeLessThanOrEqual(SCENE_OBJECT_NAME_MAX);
    expect(SceneObjectValuesSchema.shape.name.safeParse(label).success).toBe(true);
    expect(label.startsWith("🐉")).toBe(true);
  });

  it("cuts a long prompt to what a scene object's name holds, so the model can be placed", async () => {
    const s = await seedProject();
    const prompt = `${"灯".repeat(300)} end`;
    const answer = await admitted(s, textBody({ prompt }));
    const { label } = await rowById(answer.row_id);
    expect([...label]).toHaveLength(SCENE_OBJECT_NAME_MAX);
    expect(SceneObjectValuesSchema.shape.name.safeParse(label).success).toBe(true);
  });

  it("labels an image run by the front image's name in the Project", async () => {
    const s = await seedProject();
    const front = await seedAsset(s, "image", "lamp-front.png");
    const left = await seedAsset(s, "image", "lamp-left.png");
    const answer = await admitted(s, { mode: "i23d", model: MULTIVIEW, params: {}, image_asset_ids: [front.assetId, left.assetId], origin: "space" });
    expect((await rowById(answer.row_id)).label).toBe("lamp-front.png");
  });

  it("labels an image run whose front image has no name by the model's display name", async () => {
    const s = await seedProject();
    const front = await seedAsset(s, "image", null);
    const answer = await admitted(s, { mode: "i23d", model: I23D, params: {}, image_asset_ids: [front.assetId], origin: "space" });
    expect((await rowById(answer.row_id)).label).toBe("Tripo H3.1");
  });
});

interface ListedTask {
  id: string;
  kind: "import" | "generation";
  label: string;
  status: string;
  origin?: string;
  model?: { name: string; displayName: string };
  mode?: string;
  prompt?: string | null;
  params?: Record<string, unknown>;
  inputs?: { assetId: string; url: string }[];
  errorMessage?: string | null;
}

describe("reading the Space's list", () => {
  it("harvests overdue generation rows first, then lists imports and generations with what a retry needs", async () => {
    const s = await seedProject();
    const importRow = await sceneTaskService.open({
      projectId: s.projectId, spaceId: s.spaceId, startedByUserId: s.owner.userId, budgetMs: 7_200_000, label: "Barn lamp", storageKey: `file/${crypto.randomUUID()}.glb`,
    });
    const text = await admitted(s);
    const front = await seedAsset(s, "image", "front.png");
    const left = await seedAsset(s, "image", "left.png");
    const views = await admitted(s, { mode: "i23d", model: MULTIVIEW, params: {}, image_asset_ids: [front.assetId, left.assetId], origin: "agent" });
    await makeOverdue(text.row_id);
    signals.length = 0;

    const res = await call("GET", `/projects/${s.projectId}/three-d/${s.spaceId}/tasks`, s.viewer.cookie);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { tasks: ListedTask[] } };

    expect(data.tasks.map((task) => task.id)).toEqual([views.row_id, text.row_id, importRow]);
    expect(data.tasks.find((task) => task.id === importRow)).toMatchObject({ kind: "import", label: "Barn lamp", status: "running" });
    const textRow = data.tasks.find((task) => task.id === text.row_id)!;
    expect(textRow).toMatchObject({
      kind: "generation",
      status: "expired",
      origin: "space",
      model: { name: T23D, displayName: "Tripo H3.1" },
      mode: "t23d",
      prompt: "a red barn lamp",
      inputs: [],
    });
    expect(textRow.params).toEqual({ ...RESOLVED_TEXT_SETTINGS, negative_prompt: "blurry" });
    const viewsRow = data.tasks.find((task) => task.id === views.row_id)!;
    expect(viewsRow).toMatchObject({
      kind: "generation",
      status: "running",
      origin: "agent",
      model: { name: MULTIVIEW, displayName: "Tripo H3.1" },
      mode: "i23d",
      errorMessage: null,
      inputs: [
        { assetId: front.assetId, url: front.url },
        { assetId: left.assetId, url: left.url },
      ],
    });
    expect((await signalsFor(s)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("checking a timed-out row against the queue", () => {
  /**
   * Check a row.
   * @param s - Its Space.
   * @param rowId - The row.
   * @returns The response.
   */
  async function check(s: Seeded, rowId: string): Promise<Response> {
    return call("POST", `/projects/${s.projectId}/three-d/${s.spaceId}/tasks/${rowId}/check`, s.editor.cookie);
  }

  it("answers running while the job is still in the queue", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);

    const res = await check(s, answer.row_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: "running" } });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "expired", asset_id: null });
  });

  it("answers has_result when the job ended charged with a result, attaches it to the row and signals", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    const model = await seedAsset(s, "file", "lamp.glb");
    await endJob(answer.task_id);
    await markBilledWith(answer.task_id, model);
    signals.length = 0;

    const res = await check(s, answer.row_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: "has_result" } });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "expired", asset_id: model.assetId });
    expect((await signalsFor(s)).length).toBeGreaterThanOrEqual(1);
  });

  it("answers has_result when the worker charges the run between the check's reads of it", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    const model = await seedAsset(s, "file", "lamp.glb");
    await endJob(answer.task_id);
    // The worker bills, settles the row and ends the job after the check first read the run.
    const getJob = vi.spyOn(Queue.prototype, "getJob").mockImplementationOnce(async () => {
      await markBilledWith(answer.task_id, model);
      return undefined;
    });
    try {
      const res = await check(s, answer.row_id);
      expect(await res.json()).toEqual({ data: { outcome: "has_result" } });
      expect(await rowById(answer.row_id)).toMatchObject({ status: "expired", asset_id: model.assetId });
    } finally {
      getJob.mockRestore();
    }
  });

  it("answers ended when the job ended without a charged result", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    await endJob(answer.task_id);

    const res = await check(s, answer.row_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: "ended" } });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "expired", asset_id: null });
  });
});

describe("removing a row", () => {
  /**
   * Remove a row.
   * @param s - Its Space.
   * @param rowId - The row.
   * @param cookie - Who asks.
   * @returns The response.
   */
  async function remove(s: Seeded, rowId: string, cookie: string = s.editor.cookie): Promise<Response> {
    return call("DELETE", `/projects/${s.projectId}/three-d/${s.spaceId}/tasks/${rowId}`, cookie);
  }

  it("still removes a failed import row", async () => {
    const s = await seedProject();
    const importRow = await sceneTaskService.open({
      projectId: s.projectId, spaceId: s.spaceId, startedByUserId: s.owner.userId, budgetMs: 7_200_000, label: "Barn lamp", storageKey: `file/${crypto.randomUUID()}.glb`,
    });
    await call("POST", `/projects/${s.projectId}/three-d/${s.spaceId}/tasks/${importRow}/failure`, s.owner.cookie, { reason: "aborted" });
    expect((await remove(s, importRow)).status).toBe(200);
    expect((await rowById(importRow)).deleted_at).not.toBeNull();
  });

  it("soft-deletes a failed generation row", async () => {
    const s = await seedProject();
    let answer: SubmitAnswer | undefined;
    await capturingJobs(async () => {
      answer = await admitted(s);
    }, true);
    expect((await remove(s, answer!.row_id)).status).toBe(200);
    expect((await rowById(answer!.row_id)).deleted_at).not.toBeNull();
  });

  it("refuses with 409 a timed-out row whose job is still in the queue", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    expect((await remove(s, answer.row_id)).status).toBe(409);
    expect((await rowById(answer.row_id)).deleted_at).toBeNull();
  });

  it("refuses with 409 a timed-out row whose job ended with a result, and attaches the result", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    const model = await seedAsset(s, "file", "lamp.glb");
    await endJob(answer.task_id);
    await markBilledWith(answer.task_id, model);

    expect((await remove(s, answer.row_id)).status).toBe(409);
    expect(await rowById(answer.row_id)).toMatchObject({ deleted_at: null, asset_id: model.assetId });
  });

  it("soft-deletes a timed-out row whose job ended without a result", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    await endJob(answer.task_id);
    expect((await remove(s, answer.row_id)).status).toBe(200);
    expect((await rowById(answer.row_id)).deleted_at).not.toBeNull();
  });

  it("refuses with 409 a running row, a done row and a timed-out row holding a result", async () => {
    const s = await seedProject();
    const running = await admitted(s);
    const done = await admitted(s);
    const late = await admitted(s);
    const model = await seedAsset(s, "file", "lamp.glb");
    await sceneTaskService.settleById(done.row_id, { outcome: "done", assetId: model.assetId });
    await expire(s, late.row_id);
    await sql`UPDATE node_tasks SET asset_id = ${model.assetId} WHERE id = ${late.row_id}`;

    for (const id of [running.row_id, done.row_id, late.row_id]) {
      expect((await remove(s, id)).status).toBe(409);
      expect((await rowById(id)).deleted_at).toBeNull();
    }
  });

  it("refuses a viewer with 403", async () => {
    const s = await seedProject();
    let answer: SubmitAnswer | undefined;
    await capturingJobs(async () => {
      answer = await admitted(s);
    }, true);
    expect((await remove(s, answer!.row_id, s.viewer.cookie)).status).toBe(403);
    expect((await rowById(answer!.row_id)).deleted_at).toBeNull();
  });
});

describe("resolving views named by their address", () => {
  it("resolves a picture of this Project by its address, and names the slot of one that is not", async () => {
    const s = await seedProject();
    const front = await seedAsset(s, "image", "front.png");
    const other = await seedProject();
    const foreign = await seedAsset(other, "image", "theirs.png");
    const unreferenced = await seedAsset(s, "image", "gone.png");
    await sql`DELETE FROM project_asset_refs WHERE asset_id = ${unreferenced.assetId}`;

    expect(await resolveProjectImageInputs(s.projectId, [front.url])).toEqual([expect.objectContaining({ assetId: front.assetId, url: front.url })]);
    for (const address of [foreign.url, unreferenced.url]) {
      await expect(resolveProjectImageInputs(s.projectId, [front.url, address])).rejects.toMatchObject({ statusCode: 422 });
    }
  });
});

describe("charging a 3D generation", () => {
  it("charges a run at most once, with the first charge's figure, however many charges race for it", async () => {
    const s = await seedProject();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 5_000 }), { minLength: 2, maxLength: 6 }), async (charges) => {
        const answer = await admitted(s);
        const won = await Promise.all(
          charges.map((credits) => taskService.markCompletedAndBill(answer.task_id, { outputs: [] }, credits / 100, 1)),
        );
        expect(won.filter(Boolean)).toHaveLength(1);
        const [task] = await sql<{ billed_credits: string }[]>`SELECT billed_credits FROM tasks WHERE id = ${answer.task_id}`;
        expect(Number(task!.billed_credits)).toBe(charges[won.indexOf(true)]! / 100);
      }),
      { numRuns: 10 },
    );
  });
});

describe("settling a generation row", () => {
  it("moves a running row to done with the model", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    const model = await seedAsset(s, "file", "lamp.glb");
    await sceneTaskService.settleById(answer.row_id, { outcome: "done", assetId: model.assetId });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "done", asset_id: model.assetId });
  });

  it("attaches a success that arrives after the row expired", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await expire(s, answer.row_id);
    const model = await seedAsset(s, "file", "lamp.glb");
    await sceneTaskService.settleById(answer.row_id, { outcome: "done", assetId: model.assetId });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "expired", asset_id: model.assetId });
  });

  it("settles a failure before the deadline as failed with its code", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await sceneTaskService.settleById(answer.row_id, { outcome: "failed", errorMessage: "no_credits" });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "failed", error_message: "no_credits", asset_id: null });
  });

  it("settles a failure past the deadline as expired", async () => {
    const s = await seedProject();
    const answer = await admitted(s);
    await makeOverdue(answer.row_id);
    await sceneTaskService.settleById(answer.row_id, { outcome: "failed", errorMessage: "internal" });
    expect(await rowById(answer.row_id)).toMatchObject({ status: "expired", asset_id: null });
  });
});
