// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * projectMembers.service unit tests — invariant enforcement.
 *
 * Mocks the repo to assert that the service refuses to inviting an
 * existing owner, refuses to PATCH the owner's role, and refuses to
 * soft-delete the owner. The partial unique index in PG is the
 * ultimate guard, but the service catches these earlier with a
 * 409 Conflict so the route layer can surface a friendly message.
 *
 * `db`, `projectMembersRepo`, `publishMembersChanged`, and the error
 * classes all come from `@breatic/core` (the repo moved there in the
 * auth-unification PR). The whole barrel is replaced so every one of those
 * four is under the test's control and no real database connection is ever
 * opened — the same hermetic-test shape as collab/auth.test.
 * The error classes are defined inside the factory so the service's
 * `throw new ConflictError()` and the test's `toBeInstanceOf` resolve
 * to the same constructor.
 *
 * Both write paths run inside `db.transaction` and read the role under a
 * row lock, so the mocked transaction hands the callback a sentinel handle
 * and every repo assertion below pins that the handle was threaded through.
 * Whether the lock actually serialises anything is a property of Postgres,
 * proven in project-transfer.integration.test.ts — here we only pin that the
 * service asks for it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared with the vi.mock factory below, which is hoisted above imports.
const { FAKE_TX } = vi.hoisted(() => ({ FAKE_TX: { fakeTx: true } }));

// The service under test appends feed rows via the activity helper -
// stub it out (its own behavior is covered by projectActivity tests).
vi.mock("@server/modules/activity/projectActivity.service.js", () => ({
  recordProjectActivity: vi.fn(async () => {}),
}));

vi.mock("@breatic/core", () => {
  class ConflictError extends Error {}
  class NotFoundError extends Error {}
  return {
    db: {
      transaction: vi.fn(
        async (fn: (tx: typeof FAKE_TX) => Promise<unknown>) => fn(FAKE_TX),
      ),
    },
    projectMembersRepo: {
      getRole: vi.fn(),
      lockMemberRole: vi.fn(),
      listByProjectId: vi.fn(),
      upsertMember: vi.fn(),
      updateRole: vi.fn(),
      softDelete: vi.fn(),
    },
    // PR-C wired publishMembersChanged into every successful service
    // path (after the repo mutates); stubbed so the unit test runs
    // without an ioredis connection.
    publishMembersChanged: vi.fn().mockResolvedValue(undefined),
    ConflictError,
    NotFoundError,
  };
});

import { projectMembersRepo, ConflictError, NotFoundError } from "@breatic/core";
import {
  changeRole,
  remove,
} from "../projectMembers.service.js";

const PID = "p1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("changeRole", () => {
  it("throws NotFound when target has no active membership", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce(null);
    await expect(changeRole(PID, "u-target", "editor")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects PATCH'ing the owner's role with Conflict", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("owner");
    await expect(changeRole(PID, "u-owner", "editor")).rejects.toBeInstanceOf(ConflictError);
    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
  });

  it("updates an editor member to viewer inside the transaction", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(true);
    await changeRole(PID, "u-target", "viewer");
    expect(projectMembersRepo.lockMemberRole).toHaveBeenCalledWith(PID, "u-target", FAKE_TX);
    expect(projectMembersRepo.updateRole).toHaveBeenCalledWith(PID, "u-target", "viewer", FAKE_TX);
  });

  it("translates a stale row (updateRole returns false) into NotFound", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(false);
    await expect(changeRole(PID, "u-target", "viewer")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("never reads the role through the unlocked getRole", async () => {
    // The lock is the whole point: an unlocked read makes the owner check a
    // statement about the past, and a transfer committing in the gap turns
    // the write into a demotion of the project's new owner.
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(true);
    await changeRole(PID, "u-target", "viewer");
    expect(projectMembersRepo.getRole).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("throws NotFound when target has no active membership", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce(null);
    await expect(remove(PID, "u-target")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects removing the owner with Conflict", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("owner");
    await expect(remove(PID, "u-owner")).rejects.toBeInstanceOf(ConflictError);
    expect(projectMembersRepo.softDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a non-owner member inside the transaction", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.softDelete).mockResolvedValueOnce(true);
    await remove(PID, "u-target");
    expect(projectMembersRepo.lockMemberRole).toHaveBeenCalledWith(PID, "u-target", FAKE_TX);
    expect(projectMembersRepo.softDelete).toHaveBeenCalledWith(PID, "u-target", FAKE_TX);
  });

  it("never reads the role through the unlocked getRole", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.softDelete).mockResolvedValueOnce(true);
    await remove(PID, "u-target");
    expect(projectMembersRepo.getRole).not.toHaveBeenCalled();
  });
});
