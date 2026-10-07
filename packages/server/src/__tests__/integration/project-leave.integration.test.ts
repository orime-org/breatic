// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Leaving a project of one's own accord: who the card menu and the project
 * page offer it to, and what `DELETE /projects/:id/membership` does for each
 * caller — through the real Hono app, Postgres and Redis session.
 *
 * The scene has a team studio whose admin is not on the project, an owner,
 * an editor and a viewer who are studio members, a studio guest who is not on
 * the project, and an outside collaborator: on the project, not in the studio.
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
import {
  getRedis,
  initCore,
  loadLocales,
  projectMembersRepo,
  runWithLocale,
  sessionCookieName,
  setSession,
} from "@breatic/core";
import { t } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

import * as projectService from "@server/modules/project/project.service.js";
import * as recentRepo from "@server/modules/recent/recent.repo.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "project-leave-test" },
  });
  // After initCore: the app reads env at module load.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  adminId: string;
  ownerId: string;
  editorId: string;
  viewerId: string;
  guestId: string;
  outsiderId: string;
  studioId: string;
  projectId: string;
}

/**
 * Insert a user.
 * @param tag - Unique email prefix
 * @returns The user id
 */
async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

/**
 * Seed the scene described in the file header.
 * @returns The ids of everyone in it
 */
async function seedScene(): Promise<Scene> {
  const tag = `leave-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const [adminId, ownerId, editorId, viewerId, guestId, outsiderId] = await Promise.all(
    ["admin", "owner", "editor", "viewer", "guest", "outsider"].map((r) => insertUser(`${tag}-${r}`)),
  );
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId!}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role, added_by)
    VALUES (${studio!.id}, ${adminId!}, 'admin', ${adminId!}),
           (${studio!.id}, ${ownerId!}, 'maintainer', ${adminId!}),
           (${studio!.id}, ${editorId!}, 'maintainer', ${adminId!}),
           (${studio!.id}, ${viewerId!}, 'maintainer', ${adminId!}),
           (${studio!.id}, ${guestId!}, 'guest', ${adminId!})
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${ownerId!}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${ownerId!}, 'owner', ${ownerId!}),
           (${project!.id}, ${editorId!}, 'editor', ${ownerId!}),
           (${project!.id}, ${viewerId!}, 'viewer', ${ownerId!}),
           (${project!.id}, ${outsiderId!}, 'viewer', ${ownerId!})
  `;
  return {
    adminId: adminId!,
    ownerId: ownerId!,
    editorId: editorId!,
    viewerId: viewerId!,
    guestId: guestId!,
    outsiderId: outsiderId!,
    studioId: studio!.id,
    projectId: project!.id,
  };
}

/**
 * A session cookie for a user, written to the same Redis store `requireAuth` reads.
 * @param userId - The user to sign in
 * @returns The Cookie header value
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Call the leave route as a user.
 * @param projectId - The project to leave
 * @param userId - The caller
 * @returns The response
 */
async function leaveAs(projectId: string, userId: string): Promise<Response> {
  return app.request(`/api/v1/projects/${projectId}/membership`, {
    method: "DELETE",
    headers: { Cookie: await loginCookie(userId) },
  });
}

describe("who is offered leaving", () => {
  it("the studio card offers it to the editor and the viewer, never the owner, the admin or a non-member", async () => {
    const s = await seedScene();
    const canLeave = async (who: string): Promise<boolean> => {
      const { items: [p] } = await projectService.listByStudioForViewer(s.studioId, who, { archived: false, locale: "en" });
      return p!.canLeave;
    };
    expect(await canLeave(s.editorId)).toBe(true);
    expect(await canLeave(s.viewerId)).toBe(true);
    expect(await canLeave(s.ownerId)).toBe(false);
    expect(await canLeave(s.adminId)).toBe(false);
    expect(await canLeave(s.guestId)).toBe(false);
  });

  it("the project page offers it to every non-owner member, the outside collaborator included, until the project is archived", async () => {
    const s = await seedScene();
    expect((await projectService.loadForViewer(s.projectId, s.editorId)).canLeave).toBe(true);
    expect((await projectService.loadForViewer(s.projectId, s.outsiderId)).canLeave).toBe(true);
    expect((await projectService.loadForViewer(s.projectId, s.ownerId)).canLeave).toBe(false);
    await projectService.archive(s.projectId, s.adminId);
    expect((await projectService.loadForViewer(s.projectId, s.editorId)).canLeave).toBe(false);
  });
});

describe("DELETE /projects/:id/membership", () => {
  it("lets an editor leave, records it as their own act and drops the project from their recent page", async () => {
    const s = await seedScene();
    await sql`
      INSERT INTO project_last_opened (user_id, project_id, last_opened_at)
      VALUES (${s.editorId}, ${s.projectId}, now())
    `;
    const res = await leaveAs(s.projectId, s.editorId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(await projectMembersRepo.getRole(s.projectId, s.editorId)).toBeNull();
    expect(await projectMembersRepo.getRole(s.projectId, s.ownerId)).toBe("owner");
    const [activity] = await sql<{ actor_user_id: string; payload: { targetUserId: string } }[]>`
      SELECT actor_user_id, payload FROM project_activities
      WHERE project_id = ${s.projectId} AND type = 'member:removed'
    `;
    expect(activity!.actor_user_id).toBe(s.editorId);
    expect(activity!.payload.targetUserId).toBe(s.editorId);
    expect((await recentRepo.listRecentForUser(s.editorId, 50)).map((r) => r.projectId)).not.toContain(s.projectId);
  });

  it("lets an outside collaborator leave", async () => {
    const s = await seedScene();
    const res = await leaveAs(s.projectId, s.outsiderId);
    expect(res.status).toBe(200);
    expect(await projectMembersRepo.getRole(s.projectId, s.outsiderId)).toBeNull();
  });

  it("→ 409 for the owner, telling them to transfer first", async () => {
    const s = await seedScene();
    const res = await leaveAs(s.projectId, s.ownerId);
    expect(res.status).toBe(409);
    const sentence = runWithLocale("en", () => t("server.project.leave_owner"));
    expect(JSON.stringify(await res.json())).toContain(sentence);
    expect(await projectMembersRepo.getRole(s.projectId, s.ownerId)).toBe("owner");
  });

  it("→ 409 on an archived project, keeping the member", async () => {
    const s = await seedScene();
    await projectService.archive(s.projectId, s.adminId);
    const res = await leaveAs(s.projectId, s.editorId);
    expect(res.status).toBe(409);
    expect(await projectMembersRepo.getRole(s.projectId, s.editorId)).toBe("editor");
  });

  it("→ 403 for a studio member who is not on the project", async () => {
    const s = await seedScene();
    const res = await leaveAs(s.projectId, s.guestId);
    expect(res.status).toBe(403);
  });
});
