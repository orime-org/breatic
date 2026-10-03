// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * projectAuth.service unit tests — loadProjectRole / loadProjectAccess.
 *
 * `loadProjectRole` is the shared write gate (server `requireRole`
 * middleware + collab `onAuthenticate`). Both read
 * `projectMembersRepo.getAccess`, which folds the project-active guard
 * and the membership lookup into one inner-join query and collapses
 * both "project missing/deleted" and "user not a member" to `null` —
 * so the caller surfaces one generic 403 and never leaks project
 * existence (the BUG-048 cross-tenant-probe class). `loadProjectRole`
 * caps an archived project at viewer; `loadProjectAccess` does not.
 *
 * These tests pin the delegation, the argument order and the cap. The JOIN-level
 * null-collapse against real data (soft-deleted project still yields
 * null even with a lingering member row) is covered by the repo
 * integration test against a real Postgres — mocking the drizzle
 * query chain here could not verify the actual WHERE filters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../projectMembers.repo.js", () => ({
  getAccess: vi.fn(),
}));

import * as projectMembersRepo from "../projectMembers.repo.js";
import { loadProjectAccess, loadProjectRole } from "../projectAuth.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadProjectRole", () => {
  it("delegates to getAccess with (projectId, userId) and returns the role of a live project", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "editor", archived: false });

    const role = await loadProjectRole("u-member", "p-real");

    expect(role).toBe("editor");
    // Note the argument flip: loadProjectRole(userId, projectId) →
    // getAccess(projectId, userId).
    expect(projectMembersRepo.getAccess).toHaveBeenCalledWith("p-real", "u-member");
  });

  it("caps every role at viewer on an archived project", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "owner", archived: true });
    expect(await loadProjectRole("u-owner", "p-archived")).toBe("viewer");

    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "editor", archived: true });
    expect(await loadProjectRole("u-editor", "p-archived")).toBe("viewer");
  });

  it("returns null when getAccess reports no access (project missing/deleted OR not a member)", async () => {
    // getAccess's inner-join collapses both cases to null; loadProjectRole
    // adds no existence-distinguishing logic, so the anti-leak contract
    // holds — the caller's 403 is identical whether the project is
    // missing or merely inaccessible to this user.
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce(null);
    expect(await loadProjectRole("u1", "p-missing")).toBeNull();

    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce(null);
    expect(await loadProjectRole("u-not-member", "p-real")).toBeNull();
  });
});

describe("loadProjectAccess", () => {
  it("returns the stored role and the archive state unchanged", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "owner", archived: true });

    expect(await loadProjectAccess("u-owner", "p-archived")).toEqual({ role: "owner", archived: true });
    expect(projectMembersRepo.getAccess).toHaveBeenCalledWith("p-archived", "u-owner");
  });
});
