// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * project.service.create unit test (3-role studio-scoped create).
 *
 * `create` takes a target `studioId` and authorizes the caller's CURRENT
 * studio role (spec §0.2 / §8.2): only `admin` or `creator` may create a
 * project — `member` and non-members (role `null`) are rejected, because a
 * studio's credits are shared and a plain member must not be able to spend
 * them by creating projects. The create still writes ONLY the business rows
 * (projects + project_members) inside one transaction — the Yjs meta doc is
 * lazy-seeded by collab on first load (after the two-DB cutover).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// project.service imports @breatic/domain (studioAuthService), whose barrel
// pulls agent/llm → the `ai` SDK → @opentelemetry/api (ESM Node rejects). This
// suite never calls any ai function; the stub keeps that chain from loading.
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@server/modules/project/project.repo.js", () => ({
  createProject: vi.fn(),
}));

// studioAuthService.loadStudioRole is the create-authz source of truth.
const { mockLoadStudioRole } = vi.hoisted(() => ({
  mockLoadStudioRole: vi.fn(),
}));
vi.mock("@breatic/domain", () => ({
  studioAuthService: { loadStudioRole: mockLoadStudioRole },
}));

vi.mock("@breatic/core", async (importActual: () => Promise<Record<string, unknown>>) => {
  const actual = await importActual();
  return {
    ...actual,
    db: {
      // Pass-through transaction — runs the callback immediately with a stub tx
      // handle. createProject is mocked, so no real DB is needed.
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ TX: true }),
      ),
    },
  };
});

vi.mock("@breatic/shared", async (importActual: () => Promise<Record<string, unknown>>) => ({
  ...(await importActual()),
  t: (k: string) => k,
}));

import * as projectRepo from "@server/modules/project/project.repo.js";
import { create } from "@server/modules/project/project.service.js";

describe("project.service.create — studio-scoped, admin/creator gate (spec §0.2/§8.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRepo.createProject).mockResolvedValue({
      id: "p-1",
      name: "My Cyberpunk Idea",
    } as never);
  });

  it("creates the project in the TARGET studio when the caller is its admin", async () => {
    mockLoadStudioRole.mockResolvedValueOnce("admin");

    const result = await create(
      "u-1",
      "studio-9",
      "My Cyberpunk Idea",
      "my-cyberpunk-idea",
      "studio",
      "canvas",
      "a description",
    );

    // Authorized against the TARGET studio's current role, not the personal one.
    expect(mockLoadStudioRole).toHaveBeenCalledWith("u-1", "studio-9");
    expect(projectRepo.createProject).toHaveBeenCalledTimes(1);
    // Args: (tx, studioId, creatorUserId, name, slug, visibility, spaceType, description).
    const args = vi.mocked(projectRepo.createProject).mock.calls[0];
    expect(args?.[1]).toBe("studio-9"); // lands in the chosen studio
    expect(args?.[2]).toBe("u-1");
    expect(args?.[3]).toBe("My Cyberpunk Idea");
    expect(args?.[4]).toBe("my-cyberpunk-idea");
    expect(args?.[5]).toBe("studio");
    expect(args?.[6]).toBe("canvas"); // spaceType threaded to the repo
    expect(args?.[7]).toBe("a description");
    expect(result).toEqual({ id: "p-1", name: "My Cyberpunk Idea" });
  });

  it("allows a creator to create (admin + creator may spend studio credits)", async () => {
    mockLoadStudioRole.mockResolvedValueOnce("maintainer");

    await create("u-1", "studio-9", "P", "p", "studio", "canvas");

    expect(projectRepo.createProject).toHaveBeenCalledTimes(1);
  });

  it("rejects a plain member with ForbiddenError (cannot burn shared studio credits)", async () => {
    mockLoadStudioRole.mockResolvedValueOnce("guest");

    await expect(
      create("u-1", "studio-9", "P", "p", "studio", "canvas"),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(projectRepo.createProject).not.toHaveBeenCalled();
  });

  it("rejects a non-member (role null) with ForbiddenError", async () => {
    mockLoadStudioRole.mockResolvedValueOnce(null);

    await expect(
      create("u-1", "studio-9", "P", "p", "studio", "canvas"),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(projectRepo.createProject).not.toHaveBeenCalled();
  });

  it("wraps the create in a single business transaction (project + owner atomic)", async () => {
    mockLoadStudioRole.mockResolvedValueOnce("admin");
    const core = await import("@breatic/core");

    await create(
      "u-1",
      "studio-9",
      "Another Project",
      "another-project",
      "studio",
      "canvas",
    );

    // createProject runs inside db.transaction — the project row + owner row
    // must commit together (a project without an owner row is unreadable).
    expect(vi.mocked(core.db.transaction)).toHaveBeenCalledTimes(1);
    const txArg = vi.mocked(projectRepo.createProject).mock.calls[0]?.[0];
    expect(txArg).toEqual({ TX: true });
  });
});
