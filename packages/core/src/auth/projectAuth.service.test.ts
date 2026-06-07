// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * projectAuth.service unit tests — loadProjectRole delegation.
 *
 * `loadProjectRole` is the shared auth primitive (server `requireRole`
 * middleware + collab `onAuthenticate`). It delegates to
 * `projectMembersRepo.getRole`, which folds the project-active guard
 * and the membership lookup into one inner-join query and collapses
 * both "project missing/deleted" and "user not a member" to `null` —
 * so the caller surfaces one generic 403 and never leaks project
 * existence (the BUG-048 cross-tenant-probe class).
 *
 * These tests pin the delegation + argument order. The JOIN-level
 * null-collapse against real data (soft-deleted project still yields
 * null even with a lingering member row) is covered by the repo
 * integration test against a real Postgres — mocking the drizzle
 * query chain here could not verify the actual WHERE filters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./projectMembers.repo.js", () => ({
  getRole: vi.fn(),
}));

import * as projectMembersRepo from "./projectMembers.repo.js";
import { loadProjectRole } from "./projectAuth.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadProjectRole", () => {
  it("delegates to getRole with (projectId, userId) and returns the role", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("editor");

    const role = await loadProjectRole("u-member", "p-real");

    expect(role).toBe("editor");
    // Note the argument flip: loadProjectRole(userId, projectId) →
    // getRole(projectId, userId).
    expect(projectMembersRepo.getRole).toHaveBeenCalledWith("p-real", "u-member");
  });

  it("returns null when getRole reports no access (project missing/deleted OR not a member)", async () => {
    // getRole's inner-join collapses both cases to null; loadProjectRole
    // adds no existence-distinguishing logic, so the anti-leak contract
    // holds — the caller's 403 is identical whether the project is
    // missing or merely inaccessible to this user.
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    expect(await loadProjectRole("u1", "p-missing")).toBeNull();

    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    expect(await loadProjectRole("u-not-member", "p-real")).toBeNull();
  });
});
