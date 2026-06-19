// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * studioAuth.service unit tests — loadStudioRole delegation.
 *
 * `loadStudioRole` is the shared studio-auth primitive (server studio
 * detail / governance + worker billing_source). It delegates to
 * `studioMembersRepo.getRole`, which folds the studio-active guard and
 * the membership lookup into one inner-join and collapses both "studio
 * missing/deleted" and "user not a member" to `null`.
 *
 * These tests pin the delegation + argument order — note the swap:
 * `loadStudioRole(userId, studioId)` calls `getRole(studioId, userId)`,
 * mirroring `loadProjectRole`. The JOIN-level null-collapse against real
 * data (soft-deleted studio still yields null) is covered by the repo
 * integration test against a real Postgres — mocking the drizzle query
 * chain here could not verify the actual WHERE filters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@domain/auth/studioMembers.repo.js", () => ({
  getRole: vi.fn(),
}));

import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import { loadStudioRole } from "@domain/auth/studioAuth.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadStudioRole", () => {
  it("delegates to getRole with the args swapped to (studioId, userId) and returns the role", async () => {
    vi.mocked(studioMembersRepo.getRole).mockResolvedValueOnce("admin");

    const role = await loadStudioRole("u-admin", "s-acme");

    expect(role).toBe("admin");
    expect(studioMembersRepo.getRole).toHaveBeenCalledWith("s-acme", "u-admin");
    expect(studioMembersRepo.getRole).toHaveBeenCalledTimes(1);
  });

  it("returns 'guest' for a plain studio member", async () => {
    vi.mocked(studioMembersRepo.getRole).mockResolvedValueOnce("guest");

    await expect(loadStudioRole("u-member", "s-acme")).resolves.toBe("guest");
  });

  it("returns null when the user is not a member (or the studio is missing/deleted)", async () => {
    vi.mocked(studioMembersRepo.getRole).mockResolvedValueOnce(null);

    await expect(loadStudioRole("u-stranger", "s-acme")).resolves.toBeNull();
  });
});
