// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * project.service access — `loadForViewer` + `listByStudioForViewer` /
 * `listByStudioSlug` unit tests (mock).
 *
 * The SQL-level truth is verified against real Postgres in
 * `__tests__/integration/project-join-requests.integration.test.ts`. This file
 * locks the service-layer branching:
 *   - the project-load path: a member gets their role, a studio member who is
 *     not on the project gets 403, anyone else gets 404;
 *   - the list short-circuits: non-member → [], member → every project.
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
  };
});

vi.mock("@breatic/domain", () => ({
  studioAuthService: { loadStudioRole: vi.fn() },
}));

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import { projectAuthService, ForbiddenError, NotFoundError } from "@breatic/core";
import { studioAuthService } from "@breatic/domain";
import {
  loadForViewer,
  listByStudioForViewer,
  listByStudioSlug,
} from "@server/modules/project/project.service.js";
import type { ProjectEntity } from "@breatic/shared";

/** Build a project fixture with an overridable studio. */
function makeProject(over: Partial<ProjectEntity> = {}): ProjectEntity {
  return {
    id: "p-1",
    studioId: "s-1",
    createdByUserId: "u-owner",
    name: "Project",
    description: null,
    thumbnailUrl: null,
    slug: "project",
    createdAt: new Date("2026-06-07T00:00:00Z"),
    updatedAt: new Date("2026-06-07T00:00:00Z"),
    deletedAt: null,
    ...over,
  };
}

const loadProjectRole = vi.mocked(projectAuthService.loadProjectRole);
const loadStudioRole = vi.mocked(studioAuthService.loadStudioRole);
const getProjectById = vi.mocked(projectRepo.getProjectById);
const listRepo = vi.mocked(projectRepo.listProjectsByStudioForViewer);
const getStudioBySlug = vi.mocked(studioService.getStudioBySlug);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project.service.loadForViewer — members enter, studio members are refused", () => {
  it("returns an existing member's role unchanged", async () => {
    loadProjectRole.mockResolvedValue("editor");
    getProjectById.mockResolvedValue(makeProject());

    const result = await loadForViewer("p-1", "u-1");

    expect(result.myRole).toBe("editor");
    expect(result.project.id).toBe("p-1");
    expect(loadStudioRole).not.toHaveBeenCalled();
  });

  it("refuses a studio member who is not on the project with 403", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject({ studioId: "s-9" }));
    loadStudioRole.mockResolvedValue("guest");

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(ForbiddenError);
    expect(loadStudioRole).toHaveBeenCalledWith("u-1", "s-9");
  });

  it("refuses a studio admin who is not on the project with 403 too", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject());
    loadStudioRole.mockResolvedValue("admin");

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides the project (404) from someone outside the studio", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(makeProject());
    loadStudioRole.mockResolvedValue(null);

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFound for a missing / soft-deleted project", async () => {
    loadProjectRole.mockResolvedValue(null);
    getProjectById.mockResolvedValue(null);

    await expect(loadForViewer("p-1", "u-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(loadStudioRole).not.toHaveBeenCalled();
  });
});

describe("project.service.listByStudioForViewer — studio members see every project", () => {
  it("returns [] for a non-studio-member without touching the repo", async () => {
    loadStudioRole.mockResolvedValue(null);

    const result = await listByStudioForViewer("s-1", "u-1");

    expect(result).toEqual([]);
    expect(listRepo).not.toHaveBeenCalled();
  });

  it("lists for any studio member", async () => {
    loadStudioRole.mockResolvedValue("guest");
    listRepo.mockResolvedValue([]);

    await listByStudioForViewer("s-1", "u-1");

    expect(listRepo).toHaveBeenCalledWith("s-1", "u-1");
  });
});

describe("project.service.listByStudioSlug — slug resolution", () => {
  it("resolves the slug then lists for the viewer", async () => {
    getStudioBySlug.mockResolvedValue({ id: "s-7" } as never);
    loadStudioRole.mockResolvedValue("guest");
    listRepo.mockResolvedValue([]);

    await listByStudioSlug("acme", "u-1");

    expect(getStudioBySlug).toHaveBeenCalledWith("acme");
    expect(listRepo).toHaveBeenCalledWith("s-7", "u-1");
  });

  it("throws NotFound for an unknown slug", async () => {
    getStudioBySlug.mockResolvedValue(null);

    await expect(listByStudioSlug("nope", "u-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(listRepo).not.toHaveBeenCalled();
  });
});
