// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A copy is being copied until collab has copied its documents (inner#1706 design 5.1, 5.2, acceptance 3) — real
 * Postgres.
 *
 * The duplicate request writes which Project the copy came from and leaves its completion empty, so the copy reads as
 * being copied; collab fills the completion in. A Project that is still being copied cannot itself be copied: the
 * request is refused with a sentence the user reads in a toast. The Studio's project list and the Project page say
 * whether each Project is being copied. A copy takes the source's content and none of its running work: its 3D Space,
 * which keeps the source Space's id, lists no task. A Project that never was a copy, which is every Project made before this
 * change, reads as not being copied.
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

import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { initCore, loadLocales } from "@breatic/core";
import { projectService } from "@server/modules";
import { listSpaceTasks } from "@server/modules/asset/scene-tasks.service.js";
import { getProjectById } from "@server/modules/project/project.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker
}
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A Studio admin with one Project made through the service.
 * @returns The admin and the Project.
 * @throws {Error} When a database write fails.
 */
async function adminWithProject(): Promise<{ admin: string; studioId: string; projectId: string }> {
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`copying-${tag}@example.test`}, true, 'pro') RETURNING id`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`copying-s-${tag}`}, 'team', 'Studio') RETURNING id`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const project = await projectService.create(user!.id, studio!.id, "Storyboard", `copying-p-${tag}`, "canvas");
  return { admin: user!.id, studioId: studio!.id, projectId: project.id };
}

/**
 * Record a copy as completed, as collab does once it has copied the documents.
 * @param projectId - The copy.
 * @returns Nothing.
 * @throws {Error} When the write fails.
 */
async function complete(projectId: string): Promise<void> {
  await sql`UPDATE projects SET duplicate_completed_at = now() WHERE id = ${projectId}`;
}

describe("a copy while it is being copied", () => {
  it("names the Project it was copied from and starts out being copied", async () => {
    const { admin, projectId } = await adminWithProject();

    const copy = await projectService.duplicate(projectId, admin);

    expect(copy.copying).toBe(true);
    const [row] = await sql<{ duplicated_from_id: string | null; duplicate_completed_at: Date | null }[]>`
      SELECT duplicated_from_id, duplicate_completed_at FROM projects WHERE id = ${copy.id}`;
    expect(row).toEqual({ duplicated_from_id: projectId, duplicate_completed_at: null });
  });

  it("reads as no longer being copied once its completion is recorded", async () => {
    const { admin, projectId } = await adminWithProject();
    const copy = await projectService.duplicate(projectId, admin);

    await complete(copy.id);

    expect((await getProjectById(copy.id))?.copying).toBe(false);
  });

  it("refuses to copy a Project that is still being copied, saying so", async () => {
    const { admin, projectId } = await adminWithProject();
    const copy = await projectService.duplicate(projectId, admin);

    await expect(projectService.duplicate(copy.id, admin)).rejects.toMatchObject({
      statusCode: 409,
      message: "This Project is still being copied and can't be copied yet.",
    });
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM projects WHERE duplicated_from_id = ${copy.id}`;
    expect(count!.n).toBe(0);
  });

  it("copies a copy once its completion is recorded", async () => {
    const { admin, projectId } = await adminWithProject();
    const copy = await projectService.duplicate(projectId, admin);
    await complete(copy.id);

    const second = await projectService.duplicate(copy.id, admin);

    expect(second.copying).toBe(true);
    const [row] = await sql<{ duplicated_from_id: string | null }[]>`
      SELECT duplicated_from_id FROM projects WHERE id = ${second.id}`;
    expect(row!.duplicated_from_id).toBe(copy.id);
  });

  it("reads a Project that never was a copy as not being copied", async () => {
    const { projectId } = await adminWithProject();

    const [row] = await sql<{ duplicated_from_id: string | null; duplicate_completed_at: Date | null }[]>`
      SELECT duplicated_from_id, duplicate_completed_at FROM projects WHERE id = ${projectId}`;
    expect(row).toEqual({ duplicated_from_id: null, duplicate_completed_at: null });
    expect((await getProjectById(projectId))?.copying).toBe(false);
  });

  it("is listed in its Studio's project list as being copied until its completion is recorded", async () => {
    const { admin, studioId, projectId } = await adminWithProject();
    const copy = await projectService.duplicate(projectId, admin);
    const copyingById = async (): Promise<Record<string, boolean>> => {
      const { items } = await projectService.listByStudioForViewer(studioId, admin, { archived: false, locale: "en" });
      return Object.fromEntries(items.map((item) => [item.id, item.copying]));
    };

    expect(await copyingById()).toEqual({ [projectId]: false, [copy.id]: true });
    await complete(copy.id);
    expect(await copyingById()).toEqual({ [projectId]: false, [copy.id]: false });
  });

  it("is read by the Project page as being copied until its completion is recorded", async () => {
    const { admin, projectId } = await adminWithProject();
    const copy = await projectService.duplicate(projectId, admin);

    expect((await projectService.loadForViewer(copy.id, admin)).project.copying).toBe(true);
    expect((await projectService.loadForViewer(projectId, admin)).project.copying).toBe(false);
    await complete(copy.id);
    expect((await projectService.loadForViewer(copy.id, admin)).project.copying).toBe(false);
  });

  it("lists none of the source's running 3D tasks in the copy's 3D Space, which keeps the source Space's id", async () => {
    const { admin, projectId } = await adminWithProject();
    const spaceId = randomUUID();
    await sql`
      INSERT INTO node_tasks (project_id, space_id, node_id, kind, action, status, started_by_user_id, budget_ms, label, started_at)
      VALUES (${projectId}, ${spaceId}, NULL, 'upload', 'scene_import', 'running', ${admin}, 7200000, 'lamp.glb', now())`;

    const copy = await projectService.duplicate(projectId, admin);

    expect((await listSpaceTasks(admin, projectId, spaceId)).tasks.map((task) => task.label)).toEqual(["lamp.glb"]);
    expect((await listSpaceTasks(admin, copy.id, spaceId)).tasks).toEqual([]);
  });
});
