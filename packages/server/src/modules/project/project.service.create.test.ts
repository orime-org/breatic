// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * project.service.create unit test — locks the invariant that the
 * first Space created alongside a new Project takes the Project's
 * name, not the legacy "Untitled" placeholder.
 *
 * Q2 regression guard: NewProjectDialog only collects a Project name
 * (single field), so the user's expectation is that the seeded
 * canvas Space picks up that name. Previously this service hard-
 * coded `DEFAULT_SPACE_NAME = "Untitled"`, which dropped the
 * project name on the floor and surfaced "Untitled" in the tab bar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@server/modules/project/project.repo.js", () => ({
  createProject: vi.fn(),
}));
vi.mock("@server/modules/studio/studio.service.js", () => ({
  ensurePersonalStudio: vi.fn(),
}));
// userRepo moved back to @server in PR4 (domain extraction) — mock it on
// its own server-local path, not the core barrel.
vi.mock("@server/modules/auth/user.repo.js", () => ({
  getUserById: vi.fn(),
}));
// db + encodeInitialMetaState + yjsDocumentsRepo all live in
// @breatic/core (yjs_documents is shared infra, single repo home in
// core); project.service imports them from the barrel, so mock them
// there (partial — spread the real barrel, override the three).
vi.mock("@breatic/core", async (importActual: () => Promise<Record<string, unknown>>) => {
  const actual = await importActual();
  return {
    ...actual,
    encodeInitialMetaState: vi.fn(() => Buffer.from("stub-meta-state")),
    yjsDocumentsRepo: { insertInitialState: vi.fn() },
    db: {
      // Pass-through transaction — runs the callback immediately with a
      // stub tx handle. The repo mocks ignore it, so no real DB needed.
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({}),
      ),
    },
  };
});

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import { encodeInitialMetaState, yjsDocumentsRepo } from "@breatic/core";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { create } from "@server/modules/project/project.service.js";

describe("project.service.create — Q2 first-space-name invariant", () => {
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

  it("seeds the first Space with the Project name (not 'Untitled')", async () => {
    await create("u-1", "My Cyberpunk Idea");

    expect(encodeInitialMetaState).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(encodeInitialMetaState).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    // The invariant: the seeded Space name mirrors the Project name.
    // Both are derived from the same single text field in
    // NewProjectDialog, so any divergence here means the bug is
    // back.
    expect(arg?.name).toBe("My Cyberpunk Idea");
    // Defensive: lock the legacy placeholder out so a future revert
    // is loud, not silent.
    expect(arg?.name).not.toBe("Untitled");
  });

  it("propagates the encoded meta state to the core yjs_documents repo", async () => {
    await create("u-1", "Another Project");

    expect(yjsDocumentsRepo.insertInitialState).toHaveBeenCalledTimes(1);
    // Sanity-check the doc name reaches insertInitialState — guards
    // against accidentally calling it with project.id instead.
    const args = vi.mocked(yjsDocumentsRepo.insertInitialState).mock.calls[0];
    expect(args?.[1]).toContain("p-1");
  });

  it("Q11 v2 invariant: passes the creating userId as actor (frontend lookups name via meta.users at render time)", async () => {
    // Q11 v2 inverted the snapshot model — projectMessages now stores
    // POINTERS (userId / spaceId) and the frontend reads
    // meta.users[actor].name + meta.spaces[spaceId].name live, so a
    // username rename retroactively propagates to every old message.
    // Locking actor === userId here catches a regression that would
    // re-introduce snapshot strings.
    vi.mocked(userRepo.getUserById).mockResolvedValueOnce({
      id: "u-1",
      username: "Alice",
      email: "alice@example.com",
    } as never);
    await create("u-1", "My Project");

    const arg = vi.mocked(encodeInitialMetaState).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg?.actor).toBe("u-1");
    // Defensive — actor must NOT be a snapshot string anymore.
    expect(arg?.actor).not.toBe("Alice");
    expect(arg?.actor).not.toBe("alice@example.com");
  });
});
