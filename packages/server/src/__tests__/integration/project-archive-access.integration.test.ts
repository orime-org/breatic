// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Archived projects are read-only through one choke point.
 *
 * `loadProjectRole` is what every write gate reads (server `requireRole`,
 * `assertAccess`, collab `onAuthenticate`); on an archived project it caps
 * the role at viewer. `loadProjectAccess` is what the project page reads; it
 * keeps the real role and reports the archive. `lockLiveProject` is what every
 * path that hangs a request row off a project takes first; it refuses an
 * archived project as it refuses a deleted one.
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

import postgres from "postgres";
import { db, initCore, projectAuthService } from "@breatic/core";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as projectService from "@server/modules/project/project.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "project-archive-access-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a fresh user; returns its id. */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`archive-access-${seq++}@example.com`}, true)
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Insert a team studio with `adminId` as its admin; returns its id. */
async function insertStudio(adminId: string): Promise<string> {
  const slug = `archive-access-studio-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId}, ${slug}, 'team', ${slug})
    RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${rows[0]!.id}, ${adminId}, 'admin')`;
  return rows[0]!.id;
}

/** Insert a project owned by `ownerId`; returns its id. */
async function insertProject(studioId: string, ownerId: string): Promise<string> {
  const slug = `archive-access-project-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${ownerId}, ${slug}, ${slug})
    RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${rows[0]!.id}, ${ownerId}, 'owner', null)
  `;
  return rows[0]!.id;
}

/** Add a non-owner member. */
async function addMember(projectId: string, userId: string, role: "editor" | "viewer"): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, ${role}, null)
  `;
}

/** Mark a project archived by `byUserId`. */
async function archive(projectId: string, byUserId: string): Promise<void> {
  await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${byUserId} WHERE id = ${projectId}`;
}

describe("projects archive columns", () => {
  it("are null on a new project", async () => {
    const owner = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    const rows = await sql<{ archived_at: Date | null; archived_by_user_id: string | null }[]>`
      SELECT archived_at, archived_by_user_id FROM projects WHERE id = ${projectId}
    `;
    expect(rows[0]).toEqual({ archived_at: null, archived_by_user_id: null });
  });

  it("reject an archive time without who archived it, and the reverse", async () => {
    const owner = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    await expect(sql`UPDATE projects SET archived_at = now() WHERE id = ${projectId}`).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      sql`UPDATE projects SET archived_by_user_id = ${owner} WHERE id = ${projectId}`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("loadProjectRole caps an archived project at viewer", () => {
  it("returns the real role on a live project", async () => {
    const owner = await insertUser();
    const editor = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    await addMember(projectId, editor, "editor");
    expect(await projectAuthService.loadProjectRole(owner, projectId)).toBe("owner");
    expect(await projectAuthService.loadProjectRole(editor, projectId)).toBe("editor");
  });

  it("returns viewer for every member of an archived project, and null for a non-member", async () => {
    const owner = await insertUser();
    const editor = await insertUser();
    const viewer = await insertUser();
    const outsider = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    await addMember(projectId, editor, "editor");
    await addMember(projectId, viewer, "viewer");
    await archive(projectId, owner);
    expect(await projectAuthService.loadProjectRole(owner, projectId)).toBe("viewer");
    expect(await projectAuthService.loadProjectRole(editor, projectId)).toBe("viewer");
    expect(await projectAuthService.loadProjectRole(viewer, projectId)).toBe("viewer");
    expect(await projectAuthService.loadProjectRole(outsider, projectId)).toBeNull();
  });
});

describe("loadProjectAccess keeps the real role and reports the archive", () => {
  it("answers the real role with archived false on a live project", async () => {
    const owner = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    expect(await projectAuthService.loadProjectAccess(owner, projectId)).toEqual({
      role: "owner",
      archived: false,
    });
  });

  it("answers the real role with archived true on an archived project", async () => {
    const owner = await insertUser();
    const editor = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    await addMember(projectId, editor, "editor");
    await archive(projectId, owner);
    expect(await projectAuthService.loadProjectAccess(owner, projectId)).toEqual({
      role: "owner",
      archived: true,
    });
    expect(await projectAuthService.loadProjectAccess(editor, projectId)).toEqual({
      role: "editor",
      archived: true,
    });
  });

  it("answers null for a non-member", async () => {
    const owner = await insertUser();
    const outsider = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    expect(await projectAuthService.loadProjectAccess(outsider, projectId)).toBeNull();
  });
});

describe("loadForViewer on an archived project", () => {
  it("returns the member's real role and the archive time", async () => {
    const owner = await insertUser();
    const projectId = await insertProject(await insertStudio(owner), owner);
    await archive(projectId, owner);
    const { project, myRole } = await projectService.loadForViewer(projectId, owner);
    expect(myRole).toBe("owner");
    expect(project.archivedAt).toBeInstanceOf(Date);
  });
});

describe("lockLiveProject refuses an archived project", () => {
  it("locks a live project and refuses an archived one", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    const live = await insertProject(studioId, owner);
    const archived = await insertProject(studioId, owner);
    await archive(archived, owner);
    await db.transaction(async (tx) => {
      expect(await projectRepo.lockLiveProject(live, tx)).toBe(true);
      expect(await projectRepo.lockLiveProject(archived, tx)).toBe(false);
    });
  });
});
