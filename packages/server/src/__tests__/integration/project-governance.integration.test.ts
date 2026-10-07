// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who may rename, re-cover, duplicate, archive and restore a project, and
 * what the Studio's project lists show.
 *
 * Rename and cover belong to the studio admin (on the project or not) and to
 * the project's owner and editors; duplicating needs editor or above on the
 * project; archive and restore are the studio admin's. An archived project
 * takes none of the first three. The card menu reads the same rule through
 * the flags each listed project carries.
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
import { ConflictError, ForbiddenError, initCore, loadLocales, runWithLocale } from "@breatic/core";

initCore(process.env);

import * as projectService from "@server/modules/project/project.service.js";
import * as joinService from "@server/modules/project-join-request/projectJoinRequest.service.js";
import * as recentRepo from "@server/modules/recent/recent.repo.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "project-governance-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  /** Studio admin, not on the project. */
  adminId: string;
  ownerId: string;
  editorId: string;
  viewerId: string;
  /** In the studio, not on the project. */
  guestId: string;
  studioId: string;
  projectId: string;
}

/** Insert a user; returns its id. */
async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

/** A team studio whose admin is not on its one project. */
async function seedScene(): Promise<Scene> {
  const tag = `gov-${seq++}`;
  const [adminId, ownerId, editorId, viewerId, guestId] = await Promise.all(
    ["admin", "owner", "editor", "viewer", "guest"].map((r) => insertUser(`${tag}-${r}`)),
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
           (${project!.id}, ${viewerId!}, 'viewer', ${ownerId!})
  `;
  return {
    adminId: adminId!,
    ownerId: ownerId!,
    editorId: editorId!,
    viewerId: viewerId!,
    guestId: guestId!,
    studioId: studio!.id,
    projectId: project!.id,
  };
}

/** Insert a live image asset in a studio; returns its id. */
async function insertImage(studioId: string, producedBy: string): Promise<string> {
  const hash = `${"a".repeat(56)}${String(seq++).padStart(8, "0")}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
    VALUES
      (${studioId}, ${hash}, ${`image/${hash}.jpg`}, ${`https://cdn.test/image/${hash}.jpg`}, 10,
       'image/jpeg', 'image', 'upload', ${producedBy})
    RETURNING id
  `;
  return row!.id;
}

/** Project name as stored. */
async function nameOf(projectId: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM projects WHERE id = ${projectId}`;
  return row!.name;
}

describe("rename", () => {
  it("is allowed to the studio admin who is not on the project and to the owner", async () => {
    const s = await seedScene();
    for (const who of [s.adminId, s.ownerId]) {
      await projectService.update(s.projectId, who, { name: `by-${who.slice(0, 8)}` });
      expect(await nameOf(s.projectId)).toBe(`by-${who.slice(0, 8)}`);
    }
  });

  it("is refused to an editor, a viewer and a studio member who is not on the project", async () => {
    const s = await seedScene();
    await expect(projectService.update(s.projectId, s.editorId, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectService.update(s.projectId, s.viewerId, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectService.update(s.projectId, s.guestId, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("is refused on an archived project, the studio admin included", async () => {
    const s = await seedScene();
    await projectService.archive(s.projectId, s.adminId);
    await expect(projectService.update(s.projectId, s.adminId, { name: "x" })).rejects.toBeInstanceOf(ConflictError);
    await expect(projectService.update(s.projectId, s.ownerId, { name: "x" })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("change cover", () => {
  it("is allowed to the studio admin who is not on the project and to the owner", async () => {
    const s = await seedScene();
    const image = await insertImage(s.studioId, s.adminId);
    await projectService.setCover(s.projectId, s.adminId, image);
    await projectService.setCover(s.projectId, s.ownerId, image);
  });

  it("is refused to an editor and to a viewer", async () => {
    const s = await seedScene();
    const image = await insertImage(s.studioId, s.adminId);
    await expect(projectService.setCover(s.projectId, s.editorId, image)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectService.setCover(s.projectId, s.viewerId, image)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("is refused on an archived project", async () => {
    const s = await seedScene();
    const image = await insertImage(s.studioId, s.adminId);
    await projectService.archive(s.projectId, s.adminId);
    await expect(projectService.setCover(s.projectId, s.adminId, image)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("duplicate", () => {
  it("tells the owner the project is archived, the same answer a rename gets", async () => {
    const s = await seedScene();
    await projectService.archive(s.projectId, s.adminId);
    await expect(projectService.duplicate(s.projectId, s.ownerId)).rejects.toBeInstanceOf(ConflictError);
    await expect(projectService.duplicate(s.projectId, s.editorId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("names the copy in the reader's language, the copy mark first", async () => {
    const s = await seedScene();
    const en = await runWithLocale("en", () => projectService.duplicate(s.projectId, s.ownerId));
    expect(en.name).toBe(`Copy of ${await nameOf(s.projectId)}`);
    const zh = await runWithLocale("zh-CN", () => projectService.duplicate(s.projectId, s.ownerId));
    expect(zh.name).toBe(`副本 - ${await nameOf(s.projectId)}`);
  });

  it("shortens a name at the length limit so the copy still fits and keeps its mark", async () => {
    const s = await seedScene();
    const long = "名".repeat(255);
    await projectService.update(s.projectId, s.ownerId, { name: long });
    const copy = await runWithLocale("en", () => projectService.duplicate(s.projectId, s.ownerId));
    expect(copy.name.startsWith("Copy of 名")).toBe(true);
    expect(copy.name).toHaveLength(255);
  });

  it("fits a copy of a name made of emoji within what a rename accepts", async () => {
    const s = await seedScene();
    await projectService.update(s.projectId, s.ownerId, { name: "😀".repeat(127) });
    const copy = await runWithLocale("en", () => projectService.duplicate(s.projectId, s.ownerId));
    expect(copy.name.length).toBeLessThanOrEqual(255);
    expect(copy.name.endsWith("😀")).toBe(true);
    await projectService.update(copy.id, s.ownerId, { name: copy.name.slice(0, -2) });
  });

  it("is refused to an editor and to a viewer", async () => {
    const s = await seedScene();
    await expect(projectService.duplicate(s.projectId, s.editorId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectService.duplicate(s.projectId, s.viewerId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gives the copy to whoever made it, alone: the owner, or the studio admin who is not on the project", async () => {
    const s = await seedScene();
    for (const who of [s.ownerId, s.adminId]) {
      const copy = await projectService.duplicate(s.projectId, who);
      const members = await sql<{ user_id: string; role: string }[]>`
        SELECT user_id, role FROM project_members WHERE project_id = ${copy.id} AND deleted_at IS NULL
      `;
      expect(members).toEqual([{ user_id: who, role: "owner" }]);
    }
  });
});

describe("the studio's project lists", () => {
  it("list live projects with the flags each caller's menu shows", async () => {
    const s = await seedScene();
    const flags = async (who: string): Promise<unknown> => {
      const { items: [p] } = await projectService.listByStudioForViewer(s.studioId, who, { archived: false, locale: "en" });
      return { canManageMeta: p!.canManageMeta, canDuplicate: p!.canDuplicate, canArchive: p!.canArchive, canRestore: p!.canRestore };
    };
    expect(await flags(s.adminId)).toEqual({ canManageMeta: true, canDuplicate: true, canArchive: true, canRestore: false });
    expect(await flags(s.ownerId)).toEqual({ canManageMeta: true, canDuplicate: true, canArchive: false, canRestore: false });
    expect(await flags(s.editorId)).toEqual({ canManageMeta: false, canDuplicate: false, canArchive: false, canRestore: false });
    expect(await flags(s.viewerId)).toEqual({ canManageMeta: false, canDuplicate: false, canArchive: false, canRestore: false });
  });

  it("move an archived project from the live list to the archived list, which only the admin may read", async () => {
    const s = await seedScene();
    await projectService.archive(s.projectId, s.adminId);
    expect((await projectService.listByStudioForViewer(s.studioId, s.adminId, { archived: false, locale: "en" })).items).toEqual([]);
    const { items: archived } = await projectService.listByStudioForViewer(s.studioId, s.adminId, { archived: true, locale: "en" });
    expect(archived.map((p) => p.id)).toEqual([s.projectId]);
    expect(archived[0]!.archivedAt).toBeInstanceOf(Date);
    expect(archived[0]!.canRestore).toBe(true);
    expect(archived[0]!.canManageMeta).toBe(false);
    await expect(
      projectService.listByStudioForViewer(s.studioId, s.ownerId, { archived: true, locale: "en" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuse the archived list to someone outside the studio, while the live list is just empty", async () => {
    const s = await seedScene();
    const outsider = await insertUser(`outsider-${s.projectId.slice(0, 8)}`);
    expect((await projectService.listByStudioForViewer(s.studioId, outsider, { archived: false, locale: "en" })).items).toEqual([]);
    await expect(
      projectService.listByStudioForViewer(s.studioId, outsider, { archived: true, locale: "en" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("the project page", () => {
  it("lets the owner rename from the title, and not an editor", async () => {
    const s = await seedScene();
    expect((await projectService.loadForViewer(s.projectId, s.ownerId)).canManageMeta).toBe(true);
    expect((await projectService.loadForViewer(s.projectId, s.editorId)).canManageMeta).toBe(false);
    await projectService.archive(s.projectId, s.adminId);
    expect((await projectService.loadForViewer(s.projectId, s.ownerId)).canManageMeta).toBe(false);
  });
});

describe("the recent page", () => {
  it("drops an archived project", async () => {
    const s = await seedScene();
    await sql`
      INSERT INTO project_last_opened (user_id, project_id, last_opened_at)
      VALUES (${s.ownerId}, ${s.projectId}, now())
    `;
    expect((await recentRepo.listRecentForUser(s.ownerId, 50)).map((r) => r.projectId)).toContain(s.projectId);
    await projectService.archive(s.projectId, s.adminId);
    expect((await recentRepo.listRecentForUser(s.ownerId, 50)).map((r) => r.projectId)).not.toContain(s.projectId);
  });
});

describe("the join dialog", () => {
  it("tells a non-member that the project is archived", async () => {
    const s = await seedScene();
    expect((await joinService.getMine(s.projectId, s.guestId)).project.archivedAt).toBeNull();
    await projectService.archive(s.projectId, s.adminId);
    expect((await joinService.getMine(s.projectId, s.guestId)).project.archivedAt).toBeInstanceOf(Date);
  });
});
