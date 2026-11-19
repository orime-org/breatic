// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import crypto from "node:crypto";
import { Queue } from "bullmq";
import type { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { getMiniToolsConfig, getNodeTaskConfig, getRedis, getStorageAdapter, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import type * as shared from "@breatic/shared";
import { t as sharedT } from "@breatic/shared";
import { miniToolAnalysisRequestSchema, miniToolAnalysisService, taskRepo, taskService } from "@breatic/domain";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, miniToolConsumptionKey, projectMiniToolAnalysisInput, type MiniToolAnalysisKind, type MiniToolAnalysisRecord } from "@breatic/shared/mini-tools";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { editKeyOf, presentedSource, type PresentedSource } from "./presentation-fixtures.js";

// S6e E4-2 (inner#1306 §90; design §7.11 分析受理): the request names its tool input; admission reads the selected
// version from ingest (faked here), as the fresh execution admission does.
const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

interface AnalysisRequest {
  analysisRunId: string;
  projectId: string;
  spaceId: string;
  hostNodeId: string;
  draftId: string;
  revision: string;
  kind: MiniToolAnalysisKind;
  source: {
    nodeId: string;
    canonicalURL: string;
    mediaInfo: { width: number; height: number; duration: number; mimeType: string };
  };
  params: Record<string, unknown>;
  presentationRef: { source: { toolInputId: string; planSha256: string } };
}

interface AnalysisFixture extends StudioFixture {
  ownerCookie: string;
  editorId: string;
  editorCookie: string;
  viewerId: string;
  viewerCookie: string;
  sourceAssetId: string;
  sourceHash: string;
  sourceURL: string;
  sourceKey: string;
  presentation: PresentedSource;
}

interface FrozenAnalysisParams {
  analysis: {
    schemaVersion: 1;
    analysisRunId: string;
    projectId: string;
    spaceId: string;
    hostNodeId: string;
    draftId: string;
    revision: string;
    kind: MiniToolAnalysisKind;
    source: AnalysisRequest["source"];
    binding: MiniToolAnalysisRecord["binding"];
    analysisInput: MiniToolAnalysisRecord["analysisInput"];
    inputFingerprint: string;
    presentationRef: AnalysisRequest["presentationRef"];
    presentations: { source: unknown };
    versionIds: { source: string };
    chargeTo: "platform" | "user";
  };
}

let sql: ReturnType<typeof postgres>;
let app: Hono;
let publicUrl: (key: string) => string;

beforeAll(async () => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_analysis_admission_tests",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_analysis_admission_tests",
    WAVESPEED_API_KEY: "unused-by-analysis-admission-tests",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "mini-tool-analysis-test" } });
  const storage = await getStorageAdapter();
  publicUrl = (key) => storage.publicUrl(key);
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const body = outside.bodies.get(input instanceof Request ? input.url : String(input));
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * Creates a real authenticated session in the suite's Redis.
 * @param userId - The registered account.
 * @returns The session cookie header.
 */
async function cookieFor(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Creates a registered member in a project.
 * @param projectId - The project to join.
 * @param role - Its project role.
 * @returns Its id and authenticated cookie.
 */
async function member(projectId: string, role: "editor" | "viewer"): Promise<{ id: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`analysis-${crypto.randomUUID()}@example.test`}, true) RETURNING id
  `;
  const id = user!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${id}, ${role})`;
  return { id, cookie: await cookieFor(id) };
}

/**
 * Builds a project, three roles, spendable credits and a registered video.
 * @param options - Whether the video presents with transparency.
 * @param options.transparent - A source whose playback file is alpha-packed.
 * @param options.edit - A source whose tools read an edit file.
 * @returns The fixture with immutable registration facts.
 */
async function seed(options: { transparent?: boolean; edit?: boolean } = {}): Promise<AnalysisFixture> {
  const fixture = await seedStudioFixture(sql, "analysis");
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${fixture.projectId}, ${fixture.userId}, 'owner')`;
  await seedDesignatedLot(sql, fixture, 1000);
  const editor = await member(fixture.projectId, "editor");
  const viewer = await member(fixture.projectId, "viewer");
  const key = `video/2026-10-24/${Date.now()}_${crypto.randomUUID()}.mp4`;
  const sourceURL = publicUrl(key);
  const sourceHash = crypto.randomBytes(32).toString("hex");
  const [asset] = await sql<{ id: string }[]>`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind,
       source, produced_by_user_id, width, height, duration_seconds)
    VALUES (${fixture.studioId}, ${sourceHash}, ${key}, ${sourceURL}, 4096, 'video/mp4', 'video',
      'upload', ${fixture.userId}, 960, 540, 5.055) RETURNING id
  `;
  // The selected version of this source, as ingest answers it.
  const presentation = await presentedSource(sourceHash, key, publicUrl, options);
  outside.snapshots.set(key, presentation.snapshot);
  
  return {
    ...fixture, ownerCookie: await cookieFor(fixture.userId),
    editorId: editor.id, editorCookie: editor.cookie, viewerId: viewer.id, viewerCookie: viewer.cookie,
    sourceAssetId: asset!.id, sourceHash, sourceURL, sourceKey: key, presentation,
  };
}

/**
 * Builds one independently identified analysis request.
 * @param fixture - The registered source and owning project.
 * @param kind - The analysis requested.
 * @returns Its complete public request body.
 */
function requestFor(fixture: AnalysisFixture, kind: MiniToolAnalysisKind = "people"): AnalysisRequest {
  const hostNodeId = crypto.randomUUID();
  const anchor = { frameIndex: 0 };
  // Ranges are grid frames (frames-split §10.12): 5 s of the 200 fps fixture grid.
  const range = { start: 0, end: 1000 };
  return {
    analysisRunId: crypto.randomUUID(), projectId: fixture.projectId, spaceId: crypto.randomUUID(),
    hostNodeId, draftId: crypto.randomUUID(), revision: crypto.randomUUID(), kind,
    source: { nodeId: hostNodeId, canonicalURL: fixture.sourceURL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } },
    params: kind === "people" ? { anchor } : kind === "scene_cuts" ? { range } : {
      range, anchor, region: { box: { x: 0.1, y: 0.1, width: 0.4, height: 0.6 }, points: [] }, trackingPrompt: "the selected person",
    },
    presentationRef: fixture.presentation.presentationRef,
  };
}

/**
 * Sends an analysis through the real app and Redis run-once middleware.
 * @param body - The public request.
 * @param cookie - The actor's session, absent for authentication tests.
 * @param key - The fixed press identity.
 * @returns The HTTP response.
 */
async function post(body: unknown, cookie?: string, key = crypto.randomUUID()): Promise<Response> {
  return app.request("/api/v1/mini-tools/analyses", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...(cookie === undefined ? {} : { Cookie: cookie }) },
    body: JSON.stringify(body),
  });
}

/**
 * Reads an analysis using the project's current membership.
 * @param analysisRunId - The persistent task identity.
 * @param cookie - The actor's session, absent for authentication tests.
 * @returns The HTTP response.
 */
async function get(analysisRunId: string, cookie?: string): Promise<Response> {
  return app.request(`/api/v1/mini-tools/analyses/${analysisRunId}`, { headers: cookie === undefined ? {} : { Cookie: cookie } });
}

/**
 * Verifies an accepted response and decodes its complete public contract.
 * @param response - The response produced by the real app.
 * @returns The schema-validated record.
 */
async function accepted(response: Response): Promise<MiniToolAnalysisRecord> {
  expect(response.status, await response.clone().text()).toBe(201);
  const json = await response.json() as { data: unknown };
  return miniToolAnalysisRecordSchema.parse(json.data);
}

/**
 * Reads the complete public record from a successful GET.
 * @param response - The response produced by the real app.
 * @returns The schema-validated record.
 */
async function reading(response: Response): Promise<MiniToolAnalysisRecord> {
  expect(response.status, await response.clone().text()).toBe(200);
  const json = await response.json() as { data: unknown };
  return miniToolAnalysisRecordSchema.parse(json.data);
}

/**
 * Reads admission effects for one task directly from the real database.
 * @param taskId - The analysis task identity.
 * @returns Task, node-task and credit-hold counts.
 */
async function counts(taskId: string): Promise<{ tasks: number; rows: number; holds: number }> {
  const [row] = await sql<{ tasks: number; rows: number; holds: number }[]>`
    SELECT
      (SELECT count(*)::int FROM tasks WHERE id = ${taskId}) AS tasks,
      (SELECT count(*)::int FROM node_tasks WHERE task_id = ${taskId}) AS rows,
      (SELECT count(*)::int FROM credit_holds WHERE reference_id = ${taskId}) AS holds
  `;
  return row!;
}

/**
 * Adds an empty successful people result to an accepted record.
 * @param record - A people analysis accepted by the server.
 * @param acceptedAt - The full-precision initial task time.
 * @returns A complete record with its matching typed result.
 * @throws {Error} When the fixture is not a people analysis.
 */
function completedPeople(record: MiniToolAnalysisRecord, acceptedAt: string): MiniToolAnalysisRecord {
  if (record.kind !== "people" || record.analysisInput.kind !== "people") throw new Error("Expected a people analysis fixture");
  const identity = {
    schemaVersion: 1 as const, draftId: record.draftId, revision: record.revision, kind: "people" as const,
    analysisRunId: record.analysisRunId, acceptedAt, binding: record.binding,
    analysisInput: record.analysisInput, inputFingerprint: record.inputFingerprint,
  };
  return { ...record, acceptedAt, status: "completed", result: { ...identity, anchor: record.analysisInput.anchor, people: [] } };
}

/**
 * Persists a historical accepted analysis for read tests independent of POST.
 * @param fixture - Its registered source and owning project.
 * @param acceptedAt - The SQL creation time at full precision.
 * @returns The persisted pending record.
 */
async function seedAccepted(fixture: AnalysisFixture, acceptedAt: string): Promise<MiniToolAnalysisRecord> {
  const body = requestFor(fixture);
  const analysisInput = projectMiniToolAnalysisInput({
    kind: "people", source: body.source, params: body.params,
    profile: {
      id: "opencv-yunet-2023mar", version: "2023mar",
      weightsHash: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
      params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 },
    },
  });
  const binding = { assetId: fixture.sourceAssetId, contentHash: fixture.sourceHash, canonicalURL: fixture.sourceURL, kind: "video" as const, mediaInfo: body.source.mediaInfo };
  const record: MiniToolAnalysisRecord = {
    schemaVersion: 1, analysisRunId: body.analysisRunId, draftId: body.draftId, revision: body.revision,
    kind: "people", acceptedAt, binding, analysisInput, inputFingerprint: await fingerprintMiniToolAnalysisInput(analysisInput),
    status: "pending", result: null, error: null, usage: [], artifactUnavailable: false,
  };
  const params: FrozenAnalysisParams = { analysis: {
    schemaVersion: 1, analysisRunId: body.analysisRunId, projectId: body.projectId, spaceId: body.spaceId,
    hostNodeId: body.hostNodeId, draftId: body.draftId, revision: body.revision, kind: "people",
    source: body.source, binding, analysisInput, inputFingerprint: record.inputFingerprint,
    presentationRef: body.presentationRef, presentations: { source: fixture.presentation.bundle }, versionIds: { source: fixture.presentation.versionId },
    chargeTo: "platform",
  } };
  // Keep the parameter's OID textual: the driver's timestamp serializer runs
  // strings through Date, which would discard the microseconds before insertion.
  await sql`
    INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, source, params, result, created_at)
    VALUES (${body.analysisRunId}, ${fixture.userId}, ${fixture.projectId}, ${body.spaceId}, 'mini_tool_analysis',
      'append', 'mini_tool', ${sql.json(z.json().parse(params))}, ${sql.json({ analysis: record })}, ${acceptedAt}::text::timestamptz)
  `;
  const [stored] = await sql<{ accepted_at: string }[]>`
    SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at
    FROM tasks WHERE id = ${body.analysisRunId}
  `;
  expect(stored?.accepted_at).toBe(acceptedAt);
  return record;
}

describe("mini-tool analysis admission and project reads", () => {
  it.each([
    { kind: "people" as const, holds: 0 },
    { kind: "scene_cuts" as const, holds: 1 },
    { kind: "tracked_mask" as const, holds: 1 },
  ])("accepts $kind with a frozen public record and one host task", async ({ kind, holds }) => {
    const fixture = await seed();
    const body = requestFor(fixture, kind);
    const record = await accepted(await post(body, fixture.ownerCookie));
    expect(record).toMatchObject({
      schemaVersion: 1, analysisRunId: body.analysisRunId, draftId: body.draftId, revision: body.revision, kind,
      status: "pending", result: null, error: null, usage: [], artifactUnavailable: false,
      binding: { assetId: fixture.sourceAssetId, contentHash: fixture.sourceHash, canonicalURL: fixture.sourceURL, kind: "video", mediaInfo: body.source.mediaInfo },
      analysisInput: { schemaVersion: 1, kind, sourceURL: fixture.sourceURL },
    });
    expect(record.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const [task] = await sql<{ id: string; project_id: string; user_id: string; space_id: string; source: string; task_type: string; accepted_at: string; params: FrozenAnalysisParams }[]>`
      SELECT id, project_id, user_id, space_id, source, task_type, params,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at
      FROM tasks WHERE id = ${body.analysisRunId}
    `;
    expect(task).toMatchObject({ id: body.analysisRunId, project_id: body.projectId, user_id: fixture.userId, space_id: body.spaceId, source: "mini_tool", task_type: "mini_tool_analysis", accepted_at: record.acceptedAt });
    expect(task?.params.analysis).toEqual({
      schemaVersion: 1, analysisRunId: body.analysisRunId, projectId: body.projectId, spaceId: body.spaceId, hostNodeId: body.hostNodeId,
      draftId: body.draftId, revision: body.revision, kind, source: body.source,
      binding: record.binding, analysisInput: record.analysisInput, inputFingerprint: record.inputFingerprint,
      // The tool input and the selected version are frozen with the analysis (frames-split §7.11), with its payer (§5.5).
      presentationRef: body.presentationRef, presentations: { source: fixture.presentation.bundle }, versionIds: { source: fixture.presentation.versionId },
      chargeTo: kind === "people" ? "platform" : "user",
    });
    const rows = await sql<{ node_id: string; action: string; budget_ms: number; task_id: string }[]>`
      SELECT node_id, action, budget_ms, task_id FROM node_tasks WHERE task_id = ${body.analysisRunId}
    `;
    expect(rows).toEqual([{ node_id: body.hostNodeId, action: "mini_tool", budget_ms: getNodeTaskConfig().default_budget_ms, task_id: body.analysisRunId }]);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds });
  });

  it("lets another project member read the same accepted record", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const record = await accepted(await post(body, fixture.ownerCookie));
    expect(await reading(await get(body.analysisRunId, fixture.viewerCookie))).toEqual(record);
    expect(await reading(await get(body.analysisRunId, fixture.editorCookie))).toEqual(record);
  });

  it("reads a stored analysis through current project membership", async () => {
    const fixture = await seed();
    const record = await seedAccepted(fixture, "2026-10-24T09:03:03.100001Z");
    expect(await reading(await get(record.analysisRunId, fixture.viewerCookie))).toEqual(record);
  });

  it("uses the stored project when rejecting a member of another project", async () => {
    const fixture = await seed();
    const outsider = await seed();
    const body = requestFor(fixture);
    await accepted(await post(body, fixture.ownerCookie));
    const response = await app.request(`/api/v1/mini-tools/analyses/${body.analysisRunId}?projectId=${outsider.projectId}`, { headers: { Cookie: outsider.ownerCookie } });
    expect(response.status).toBe(404);
  });

  it("rechecks membership after the reader leaves the project", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    await accepted(await post(body, fixture.ownerCookie));
    expect((await get(body.analysisRunId, fixture.viewerCookie)).status).toBe(200);
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${fixture.projectId} AND user_id = ${fixture.viewerId}`;
    expect((await get(body.analysisRunId, fixture.viewerCookie)).status).toBe(404);
  });

  it("requires authentication at both public analysis endpoints", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    expect((await post(body)).status).toBe(401);
    expect((await get(body.analysisRunId)).status).toBe(401);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
  });

  it("rejects a viewer before opening a task, node task or hold", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    expect((await post(body, fixture.viewerCookie)).status).toBe(403);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
  });

  it("replays one press with the identical identity, time, binding and admission effects", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const key = crypto.randomUUID();
    const first = await accepted(await post(body, fixture.ownerCookie, key));
    const replay = await post(body, fixture.ownerCookie, key);
    expect(await accepted(replay)).toEqual(first);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds: 0 });
  });

  it("reuses the persistent run when the same body arrives under another press key", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const first = await accepted(await post(body, fixture.ownerCookie));
    expect(await accepted(await post(body, fixture.ownerCookie))).toEqual(first);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds: 0 });
  });

  it("refuses a changed body under the same press key and preserves the original analysis", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const key = crypto.randomUUID();
    const first = await accepted(await post(body, fixture.ownerCookie, key));
    const response = await post({ ...body, params: { anchor: { frameIndex: 1 } } }, fixture.ownerCookie, key);
    expect(response.status).toBe(422);
    expect(await reading(await get(body.analysisRunId, fixture.ownerCookie))).toEqual(first);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds: 0 });
  });

  it("refuses conflicting persistent run ownership or inputs under another press key", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const first = await accepted(await post(body, fixture.ownerCookie));
    const changed = await post({ ...body, params: { anchor: { frameIndex: 1 } } }, fixture.ownerCookie);
    expect([409, 422]).toContain(changed.status);
    const otherActor = await post(body, fixture.editorCookie);
    expect([409, 422]).toContain(otherActor.status);
    expect(await reading(await get(body.analysisRunId, fixture.ownerCookie))).toEqual(first);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds: 0 });
  });

  it("holds the user-run scene analysis estimate once across press and persistent-run replay", async () => {
    const fixture = await seed();
    const body = requestFor(fixture, "scene_cuts");
    const key = crypto.randomUUID();
    const first = await accepted(await post(body, fixture.ownerCookie, key));
    const held = await sql<{ id: string; status: string; amount: string; positive: boolean }[]>`
      SELECT id, status, amount::text AS amount, amount > 0 AS positive
      FROM credit_holds WHERE reference_id = ${body.analysisRunId}
    `;
    expect(held.map(({ status, positive }) => ({ status, positive }))).toEqual([{ status: "held", positive: true }]);
    expect(await accepted(await post(body, fixture.ownerCookie, key))).toEqual(first);
    expect(await accepted(await post(body, fixture.ownerCookie))).toEqual(first);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds: 1 });
    const after = await sql<{ id: string; status: string; amount: string; positive: boolean }[]>`
      SELECT id, status, amount::text AS amount, amount > 0 AS positive
      FROM credit_holds WHERE reference_id = ${body.analysisRunId}
    `;
    expect(after).toEqual(held);
  });

  it("preserves source registration compatibility across studios", async () => {
    const sourceOwner = await seed();
    const target = await seed();
    const body = requestFor(target);
    body.source.canonicalURL = sourceOwner.sourceURL;
    body.presentationRef = sourceOwner.presentation.presentationRef;
    const record = await accepted(await post(body, target.ownerCookie));
    expect(record.binding).toEqual({ assetId: sourceOwner.sourceAssetId, contentHash: sourceOwner.sourceHash, canonicalURL: sourceOwner.sourceURL, kind: "video", mediaInfo: body.source.mediaInfo });
    expect(await reading(await get(body.analysisRunId, target.viewerCookie))).toEqual(record);
  });

  it("reads distinct SQL microseconds before and after the typed results are stored", async () => {
    const fixture = await seed();
    const first = await seedAccepted(fixture, "2026-10-24T09:03:03.100001Z");
    const second = await seedAccepted(fixture, "2026-10-24T09:03:03.100002Z");
    const fixtures = [
      { record: first, acceptedAt: "2026-10-24T09:03:03.100001Z" },
      { record: second, acceptedAt: "2026-10-24T09:03:03.100002Z" },
    ];
    for (const item of fixtures) {
      const pending = await reading(await get(item.record.analysisRunId, fixture.viewerCookie));
      expect(pending.acceptedAt).toBe(item.acceptedAt);
      await taskService.markRunning(item.record.analysisRunId, "analysis-microseconds", new Date("2026-10-24T09:04:00Z"));
      expect((await reading(await get(item.record.analysisRunId, fixture.viewerCookie))).acceptedAt).toBe(item.acceptedAt);
      const completed = completedPeople(item.record, item.acceptedAt);
      await sql`UPDATE tasks SET status = 'completed', result = ${sql.json({ analysis: completed })} WHERE id = ${item.record.analysisRunId}`;
      expect(await reading(await get(item.record.analysisRunId, fixture.viewerCookie))).toEqual(completed);
    }
  });

  it("keeps a failed analysis and its matching late typed result readable", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const pending = await accepted(await post(body, fixture.ownerCookie));
    const completed = completedPeople(pending, pending.acceptedAt);
    const failed = { ...completed, status: "failed" as const, error: { code: "analysis_failed" } };
    await sql`UPDATE tasks SET status = 'failed', error_message = 'analysis_failed', result = ${sql.json({ analysis: failed })} WHERE id = ${body.analysisRunId}`;
    expect(await reading(await get(body.analysisRunId, fixture.viewerCookie))).toEqual(failed);
  });

  it("keeps ordinary task ownership and analysis reads as separate contracts", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    await accepted(await post(body, fixture.ownerCookie));
    expect((await app.request(`/api/v1/tasks/${body.analysisRunId}`, { headers: { Cookie: fixture.viewerCookie } })).status).toBe(403);
    const ordinaryId = crypto.randomUUID();
    await sql`INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, source) VALUES (${ordinaryId}, ${fixture.userId}, ${fixture.projectId}, ${body.spaceId}, 'video', 'append', 'mini_tool')`;
    expect((await get(ordinaryId, fixture.ownerCookie)).status).toBe(404);
  });

  it("hides a deleted analysis task from project members", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    await accepted(await post(body, fixture.ownerCookie));
    await sql`UPDATE tasks SET deleted_at = now() WHERE id = ${body.analysisRunId}`;
    expect((await get(body.analysisRunId, fixture.viewerCookie)).status).toBe(404);
  });

  it.each(["analysisRunId", "projectId", "spaceId", "hostNodeId", "draftId", "revision"])("rejects an invalid %s without admission effects", async (field) => {
    const fixture = await seed();
    const body = requestFor(fixture);
    expect((await post({ ...body, [field]: "invalid-uuid" }, fixture.ownerCookie)).status).toBe(422);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
  });

  it("rejects a client-supplied analysis profile", async () => {
    const fixture = await seed();
    const body = requestFor(fixture);
    const response = await post({ ...body, profile: { id: "client-selected", version: "1", weightsHash: null, params: {} } }, fixture.ownerCookie);
    expect(response.status).toBe(422);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
  });

  it("keeps a failed admission terminal when its queue adapter cannot start work", async () => {
    const fixture = await seed();
    const body = miniToolAnalysisRequestSchema.parse(requestFor(fixture));
    await expect(miniToolAnalysisService.accept(body, fixture.userId, async () => {
      throw new Error("queue unavailable");
    })).rejects.toThrow("queue unavailable");
    const failed = await reading(await get(body.analysisRunId, fixture.viewerCookie));
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "analysis_start_failed" });
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 0, holds: 0 });
    expect(await accepted(await post(body, fixture.ownerCookie))).toEqual(failed);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 0, holds: 0 });
  });

  it("preserves settlement metadata when storing an analysis record", async () => {
    const fixture = await seed();
    const record = await seedAccepted(fixture, "2026-10-24T09:03:03.100001Z");
    const settlement = { billingState: "pending", consumptionKeys: [] };
    await sql`UPDATE tasks SET result = ${sql.json({ analysis: record, settlement })} WHERE id = ${record.analysisRunId}`;
    await taskRepo.storeAnalysisRecord(record.analysisRunId, record);
    const [stored] = await sql<{ result: { settlement: unknown } }[]>`SELECT result FROM tasks WHERE id = ${record.analysisRunId}`;
    expect(stored?.result.settlement).toEqual(settlement);
    expect(await reading(await get(record.analysisRunId, fixture.viewerCookie))).toEqual(record);
  });

  it.each([
    { kind: "people" as const, nodeStatus: "running" },
    { kind: "people" as const, nodeStatus: "done" },
    { kind: "scene_cuts" as const, nodeStatus: "running" },
    { kind: "scene_cuts" as const, nodeStatus: "done" },
  ])("keeps completed $kind and its $nodeStatus node after a queue acknowledgement error", async ({ kind, nodeStatus }) => {
    const fixture = await seed(); const body = requestFor(fixture, kind);
    let committed!: MiniToolAnalysisRecord;
    let nodeBefore: unknown;
    const settlement = { version: 7, state: "waiting", pendingConsumptionKeys: ["a".repeat(64)], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: true };
    const add = vi.spyOn(Queue.prototype, "add").mockImplementationOnce(async () => {
      const record = await miniToolAnalysisService.get(body.analysisRunId, fixture.userId);
      await sql`UPDATE tasks SET result=result || ${sql.json({ settlement, preserved: { fixture: true } })} WHERE id=${body.analysisRunId}`;
      // The public record's transport fields are not detector-result fields.
      const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = record;
      const result = kind === "people" ? completedPeople(record, record.acceptedAt).result : {
        ...identity, kind: "scene_cuts", fps: { numerator: 200, denominator: 1 }, frameCount: 20, cuts: [],
      };
      committed = (await miniToolAnalysisService.finishMiniToolAnalysis(body.analysisRunId, { kind: "result", result })).record;
      if (nodeStatus === "done") await sql`UPDATE node_tasks SET status='done',settled_at=now() WHERE task_id=${body.analysisRunId}`;
      const [node] = await sql<{ value: unknown }[]>`SELECT to_jsonb(n) AS value FROM node_tasks n WHERE task_id=${body.analysisRunId}`;
      nodeBefore = node!.value;
      throw new Error("fixture_queue_acknowledgement_failed");
    });
    try {
      await post(body, fixture.ownerCookie);
      expect(add).toHaveBeenCalledTimes(1);
      expect(await reading(await get(body.analysisRunId, fixture.viewerCookie))).toEqual(committed);
      const [task] = await sql<{ status: string; result: Record<string, unknown> }[]>`SELECT status,result FROM tasks WHERE id=${body.analysisRunId}`;
      expect(task).toEqual({ status: "completed", result: { analysis: committed, settlement, preserved: { fixture: true } } });
      const [node] = await sql<{ value: unknown }[]>`SELECT to_jsonb(n) AS value FROM node_tasks n WHERE task_id=${body.analysisRunId}`;
      expect(node!.value).toEqual(nodeBefore);
      const holds = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${body.analysisRunId}`;
      expect([...holds]).toEqual(kind === "people" ? [] : [{ status: "held" }]);
      expect(await counts(body.analysisRunId)).toEqual({ tasks: 1, rows: 1, holds: kind === "people" ? 0 : 1 });
    } finally { add.mockRestore(); }
  });

  it.each(["people", "scene_cuts"] as const)("atomically fails an unsubmitted %s admission and releases its unused hold", async (kind) => {
    const fixture = await seed(); const body = requestFor(fixture, kind);
    const add = vi.spyOn(Queue.prototype, "add").mockRejectedValueOnce(new Error("fixture_queue_rejected_before_acceptance"));
    try {
      const response = await post(body, fixture.ownerCookie);
      expect(response.status).toBe(201);
      const record = await accepted(response);
      expect(record).toMatchObject({ status: "failed", result: null, error: { code: "internal" } });
      const [task] = await sql<{ status: string; analysis: unknown }[]>`SELECT status,result->'analysis' AS analysis FROM tasks WHERE id=${body.analysisRunId}`;
      expect(task).toEqual({ status: "failed", analysis: record });
      const [node] = await sql<{ status: string; budget_ms: number }[]>`SELECT status,budget_ms FROM node_tasks WHERE task_id=${body.analysisRunId}`;
      expect(node).toEqual({ status: "failed", budget_ms: getNodeTaskConfig().default_budget_ms });
      const holds = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${body.analysisRunId}`;
      expect([...holds]).toEqual(kind === "people" ? [] : [{ status: "released" }]);
    } finally { add.mockRestore(); }
  });

  it.each(["pending", "known"] as const)("keeps the hold and %s expense when analysis admission fails after work was submitted", async (state) => {
    const fixture = await seed(); const body = requestFor(fixture, "scene_cuts"); const stepId = crypto.randomUUID();
    const config = getMiniToolsConfig(); const containerClass = config.analyses.scene_cuts.container_class;
    const size = config.classes[containerClass]!;
    const identity = { kind: "container" as const, containerClass, jobId: body.analysisRunId, chunkIndex: 0 };
    const key = await miniToolConsumptionKey({ taskId: body.analysisRunId, stepId, identity });
    const consumption = { schemaVersion: 1, consumptionKey: key, identity, state, creditMultiplier: 1, chargeTo: "user", costUsd: state === "known" ? 0.0001 : null, costSource: state === "known" ? "computed" : null, raw: state === "known" ? { wallMs: 1000, cpuUsec: 1000 } : null, credits: null, containerPricing: { configVersion: "fixture", size: { vcpu: size.vcpu, memory_gib: size.memory_gib, disk_gb: size.disk_gb }, prices: config.prices } };
    const settlement = { version: 7, state: "waiting", pendingConsumptionKeys: [key], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: false };
    const add = vi.spyOn(Queue.prototype, "add").mockImplementationOnce(async () => {
      await sql`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output)
        VALUES (${stepId},${body.analysisRunId},0,'container_job','analysis-fixture',${state === "known" ? "done" : "submitted"},${sql.json({ miniToolConsumption: consumption })})`;
      await sql`UPDATE tasks SET result=result || ${sql.json({ settlement })} WHERE id=${body.analysisRunId}`;
      throw new Error("fixture_queue_acknowledgement_failed_after_submission");
    });
    try {
      const record = await accepted(await post(body, fixture.ownerCookie));
      expect(record).toMatchObject({ status: "failed", result: null, error: { code: "internal" } });
      const [hold] = await sql<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${body.analysisRunId}`;
      expect(hold).toEqual({ status: "held" });
      const [task] = await sql<{ status: string; result: unknown }[]>`SELECT status,result FROM tasks WHERE id=${body.analysisRunId}`;
      expect(task).toEqual({ status: "failed", result: { analysis: record, settlement } });
      const [step] = await sql<{ output: unknown }[]>`SELECT output FROM task_upstream_steps WHERE id=${stepId}`;
      expect(step).toEqual({ output: { miniToolConsumption: consumption } });
      expect(await accepted(await post(body, fixture.ownerCookie))).toEqual(record);
      expect(add).toHaveBeenCalledTimes(1);
    } finally { add.mockRestore(); }
  });
});

describe("analysis tool input and pins (inner#1306 §90 E4-2; design §7.11 分析受理, §7.15 analysis 行)", () => {
  /**
   * Live analysis pins of a run with their keys.
   * @param runId - The analysis run.
   * @returns Rows.
   */
  async function livePins(runId: string): Promise<{ holder_kind: string; tool_input_id: string; keys: string[] }[]> {
    return sql`SELECT p.holder_kind,p.tool_input_id,coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL),'{}') AS keys
      FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
      WHERE p.holder_id=${runId} AND p.deleted_at IS NULL GROUP BY p.id`;
  }

  it("AP01 an accepted analysis pins its tool input's edit file in the admission", async () => {
    const fixture = await seed({ edit: true });
    const body = requestFor(fixture);
    await accepted(await post(body, fixture.ownerCookie));
    const t = body.presentationRef.source.toolInputId;
    expect(await livePins(body.analysisRunId)).toEqual([{ holder_kind: "analysis", tool_input_id: t, keys: [editKeyOf(fixture.sourceKey)] }]);
  });

  it("AP02 a request without its tool input is refused as request shape with no effect", async () => {
    const fixture = await seed();
    const { presentationRef: _dropped, ...body } = requestFor(fixture);
    const response = await post(body, fixture.ownerCookie);
    // The route's validate() answers a structural refusal as 422 with reason request_shape (as for an unknown field).
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { reason?: string } }).error.reason).toBe("request_shape");
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
  });

  it("AP03 a tool input that is not the selected version's is refused with no effect and no pin", async () => {
    const fixture = await seed();
    const body = requestFor(fixture, "scene_cuts");
    body.presentationRef = { source: { ...body.presentationRef.source, toolInputId: "f".repeat(64) } };
    expect((await post(body, fixture.ownerCookie)).ok).toBe(false);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
    expect(await livePins(body.analysisRunId)).toEqual([]);
  });

  it("AP04 a source with no selected version is refused with no effect and no pin", async () => {
    const fixture = await seed();
    (outside.snapshots.get(fixture.sourceKey) as { presentation: unknown }).presentation = null;
    const body = requestFor(fixture, "scene_cuts");
    expect((await post(body, fixture.ownerCookie)).ok).toBe(false);
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
    expect(await livePins(body.analysisRunId)).toEqual([]);
  });

  it.each(["completed", "failed"] as const)("AP05 an analysis that becomes %s releases its pin and registers the keys nothing else pins", async (end) => {
    const fixture = await seed({ edit: true });
    const body = requestFor(fixture);
    const pending = await accepted(await post(body, fixture.ownerCookie));
    if (end === "completed") {
      const [row] = await sql<{ accepted_at: string }[]>`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at FROM tasks WHERE id=${body.analysisRunId}`;
      await miniToolAnalysisService.finishMiniToolAnalysis(body.analysisRunId, { kind: "result", result: completedPeople(pending, row!.accepted_at).result });
    } else {
      await miniToolAnalysisService.finishMiniToolAnalysis(body.analysisRunId, { kind: "error", error: { code: "analysis_failed" } });
    }
    expect(await livePins(body.analysisRunId)).toEqual([]);
    const editKey = editKeyOf(fixture.sourceKey);
    const queued = await sql<{ storage_key: string; kind: string; kept_storage_key: string | null }[]>`SELECT storage_key,kind,kept_storage_key FROM storage_reclaim_queue WHERE storage_key=${editKey}`;
    // A presentation-derived object is registered with its canonical key (frames-split §7.15).
    expect([...queued]).toEqual([{ storage_key: editKey, kind: "derived", kept_storage_key: fixture.sourceKey }]);
  });
});

// Execution design §10.2, §10.4 and §10.8: tracking an erase selection is checked again at admission, each refusal with its
// reason and no effect, and it is quoted per tracking clip.
describe("tracked mask admission checks (execution design §10.2–§10.4)", () => {
  /**
   * A tracked mask request over a range with an anchor.
   * @param fixture - The registered source.
   * @param range - The range in seconds, sent as frames of the 200 fps fixture grid.
   * @param range.start - Its start.
   * @param range.end - Its end.
   * @param anchorFrame - The anchor's presentation frame on the 200 fps fixture.
   * @returns The request.
   */
  function tracked(fixture: AnalysisFixture, range: { start: number; end: number }, anchorFrame: number): AnalysisRequest {
    const body = requestFor(fixture, "tracked_mask");
    return { ...body, params: { ...body.params, range: { start: Math.round(range.start * 200), end: Math.round(range.end * 200) }, anchor: { frameIndex: anchorFrame } } };
  }

  /**
   * Require a 400 refusal with its message and no durable effect.
   * @param fixture - The fixture.
   * @param body - The request.
   * @param key - The message key.
   * @param params - Its ICU values.
   * @returns Nothing.
   */
  async function refused(fixture: AnalysisFixture, body: AnalysisRequest, key: string, params?: Record<string, number>): Promise<void> {
    const response = await post(body, fixture.ownerCookie);
    const json = await response.json() as { error?: { message?: string } };
    expect({ status: response.status, message: json.error?.message }).toEqual({ status: 400, message: sharedT(key, params) });
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
  }

  /**
   * The credits an accepted analysis holds.
   * @param runId - The analysis.
   * @returns The held amount.
   */
  async function held(runId: string): Promise<number> {
    const [row] = await sql<{ amount: string }[]>`SELECT amount FROM credit_holds WHERE reference_id=${runId}`;
    return Number(row?.amount);
  }

  it("TQ01 refuses an anchor outside the range", async () => {
    const fixture = await seed();
    await refused(fixture, tracked(fixture, { start: 1, end: 3 }, 700), "server.mini_tool.anchorOutsideRange");
  });

  it("TQ02 refuses a range whose model grid lasts longer than 5 s or under 1 s", async () => {
    const fixture = await seed();
    await refused(fixture, tracked(fixture, { start: 0, end: 5.055 }, 0), "server.mini_tool.eraseRange", { min: 1, max: 5 });
    await refused(fixture, tracked(fixture, { start: 0, end: 0.9 }, 0), "server.mini_tool.eraseRange", { min: 1, max: 5 });
  });

  it("TQ03 refuses a transparent source", async () => {
    const fixture = await seed({ transparent: true });
    await refused(fixture, tracked(fixture, { start: 1, end: 3 }, 200), "server.mini_tool.transparentSource");
  });

  it("TQ04 quotes an anchor inside the range as two clips, each at the tracker's own floor", async () => {
    const fixture = await seed();
    const first = tracked(fixture, { start: 0, end: 5 }, 0);
    const middle = tracked(fixture, { start: 0, end: 5 }, 500);
    await accepted(await post(first, fixture.ownerCookie));
    await accepted(await post(middle, fixture.ownerCookie));
    // One 5 s clip against two 2.5 s clips, each priced at least the tracker's 3 s floor, plus a second preparation.
    expect(await held(middle.analysisRunId)).toBeGreaterThan(await held(first.analysisRunId));
  });

  /**
   * Quotes an analysis request through the real app.
   * @param body - The request the press would send.
   * @param cookie - The actor's session.
   * @returns The HTTP response.
   */
  async function quote(body: unknown, cookie: string): Promise<Response> {
    return app.request("/api/v1/mini-tools/analyses/quote", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  }

  // Canvas design §4 erase row: the estimate beside "Track selection" is the server's quote of the request the press sends.
  it("TQ05 quotes exactly what admitting the same request holds, and writes nothing", async () => {
    const fixture = await seed();
    const body = tracked(fixture, { start: 0, end: 5 }, 500);
    const response = await quote(body, fixture.ownerCookie);
    expect(response.status, await response.clone().text()).toBe(200);
    const { data } = await response.json() as { data: { credits: number } };
    expect(await counts(body.analysisRunId)).toEqual({ tasks: 0, rows: 0, holds: 0 });
    await accepted(await post(body, fixture.ownerCookie));
    expect(data.credits).toBe(await held(body.analysisRunId));
  });

  it("TQ06 refuses a quote as admission would refuse the request", async () => {
    const fixture = await seed();
    const response = await quote(tracked(fixture, { start: 1, end: 3 }, 700), fixture.ownerCookie);
    const json = await response.json() as { error?: { message?: string } };
    expect({ status: response.status, message: json.error?.message }).toEqual({ status: 400, message: sharedT("server.mini_tool.anchorOutsideRange") });
  });

  // Canvas design §4 erase row: once tracking is billed, the same place shows what it used; GET carries it as `usage`.
  it("TQ07 reads a billed analysis with the credits it was charged as its usage", async () => {
    const fixture = await seed();
    const body = tracked(fixture, { start: 0, end: 5 }, 0);
    const record = await accepted(await post(body, fixture.ownerCookie));
    expect(record.usage).toEqual([]);
    await sql`UPDATE tasks SET billed_credits = 6.25, billed_at = now() WHERE id = ${body.analysisRunId}`;
    expect((await reading(await get(body.analysisRunId, fixture.ownerCookie))).usage).toEqual([{ credits: 6.25 }]);
  });
});
