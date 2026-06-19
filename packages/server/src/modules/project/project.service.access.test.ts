// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * project.service open-baseline access — `loadForViewer` +
 * `listByStudioForViewer` / `listByStudioSlug` unit tests (mock).
 *
 * The SQL-level truth (visibility matrix, materialize
 * idempotency / concurrency / soft-delete revive, one-owner) is verified
 * against real Postgres in
 * `__tests__/integration/project-visibility-materialize.integration.test.ts`.
 * This file locks the SERVICE-layer branching that a mocked query builder
 * can express:
 *   - who is granted access on the project-load path, and exactly when a
 *     viewer row is materialized (and when it is NOT — `get()`'s other
 *     callers must never materialize as a side effect);
 *   - the list short-circuits: non-member → [], member → repo(isAdmin=false),
 *     admin → repo(isAdmin=true).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@server/modules/project/project.repo.js", () => ({
  getProjectById: vi.fn(),
  listProjectsByStudioForViewer: vi.fn(),
}));

vi.mock("@server/modules/studio/studio.service.js", () => ({
  getStudioBySlug: vi.fn(),
  getPersonalStudio: vi.fn(),
}));

vi.mock("@breatic/core", async (importActual: () => Promise<Record<string, unknown>>) => {
  const actual = await importActual();
  return {
    ...actual,
    projectAuthService: { loadProjectRole: vi.fn() },
    projectMembersRepo: { materializeBaselineViewer: vi.fn() },
  };
});

vi.mock("@breatic/domain", () => ({
  studioAuthService: { loadStudioRole: vi.fn() },
}));

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import { projectAuthService, projectMembersRepo, NotFoundError } from "@breatic/core";
import { studioAuthService } from "@breatic/domain";
import {
  loadForViewer,
  listByStudioForViewer,
  listByStudioSlug,
} from "@server/modules/project/project.service.js";
import type { ProjectEntity, ProjectVisibility } from "@breatic/shared";

/** Build a project fixture with overridable visibility / studio. */
function makeProject(over: Partial<ProjectEntity> = {}): ProjectEntity {
  return {
    id: "p-1",
    studioId: "s-1",
    createdByUserId: "u-owner",
    name: "Project",
    description: null,
    thumbnailUrl: null,
    slug: "project",
    visibility: "studio" as ProjectVisibility,
    createdAt: new Date("2026-06-07T00:00:00Z"),
    updatedAt: new Date("2026-06-07T00:00:00Z"),
    deletedAt: null,
    ...over,
  };
}

const loadProjectRole = vi.mocked(projectAuthService.loadProjectRole);
const loadStudioRole = vi.mocked(studioAuthService.loadStudioRole);
const materialize = vi.mocked(projectMembersRepo.materializeBaselineViewer);
const getProjectById = vi.mocked(projectRepo.getProjectById);
const listRepo = vi.mocked(projectRepo.listProjectsByStudioForViewer);
const getStudioBySlug = vi.mocked(studioService.getStudioBySlug);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project.service.loadForViewer — open-baseline access + materialize", () => {
  it("returns an existing member's role unchanged and never materializes", async () => {
    loadProjectRole.mockResolvedValue("editor");
    getProjectById.mockResolvedValue(makeProject());

    const result = await loadForViewer("p-1", "u-1");

    expect(result.myRole).toBe("editor");
    expect(result.project.id).toBe("p-1");
    // Existing member → first branch; studio role + materialize untouched.
    expect(loadStudioRole).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("grants + materializes a viewer row for a studio member on a studio-visible project", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject({ visibility: "studio", studioId: "s-9" }));
    loadStudioRole.mockResolvedValue("guest");

    const result = await loadForViewer("p-1", "u-1");

    expect(result.myRole).toBe("viewer");
    expect(loadStudioRole).toHaveBeenCalledWith("u-1", "s-9");
    expect(materialize).toHaveBeenCalledWith("p-1", "u-1");
  });

  it("grants + materializes a viewer row for a studio ADMIN too (project role starts at viewer)", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject({ visibility: "studio" }));
    loadStudioRole.mockResolvedValue("admin");

    const result = await loadForViewer("p-1", "u-1");

    expect(result.myRole).toBe("viewer");
    expect(materialize).toHaveBeenCalledWith("p-1", "u-1");
  });

  it("hides a private project (404) from a studio member with no explicit row — never checks studio role", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject({ visibility: "private" }));

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(NotFoundError);
    // Private projects never consult studio membership — only explicit members.
    expect(loadStudioRole).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("hides a studio-visible project (404) from a non-studio-member", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject({ visibility: "studio" }));
    loadStudioRole.mockResolvedValue(null);

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("throws NotFound for a missing / soft-deleted project", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(null);

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("project.service.listByStudioForViewer — visibility short-circuits", () => {
  it("returns [] for a non-studio-member without touching the repo", async () => {
    loadStudioRole.mockResolvedValue(null);

    const result = await listByStudioForViewer("s-1", "u-1");

    expect(result).toEqual([]);
    expect(listRepo).not.toHaveBeenCalled();
  });

  it("queries with isStudioAdmin=false for a studio member", async () => {
    loadStudioRole.mockResolvedValue("guest");
    listRepo.mockResolvedValue([]);

    await listByStudioForViewer("s-1", "u-1");

    expect(listRepo).toHaveBeenCalledWith("s-1", "u-1", false);
  });

  it("queries with isStudioAdmin=true for a studio admin (sees all)", async () => {
    loadStudioRole.mockResolvedValue("admin");
    listRepo.mockResolvedValue([]);

    await listByStudioForViewer("s-1", "u-1");

    expect(listRepo).toHaveBeenCalledWith("s-1", "u-1", true);
  });
});

describe("project.service.listByStudioSlug — slug resolution", () => {
  it("resolves the slug then lists for the viewer", async () => {
    getStudioBySlug.mockResolvedValue({ id: "s-7" } as never);
    loadStudioRole.mockResolvedValue("guest");
    listRepo.mockResolvedValue([]);

    await listByStudioSlug("acme", "u-1");

    expect(getStudioBySlug).toHaveBeenCalledWith("acme");
    expect(listRepo).toHaveBeenCalledWith("s-7", "u-1", false);
  });

  it("throws NotFound for an unknown slug", async () => {
    getStudioBySlug.mockResolvedValue(null);

    await expect(listByStudioSlug("nope", "u-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(listRepo).not.toHaveBeenCalled();
  });
});
