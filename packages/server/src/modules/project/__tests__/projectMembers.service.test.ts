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
      getAccess: vi.fn(),
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
    logger: { error: vi.fn() },
    ConflictError,
    NotFoundError,
  };
});

import {
  projectMembersRepo,
  publishMembersChanged,
  logger,
  ConflictError,
  NotFoundError,
} from "@breatic/core";
import { t } from "@breatic/shared";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import {
  changeRole,
  leave,
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

describe("changeRole after the commit", () => {
  it("still succeeds and logs when announcing the change fails", async () => {
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(true);
    vi.mocked(publishMembersChanged).mockRejectedValueOnce(new Error("redis down"));
    await expect(changeRole(PID, "u-target", "viewer", "u-owner")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(recordProjectActivity).toHaveBeenCalledTimes(1);
  });
});

describe("remove after the commit", () => {
  it("still succeeds and logs when announcing the change fails", async () => {
    // The row is already soft-deleted when the announcement runs; the answer
    // has to say so, or the caller is told the removal failed when it did not.
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("editor");
    vi.mocked(projectMembersRepo.softDelete).mockResolvedValueOnce(true);
    vi.mocked(publishMembersChanged).mockRejectedValueOnce(new Error("redis down"));
    await expect(remove(PID, "u-target", "u-owner")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(recordProjectActivity).toHaveBeenCalledTimes(1);
  });
});

describe("leave", () => {
  it("refuses an archived project before touching the member row", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "editor", archived: true });
    const err = await leave(PID, "u-me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe(t("server.project.archived"));
    expect(projectMembersRepo.softDelete).not.toHaveBeenCalled();
  });

  it("refuses the owner with the transfer-first sentence", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "owner", archived: false });
    const err = await leave(PID, "u-me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe(t("server.project.leave_owner"));
    expect((err as Error).message).not.toBe(t("server.error.conflict"));
    expect(projectMembersRepo.softDelete).not.toHaveBeenCalled();
  });

  it("answers NotFound when the caller is no longer a member", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce(null);
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce(null);
    await expect(leave(PID, "u-me")).rejects.toBeInstanceOf(NotFoundError);
    expect(projectMembersRepo.softDelete).not.toHaveBeenCalled();
  });

  it("removes a viewer through the locked removal and credits them as the actor", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "viewer", archived: false });
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("viewer");
    vi.mocked(projectMembersRepo.softDelete).mockResolvedValueOnce(true);
    await leave(PID, "u-me");
    expect(projectMembersRepo.lockMemberRole).toHaveBeenCalledWith(PID, "u-me", FAKE_TX);
    expect(projectMembersRepo.softDelete).toHaveBeenCalledWith(PID, "u-me", FAKE_TX);
    expect(recordProjectActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "u-me",
        type: "member:removed",
        payload: expect.objectContaining({ targetUserId: "u-me" }),
      }),
    );
  });

  it("still refuses an owner the lock reveals after a transfer landed in between", async () => {
    vi.mocked(projectMembersRepo.getAccess).mockResolvedValueOnce({ role: "editor", archived: false });
    vi.mocked(projectMembersRepo.lockMemberRole).mockResolvedValueOnce("owner");
    await expect(leave(PID, "u-me")).rejects.toBeInstanceOf(ConflictError);
    expect(projectMembersRepo.softDelete).not.toHaveBeenCalled();
  });
});
