// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D generation whose optional rig step failed (inner#1692, design 6.2 and
 * 7.1): its Space row ends done with the generated model and
 * `notice = 'rig_failed'`, and the Space's task list hands the notice out.
 *
 * The migration adds `node_tasks.notice` (nullable, only `rig_failed`) and the
 * `rig` step kind; both constraints are read from the database the migration
 * produced. Rows are written straight into the tables, so no queue or
 * worker is involved; the `ai` module is stubbed as in the other server
 * integration suites.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import { sceneTaskService } from "@breatic/domain";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "three-d-rig-notice-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

interface Seeded {
  userId: string;
  cookie: string;
  studioId: string;
  projectId: string;
  spaceId: string;
}

/**
 * An owner with a personal studio, a project in it and a 3D Space id.
 * @returns The ids and the owner's session cookie.
 */
async function seedProject(): Promise<Seeded> {
  const tag = crypto.randomBytes(8).toString("hex");
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`rig-${tag}@example.com`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${`rig-s-${tag}`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${userId}, ${`rig-p-${tag}`}, ${`rig-p-${tag}`}) RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${userId}, 'owner', null)`;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, cookie: `${sessionCookieName()}=${token}`, studioId: studio!.id, projectId: project!.id, spaceId: crypto.randomUUID() };
}

/**
 * A registered GLB in the studio, referenced by the project.
 * @param s - Whose studio and project.
 * @returns Its id and address.
 */
async function seedModel(s: Seeded): Promise<{ assetId: string; url: string }> {
  const hash = crypto.randomBytes(32).toString("hex");
  const storageKey = `file/2026-11-08/${hash}.glb`;
  const url = `https://assets.example/${storageKey}`;
  const [asset] = await sql<{ id: string }[]>`
    INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
    VALUES (${s.studioId}, ${hash}, ${storageKey}, ${url}, 4096, 'model/gltf-binary', 'file', 'upload', ${s.userId})
    RETURNING id
  `;
  await sql`INSERT INTO project_asset_refs (project_id, asset_id, display_name) VALUES (${s.projectId}, ${asset!.id}, 'knight.glb')`;
  return { assetId: asset!.id, url };
}

/**
 * A running 3D generation: its task and its Space row.
 * @param s - Where.
 * @returns The task id and the row id.
 */
async function seedGeneration(s: Seeded): Promise<{ taskId: string; rowId: string }> {
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, model, params)
    VALUES (${s.userId}, ${s.projectId}, ${s.spaceId}, 'three_d', 'append', 'tripo-h3.1-t23d', ${sql.json({ prompt: "a knight", rig_skeleton: true })})
    RETURNING id
  `;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO node_tasks (project_id, space_id, node_id, kind, action, status, started_by_user_id, budget_ms, label, task_id, origin)
    VALUES (${s.projectId}, ${s.spaceId}, null, 'generation', 'generate', 'running', ${s.userId}, 7200000, 'a knight', ${task!.id}, 'space')
    RETURNING id
  `;
  return { taskId: task!.id, rowId: row!.id };
}

/**
 * One row's stored notice, status and model.
 * @param rowId - The row.
 * @returns Them.
 */
async function rowOf(rowId: string): Promise<{ status: string; asset_id: string | null; notice: string | null }> {
  const [row] = await sql<{ status: string; asset_id: string | null; notice: string | null }[]>`
    SELECT status, asset_id, notice FROM node_tasks WHERE id = ${rowId}
  `;
  return row!;
}

/**
 * Push a row past its deadline and record it expired, as the harvest leaves it.
 * @param rowId - The row.
 */
async function expireRow(rowId: string): Promise<void> {
  await sql`
    UPDATE node_tasks SET status = 'expired', error_message = 'expired', settled_at = now(),
      started_at = now() - (budget_ms + 60000) * interval '1 millisecond'
    WHERE id = ${rowId}
  `;
}

describe("the migration (inner#1692)", () => {
  it("adds node_tasks.notice as a nullable column of 24 characters", async () => {
    const [column] = await sql<{ is_nullable: string; data_type: string; character_maximum_length: number | null }[]>`
      SELECT is_nullable, data_type, character_maximum_length FROM information_schema.columns
      WHERE table_name = 'node_tasks' AND column_name = 'notice'
    `;
    expect(column).toEqual({ is_nullable: "YES", data_type: "character varying", character_maximum_length: 24 });
  });

  it("lets a row hold no notice or rig_failed, and refuses any other notice", async () => {
    const s = await seedProject();
    const { rowId } = await seedGeneration(s);
    expect((await rowOf(rowId)).notice).toBeNull();

    await sql`UPDATE node_tasks SET notice = 'rig_failed' WHERE id = ${rowId}`;
    expect((await rowOf(rowId)).notice).toBe("rig_failed");

    for (const other of ["rigged", "", "RIG_FAILED"]) {
      await expect(sql`UPDATE node_tasks SET notice = ${other} WHERE id = ${rowId}`).rejects.toMatchObject({ code: "23514" });
    }
    await sql`UPDATE node_tasks SET notice = null WHERE id = ${rowId}`;
    expect((await rowOf(rowId)).notice).toBeNull();
  });

  it("takes a rig step, keeps the step kinds it took before, and refuses an unknown kind", async () => {
    const s = await seedProject();
    const { taskId } = await seedGeneration(s);

    await expect(
      sql`INSERT INTO task_upstream_steps (task_id, position, kind, endpoint) VALUES (${taskId}, 0, 'generate', 'tripo3d/h3.1/text-to-3d')`,
    ).resolves.toBeDefined();
    await expect(
      sql`INSERT INTO task_upstream_steps (task_id, position, kind, endpoint) VALUES (${taskId}, 1, 'rig', 'tripo3d/rig')`,
    ).resolves.toBeDefined();
    await expect(
      sql`INSERT INTO task_upstream_steps (task_id, position, kind, endpoint) VALUES (${taskId}, 2, 'rigging', 'tripo3d/rig')`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "task_upstream_steps_kind_check" });
  });
});

describe("settling a generation whose rig failed (inner#1692)", () => {
  it("moves a running row to done with the model and the notice", async () => {
    const s = await seedProject();
    const { rowId } = await seedGeneration(s);
    const model = await seedModel(s);

    await sceneTaskService.settleById(rowId, { outcome: "done", assetId: model.assetId, notice: "rig_failed" });

    expect(await rowOf(rowId)).toEqual({ status: "done", asset_id: model.assetId, notice: "rig_failed" });
  });

  it("leaves no notice on a model that was rigged", async () => {
    const s = await seedProject();
    const { rowId } = await seedGeneration(s);
    const model = await seedModel(s);

    await sceneTaskService.settleById(rowId, { outcome: "done", assetId: model.assetId, notice: null });

    expect(await rowOf(rowId)).toEqual({ status: "done", asset_id: model.assetId, notice: null });
  });

  it("writes the notice with a model that arrives after the row expired", async () => {
    const s = await seedProject();
    const { rowId } = await seedGeneration(s);
    await expireRow(rowId);
    const model = await seedModel(s);

    await sceneTaskService.settleById(rowId, { outcome: "done", assetId: model.assetId, notice: "rig_failed" });

    expect(await rowOf(rowId)).toEqual({ status: "expired", asset_id: model.assetId, notice: "rig_failed" });
  });

  it("writes the notice when checking a timed-out row finds the run charged with a result", async () => {
    const s = await seedProject();
    const { taskId, rowId } = await seedGeneration(s);
    await expireRow(rowId);
    const model = await seedModel(s);
    await sql`
      UPDATE tasks SET status = 'completed', billed_at = now(), completed_at = now(),
        result = ${sql.json({ notice: "rig_failed", outputs: [{ url: model.url, asset_id: model.assetId }] })}
      WHERE id = ${taskId}
    `;

    const res = await app.request(`/api/v1/projects/${s.projectId}/three-d/${s.spaceId}/tasks/${rowId}/check`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: s.cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: "has_result" } });
    expect(await rowOf(rowId)).toEqual({ status: "expired", asset_id: model.assetId, notice: "rig_failed" });
  });
});

describe("the Space's task list (inner#1692)", () => {
  it("hands out each row's notice", async () => {
    const s = await seedProject();
    const failedRig = await seedGeneration(s);
    const rigged = await seedGeneration(s);
    const running = await seedGeneration(s);
    const importRow = await sceneTaskService.open({
      projectId: s.projectId, spaceId: s.spaceId, startedByUserId: s.userId, budgetMs: 7_200_000, label: "Barn lamp", storageKey: `file/${crypto.randomUUID()}.glb`,
    });
    const model = await seedModel(s);
    await sceneTaskService.settleById(failedRig.rowId, { outcome: "done", assetId: model.assetId, notice: "rig_failed" });
    await sceneTaskService.settleById(rigged.rowId, { outcome: "done", assetId: model.assetId, notice: null });

    const res = await app.request(`/api/v1/projects/${s.projectId}/three-d/${s.spaceId}/tasks`, { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { tasks: Array<{ id: string; notice?: unknown; params?: Record<string, unknown> }> } };
    const byId = new Map(data.tasks.map((task) => [task.id, task]));

    expect(byId.get(failedRig.rowId)).toMatchObject({ notice: "rig_failed", params: { rig_skeleton: true } });
    expect(byId.get(rigged.rowId)).toMatchObject({ notice: null, params: { rig_skeleton: true } });
    expect(byId.get(running.rowId)).toMatchObject({ notice: null });
    expect(byId.get(importRow)).toMatchObject({ notice: null });
  });
});
