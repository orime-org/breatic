// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import type { Hono } from "hono";
import { ingestReportService } from "@breatic/domain";
import { initCore, loadLocales } from "@breatic/core";
import { activityRows, rejectActivityWrites, seedActivityProject } from "./helpers/account-activity-fixture.js";
import type { ActivityProject } from "./helpers/account-activity-fixture.js";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: () => () => false,
  tool: (config: Record<string, unknown>) => config,
}));
// Only the remote ingest opener is substituted; acceptance, grants and sessions are real.
vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

initCore({ ...process.env, PAYMENT_ENABLED: "false", WAVESPEED_API_KEY: "unused_activity_fixture" });
loadLocales();
initConfiguredProvider();
let sql: ReturnType<typeof postgres>;
let app: Hono;
beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 5, prepare: false });
  app = (await import("@server/app.js")).createApp();
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Build a currently supported request for a real task admission route.
 * @param lane - The existing generation entry.
 * @param project - The authenticated owner and destination.
 * @returns Its route and validated input.
 * @throws {Error} When a fixture cannot be constructed.
 */
function taskInput(lane: "canvas" | "understand" | "mini-tool", project: ActivityProject): { path: string; body: Record<string, unknown> } {
  const location = { project_id: project.projectId, space_id: randomUUID() };
  if (lane === "canvas") return {
    path: "/canvas/tasks", body: { ...location, task_type: "image", model: "flux-schnell", mode: "append", params: { prompt: "a tree" } },
  };
  if (lane === "understand") return {
    path: "/canvas/understand", body: { ...location, source_type: "image", source_url: "https://assets.example.test/tree.png", node_ids: [randomUUID()], prompt: "Describe it" },
  };
  return { path: "/mini-tools", body: {
    ...location, tool: "image.expand", source: { url: "https://assets.example.test/tree.png" }, slots: {}, params: {}, prompt: "",
    expand: { image: "https://assets.example.test/padded.png", mask: "https://assets.example.test/mask.png" }, node_ids: [randomUUID()],
  } };
}

/**
 * Send one existing JSON route with a real session and optional stable idempotency key.
 * @param project - The real caller.
 * @param path - The existing endpoint suffix.
 * @param body - The validated request or deliberately malformed input.
 * @param key - The original request identity.
 * @returns The actual HTTP response.
 * @throws {Error} When the request cannot execute.
 */
async function post(project: ActivityProject, path: string, body: Record<string, unknown>, key = randomUUID()): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
  });
}

/**
 * Read all admitted task identities for a fixture account.
 * @param project - The account whose task admission is inspected.
 * @returns Its task ids and project attribution.
 * @throws {Error} When PG cannot answer.
 */
async function tasks(project: ActivityProject): Promise<Array<{ id: string; user_id: string; project_id: string }>> {
  return sql`SELECT id, user_id, project_id FROM tasks WHERE user_id = ${project.userId} ORDER BY created_at,id`;
}

describe("durable activity at real request admission (inner#1893)", () => {
  for (const lane of ["canvas", "understand", "mini-tool"] as const) {
    it(`P11 records one ${lane} admission and preserves the original idempotent replay`, async () => {
      const project = await seedActivityProject(sql);
      const input = taskInput(lane, project);
      const key = randomUUID();
      const response = await post(project, input.path, input.body, key);
      expect(response.status, await response.clone().text()).toBe(201);
      const original = await response.json();
      const admitted = await tasks(project);
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toMatchObject({ user_id: project.userId, project_id: project.projectId });
      const events = await activityRows(sql, project.userId);
      expect(events.map((row) => ({ kind: row.kind, project: row.project_id }))).toEqual([{ kind: "generation_started", project: project.projectId }]);
      const replay = await post(project, input.path, input.body, key);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(original);
      expect(await tasks(project)).toEqual(admitted);
      expect(await activityRows(sql, project.userId)).toEqual(events);
    });

    it(`P11 rolls back ${lane} task admission when its activity insert fails`, async () => {
      const project = await seedActivityProject(sql);
      const input = taskInput(lane, project);
      const restore = await rejectActivityWrites(sql, project.userId);
      try {
        expect((await post(project, input.path, input.body)).status).toBe(500);
        expect(await tasks(project)).toEqual([]);
        expect(await activityRows(sql, project.userId)).toEqual([]);
      } finally { await restore(); }
    });

    it(`P11 leaves no ${lane} task or activity for a valid cross-account request`, async () => {
      const target = await seedActivityProject(sql);
      const stranger = await seedActivityProject(sql);
      const input = taskInput(lane, target);
      expect((await post(stranger, input.path, input.body)).status).toBe(404);
      expect(await tasks(stranger)).toEqual([]);
      expect(await activityRows(sql, stranger.userId)).toEqual([]);
    });
  }

  it("P11 rejects malformed task input before task or activity admission", async () => {
    const project = await seedActivityProject(sql);
    expect((await post(project, "/canvas/tasks", { project_id: project.projectId })).status).toBe(422);
    expect(await tasks(project)).toEqual([]);
    expect(await activityRows(sql, project.userId)).toEqual([]);
  });

  it("P13 records upload acceptance using the real server account and Project", async () => {
    const project = await seedActivityProject(sql);
    const before = Date.now();
    const response = await post(project, "/assets/upload-ticket", {
      project_id: project.projectId, filename: "tree.jpg", content_type: "image/jpeg", size: 100,
      client_hash: randomBytes(32).toString("hex"), node_id: randomUUID(), space_id: randomUUID(),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const events = await activityRows(sql, project.userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user_id: project.userId, project_id: project.projectId, kind: "project_action" });
    expect(Date.parse(events[0]!.occurred_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(events[0]!.occurred_at)).toBeLessThanOrEqual(Date.now());
  });

  it("P13 rejects another account's upload before activity or grant creation", async () => {
    const project = await seedActivityProject(sql);
    const stranger = await seedActivityProject(sql);
    const response = await post(stranger, "/assets/upload-ticket", {
      project_id: project.projectId, filename: "tree.jpg", content_type: "image/jpeg", size: 100, client_hash: randomBytes(32).toString("hex"),
    });
    expect(response.status).toBe(404);
    expect(await activityRows(sql, stranger.userId)).toEqual([]);
    const rows = await sql`SELECT id FROM upload_grants WHERE user_id = ${stranger.userId}`;
    expect(rows).toEqual([]);
  });

  for (const action of ["archive", "restore"] as const) {
    it(`P12 records interactive Project ${action} as its caller`, async () => {
      const project = await seedActivityProject(sql);
      if (action === "restore") await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${project.userId} WHERE id = ${project.projectId}`;
      expect((await post(project, `/projects/${project.projectId}/${action}`, {})).status).toBe(200);
      expect((await activityRows(sql, project.userId)).map((row) => ({ kind: row.kind, project: row.project_id }))).toEqual([{ kind: "project_action", project: project.projectId }]);
    });

    it(`P12 preserves Project ${action} state when same-transaction activity fails`, async () => {
      const project = await seedActivityProject(sql);
      if (action === "restore") await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${project.userId} WHERE id = ${project.projectId}`;
      const [before] = await sql`SELECT archived_at::text, archived_by_user_id FROM projects WHERE id = ${project.projectId}`;
      const restore = await rejectActivityWrites(sql, project.userId);
      try {
        expect((await post(project, `/projects/${project.projectId}/${action}`, {})).status).toBe(500);
        const [after] = await sql`SELECT archived_at::text, archived_by_user_id FROM projects WHERE id = ${project.projectId}`;
        expect(after).toEqual(before);
        expect(await activityRows(sql, project.userId)).toEqual([]);
      } finally { await restore(); }
    });
  }

  it("P13/P21 preserves the upload acceptance instant when ingest completes and replays later", async () => {
    const project = await seedActivityProject(sql);
    const response = await post(project, "/assets/upload-ticket", {
      project_id: project.projectId, filename: "later.jpg", content_type: "image/jpeg", size: 100,
      client_hash: randomBytes(32).toString("hex"), node_id: randomUUID(), space_id: randomUUID(),
    });
    expect(response.status).toBe(201);
    const key = ((await response.json()) as { data: { storageKey: string } }).data.storageKey;
    // The worker may finish on another date: its real actor is not a new visit.
    await sql`UPDATE account_activity_events SET occurred_at='2026-10-31T23:59:59.987654Z' WHERE user_id=${project.userId}`;
    const original = await activityRows(sql, project.userId);
    expect(original).toHaveLength(1);
    const report = { storageKey: key, outcome: "completed" as const, sha256: randomBytes(32).toString("hex"), sizeBytes: 100, contentType: "image/jpeg" };
    const outcome = await ingestReportService.applyIngestReport(report);
    expect(outcome.status).toBe("registered");
    expect(await activityRows(sql, project.userId)).toEqual(original);
    const [asset] = await sql`SELECT id FROM studio_assets WHERE studio_id=${project.studioId} AND content_hash=${report.sha256}`;
    expect(asset).toBeDefined();
    await ingestReportService.applyIngestReport(report);
    expect(await activityRows(sql, project.userId)).toEqual(original);
  });

  it("P13 records a deduplicated upload request even when no bytes or new grant are needed", async () => {
    const project = await seedActivityProject(sql);
    const hash = randomBytes(32).toString("hex");
    await sql`INSERT INTO studio_assets(studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id)
      VALUES(${project.studioId},${hash},${`image/${hash}.jpg`},${`https://assets.example.test/${hash}.jpg`},100,'image/jpeg','image','upload',${project.userId})`;
    const response = await post(project, "/assets/upload-ticket", {
      project_id: project.projectId, filename: "same.jpg", content_type: "image/jpeg", size: 100, client_hash: hash,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.alreadyExists).toBe(true);
    expect((await activityRows(sql, project.userId)).map((row) => row.kind)).toEqual(["project_action"]);
    const rows = await sql`SELECT id FROM upload_grants WHERE user_id=${project.userId}`;
    expect(rows).toEqual([]);
  });

  for (const entry of ["url", "paste", "deleted", "batch"] as const) {
    it(`P13 records one accepted ${entry} request under its real actor`, async () => {
      const project = await seedActivityProject(sql);
      const common = { project_id: project.projectId, space_id: randomUUID() };
      const path = entry === "url" ? "/canvas/ingest-url" : entry === "paste" ? "/canvas/paste" : entry === "deleted" ? "/assets/deleted" : "/assets/upload-ticket";
      const body = entry === "url" ? { ...common, node_id: randomUUID(), url: "https://assets.example.test/tree.jpg" }
        : entry === "paste" ? { project_id: project.projectId, urls: [], pairs: [], history: [{ node_id: randomUUID(), kind: "text", content: "copied text" }] }
        : entry === "deleted" ? { project_id: project.projectId, entries: [{ file_url: "https://assets.example.test/tree.jpg", kind: "image" }] }
        : { ...common, source: "mini_tool", tool_name: "image.grid", items: [1,2].map(() => ({ filename: "tile.jpg", content_type: "image/jpeg", size: 100, client_hash: randomBytes(32).toString("hex"), node_id: randomUUID() })) };
      const response = await post(project, path, body);
      expect(response.status, await response.clone().text()).toBe(entry === "url" ? 201 : 200);
      const rows = await activityRows(sql, project.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: project.userId, project_id: project.projectId, kind: "project_action" });
    });
  }

});
