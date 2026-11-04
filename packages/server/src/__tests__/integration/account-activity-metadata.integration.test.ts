// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import type { Hono } from "hono";
import { initCore, loadLocales, projectEditsRepo } from "@breatic/core";
import { activityRows, rejectActivityWrites, seedActivityProject, seedActivityUser } from "./helpers/account-activity-fixture.js";
import type { ActivityProject } from "./helpers/account-activity-fixture.js";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: () => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

initCore(process.env);
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 5, prepare: false });
  app = (await import("@server/app.js")).createApp();
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Register a real image ledger row in the fixture's Studio.
 * @param project - The image's Studio and producer.
 * @returns Its id and URL.
 * @throws {Error} When the asset fixture insert fails.
 */
async function imageAsset(project: ActivityProject): Promise<{ id: string; url: string }> {
  const hash = randomBytes(32).toString("hex");
  const url = `https://assets.test.invalid/${hash}.jpg`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
    VALUES (${project.studioId}, ${hash}, ${`image/${hash}.jpg`}, ${url}, 100, 'image/jpeg', 'image', 'upload', ${project.userId}) RETURNING id
  `;
  if (!row) throw new Error("activity image fixture was not inserted");
  return { id: row.id, url };
}

/**
 * Send a real metadata update or cover selection.
 * @param project - The real caller and Project.
 * @param mode - Which metadata entry is exercised.
 * @param assetId - Existing Studio image id for cover mode.
 * @returns The actual Hono response.
 * @throws {Error} When the request cannot run.
 */
async function writeMetadata(project: ActivityProject, mode: "update" | "cover", assetId?: string): Promise<Response> {
  return app.request(`/api/v1/projects/${project.projectId}${mode === "cover" ? "/cover" : ""}`, {
    method: mode === "cover" ? "PUT" : "PATCH",
    headers: { Cookie: project.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(mode === "cover" ? { asset_id: assetId } : { name: "Updated activity Project", description: "A changed description" }),
  });
}

describe("Project metadata and durable user activity (inner#1893)", () => {
  for (const mode of ["update", "cover"] as const) {
    it(`P10 commits ${mode}, its last-edit record and one attributed activity`, async () => {
      const project = await seedActivityProject(sql);
      const image = mode === "cover" ? await imageAsset(project) : undefined;
      expect((await writeMetadata(project, mode, image?.id)).status).toBe(200);
      const events = await activityRows(sql, project.userId);
      expect(events.map((row) => ({ kind: row.kind, project: row.project_id, actor: row.user_id }))).toEqual([
        { kind: "project_edit", project: project.projectId, actor: project.userId },
      ]);
      const [row] = await sql<{ name: string; thumbnail_url: string | null; edited: boolean }[]>`
        SELECT p.name, p.thumbnail_url, EXISTS(SELECT 1 FROM project_edits e WHERE e.project_id = p.id) AS edited
        FROM projects p WHERE p.id = ${project.projectId}
      `;
      expect(row?.edited).toBe(true);
      if (mode === "cover") expect(row?.thumbnail_url).toBe(image!.url);
      else expect(row?.name).toBe("Updated activity Project");
    });

    it(`P10 rolls ${mode} and last-edit state back when activity append fails`, async () => {
      const project = await seedActivityProject(sql);
      const image = mode === "cover" ? await imageAsset(project) : undefined;
      const [before] = await sql<{ name: string; thumbnail_url: string | null; updated_at: string }[]>`
        SELECT name, thumbnail_url, updated_at::text FROM projects WHERE id = ${project.projectId}
      `;
      const restore = await rejectActivityWrites(sql, project.userId);
      try {
        expect((await writeMetadata(project, mode, image?.id)).status).toBe(500);
        const [after] = await sql<{ name: string; thumbnail_url: string | null; updated_at: string }[]>`
          SELECT name, thumbnail_url, updated_at::text FROM projects WHERE id = ${project.projectId}
        `;
        expect(after).toEqual(before);
        const edits = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM project_edits WHERE project_id = ${project.projectId}`;
        expect(edits[0]?.count).toBe(0);
        expect(await activityRows(sql, project.userId)).toEqual([]);
      } finally {
        await restore();
      }
    });

    it(`P10 keeps archived Project ${mode} refusal free of new activity`, async () => {
      const project = await seedActivityProject(sql);
      const image = mode === "cover" ? await imageAsset(project) : undefined;
      await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${project.userId} WHERE id = ${project.projectId}`;
      expect((await writeMetadata(project, mode, image?.id)).status).toBe(409);
      expect(await activityRows(sql, project.userId)).toEqual([]);
    });
  }

  it("P10 attributes a permitted manager's edit to the actor, retaining the historical creator", async () => {
    const project = await seedActivityProject(sql);
    const manager = await seedActivityUser(sql);
    await sql`UPDATE studio_members SET role = 'guest' WHERE studio_id = ${project.studioId} AND user_id = ${project.userId}`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${project.studioId}, ${manager.userId}, 'admin')`;
    expect((await writeMetadata({ ...project, ...manager }, "update")).status).toBe(200);
    expect((await activityRows(sql, manager.userId)).map((row) => ({ kind: row.kind, project: row.project_id }))).toEqual([{ kind: "project_edit", project: project.projectId }]);
    expect(await activityRows(sql, project.userId)).toEqual([]);
    const [row] = await sql<{ created_by_user_id: string }[]>`SELECT created_by_user_id FROM projects WHERE id = ${project.projectId}`;
    expect(row?.created_by_user_id).toBe(project.userId);
  });

  it("P21 keeps automatic last-edit maintenance independent from user activity", async () => {
    const project = await seedActivityProject(sql);
    await projectEditsRepo.touchProjectEdit(project.projectId);
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM project_edits WHERE project_id = ${project.projectId}`;
    expect(row?.count).toBe(1);
    expect(await activityRows(sql, project.userId)).toEqual([]);
  });
});
