/**
 * projectAuth.service unit tests — null-collapse semantics.
 *
 * Asserts that loadProjectRole returns `null` for both
 * "project missing" and "user has no membership", so the caller
 * (server middleware / collab onAuthenticate) never leaks project
 * existence by distinguishing 404 vs 403.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbSelectMock = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: dbSelectMock,
        }),
      }),
    }),
  },
}));

vi.mock("./projectMembers.repo.js", () => ({
  getRole: vi.fn(),
}));

import * as projectMembersRepo from "./projectMembers.repo.js";
import { loadProjectRole } from "./projectAuth.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadProjectRole", () => {
  it("returns null when the project does not exist", async () => {
    dbSelectMock.mockResolvedValueOnce([]); // no projects row

    const role = await loadProjectRole("u1", "p-missing");

    expect(role).toBeNull();
    expect(projectMembersRepo.getRole).not.toHaveBeenCalled();
  });

  it("returns null when the project exists but the user has no membership", async () => {
    dbSelectMock.mockResolvedValueOnce([{ id: "p-real" }]);
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);

    const role = await loadProjectRole("u-not-member", "p-real");

    expect(role).toBeNull();
  });

  it("returns the member's role when active membership exists", async () => {
    dbSelectMock.mockResolvedValueOnce([{ id: "p-real" }]);
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("edit");

    const role = await loadProjectRole("u-member", "p-real");

    expect(role).toBe("edit");
  });

  it("does not distinguish 'project not found' from 'no membership' to the caller", async () => {
    // Both branches return null — the caller's 403 stays consistent
    // whether the project is missing or just inaccessible to this user.
    // (Anti-leak; BUG-048 class.)
    dbSelectMock.mockResolvedValueOnce([]);
    expect(await loadProjectRole("u1", "p-missing")).toBeNull();

    dbSelectMock.mockResolvedValueOnce([{ id: "p-real" }]);
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    expect(await loadProjectRole("u1", "p-real")).toBeNull();
  });
});
