// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * project.service.create unit test.
 *
 * After the yjs two-DB cutover, create() writes ONLY the business rows
 * (projects + project_members, atomically) — it no longer eager-seeds
 * the `project-{id}/meta` Yjs doc, because the Yjs store moved to a
 * separate database that can't share the business transaction. The
 * default Space is now lazy-seeded by collab on first meta-doc load
 * (see collab's lazy-seed test for the "≥1 Space" + Space-name
 * invariants). This test locks that create() does business writes only
 * and never reaches for a yjs seed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@server/modules/project/project.repo.js", () => ({
  createProject: vi.fn(),
}));
vi.mock("@server/modules/studio/studio.service.js", () => ({
  ensurePersonalStudio: vi.fn(),
}));
vi.mock("@server/modules/auth/user.repo.js", () => ({
  getUserById: vi.fn(),
}));
vi.mock("@breatic/core", async (importActual: () => Promise<Record<string, unknown>>) => {
  const actual = await importActual();
  return {
    ...actual,
    db: {
      // Pass-through transaction — runs the callback immediately with a
      // stub tx handle. createProject is mocked, so no real DB needed.
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ TX: true }),
      ),
    },
  };
});

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { create } from "@server/modules/project/project.service.js";

describe("project.service.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userRepo.getUserById).mockResolvedValue({
      id: "u-1",
      username: "alice",
    } as never);
    vi.mocked(studioService.ensurePersonalStudio).mockResolvedValue({
      id: "studio-1",
    } as never);
    vi.mocked(projectRepo.createProject).mockResolvedValue({
      id: "p-1",
      name: "My Cyberpunk Idea",
    } as never);
  });

  it("creates the project + owner row in the caller's personal studio and returns it", async () => {
    const result = await create("u-1", "My Cyberpunk Idea", "a description");

    expect(studioService.ensurePersonalStudio).toHaveBeenCalledWith("u-1", "alice");
    expect(projectRepo.createProject).toHaveBeenCalledTimes(1);
    // Args: (tx, studioId, creatorUserId, name, description).
    const args = vi.mocked(projectRepo.createProject).mock.calls[0];
    expect(args?.[1]).toBe("studio-1");
    expect(args?.[2]).toBe("u-1");
    expect(args?.[3]).toBe("My Cyberpunk Idea");
    expect(args?.[4]).toBe("a description");
    expect(result).toEqual({ id: "p-1", name: "My Cyberpunk Idea" });
  });

  it("wraps the create in a single business transaction (project + owner atomic)", async () => {
    const core = await import("@breatic/core");
    await create("u-1", "Another Project");
    // createProject runs inside db.transaction — the project row + owner
    // row must commit together (a project without an owner row is
    // unreadable, including by its creator).
    expect(vi.mocked(core.db.transaction)).toHaveBeenCalledTimes(1);
    const txArg = vi.mocked(projectRepo.createProject).mock.calls[0]?.[0];
    expect(txArg).toEqual({ TX: true });
  });
});
