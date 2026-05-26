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

vi.mock("./project.repo.js", () => ({
  createProject: vi.fn(),
}));
vi.mock("./studio.service.js", () => ({
  ensurePersonalStudio: vi.fn(),
}));
vi.mock("./user.repo.js", () => ({
  getUserById: vi.fn(),
}));
vi.mock("./yjs-doc.repo.js", () => ({
  insertInitialState: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  db: {
    // Pass-through transaction — runs the callback immediately with
    // a stub tx handle. The repo mocks ignore it, so no real DB
    // needs to be live.
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({}),
    ),
  },
}));
vi.mock("../db/yjs-bootstrap.js", () => ({
  encodeInitialMetaState: vi.fn(() => Buffer.from("stub-meta-state")),
}));

import * as projectRepo from "./project.repo.js";
import * as studioService from "./studio.service.js";
import * as userRepo from "./user.repo.js";
import * as yjsDocRepo from "./yjs-doc.repo.js";
import { encodeInitialMetaState } from "../db/yjs-bootstrap.js";
import { create } from "./project.service.js";

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

  it("propagates the encoded meta state to yjs-doc.repo", async () => {
    await create("u-1", "Another Project");

    expect(yjsDocRepo.insertInitialState).toHaveBeenCalledTimes(1);
    // Sanity-check the doc name reaches insertInitialState — guards
    // against accidentally calling it with project.id instead.
    const args = vi.mocked(yjsDocRepo.insertInitialState).mock.calls[0];
    expect(args?.[1]).toContain("p-1");
  });

  it("Q11 invariant: passes the user's display name as actor so the seeded space-created message is non-empty", async () => {
    // The encoded initial meta state seeds the first projectMessages
    // entry alongside `meta.spaces`. Without an actor, the bell would
    // render "<空白> 创建了 Space X" — the original Q11 bug. Lock the
    // username-or-email fallback chain so a future refactor that drops
    // the username lookup trips this test before merge.
    vi.mocked(userRepo.getUserById).mockResolvedValueOnce({
      id: "u-1",
      username: "Alice",
      email: "alice@example.com",
    } as never);
    await create("u-1", "My Project");

    const arg = vi.mocked(encodeInitialMetaState).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    // `actor` must reflect a human-readable name, not the raw UUID.
    expect(arg?.actor).toBe("Alice");
    expect(arg?.actor).not.toBe("u-1");
  });

  it("Q11 invariant: falls back to email when username is null (Google OAuth users sometimes have no username yet)", async () => {
    vi.mocked(userRepo.getUserById).mockResolvedValueOnce({
      id: "u-2",
      username: null,
      email: "bob@example.com",
    } as never);
    await create("u-2", "Bob's Project");

    const arg = vi.mocked(encodeInitialMetaState).mock.calls[0]?.[0];
    expect(arg?.actor).toBe("bob@example.com");
  });
});
