// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * projectMembers.service unit tests — invariant enforcement.
 *
 * Mocks the repo to assert that the service refuses to inviting an
 * existing owner, refuses to PATCH the owner's role, and refuses to
 * soft-delete the owner. The partial unique index in PG is the
 * ultimate guard, but the service catches these earlier with a
 * 409 Conflict so the route layer can surface a friendly message.
 *
 * `projectMembersRepo`, `publishMembersChanged`, and the error
 * classes all come from `@breatic/core` (the repo moved there in the
 * auth-unification PR). The whole barrel is mocked rather than
 * spread-from-actual because importing real `@breatic/core` pulls the
 * `ai` SDK + opentelemetry transitive deps that vitest's ESM resolver
 * chokes on — the same hermetic-test constraint as collab/auth.test.
 * The error classes are defined inside the factory so the service's
 * `throw new ConflictError()` and the test's `toBeInstanceOf` resolve
 * to the same constructor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@breatic/core", () => {
  class ConflictError extends Error {}
  class NotFoundError extends Error {}
  return {
    projectMembersRepo: {
      getRole: vi.fn(),
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
  invite,
  changeRole,
  remove,
} from "./projectMembers.service.js";

const PID = "p1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invite", () => {
  it("rejects inviting an existing owner with Conflict", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("owner");
    await expect(invite(PID, "u-owner", "edit", "u-owner")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
  });

  it("upserts a new member when target is not the owner", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    await invite(PID, "u-target", "edit", "u-inviter");
    expect(projectMembersRepo.upsertMember).toHaveBeenCalledWith(PID, "u-target", "edit", "u-inviter");
  });

  it("revives a previously-removed member (repo upsert handles deletedAt clear)", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null); // soft-deleted = no active role
    await invite(PID, "u-target", "view", "u-inviter");
    expect(projectMembersRepo.upsertMember).toHaveBeenCalledWith(PID, "u-target", "view", "u-inviter");
  });
});

describe("changeRole", () => {
  it("throws NotFound when target has no active membership", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    await expect(changeRole(PID, "u-target", "edit")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects PATCH'ing the owner's role with Conflict", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("owner");
    await expect(changeRole(PID, "u-owner", "edit")).rejects.toBeInstanceOf(ConflictError);
    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
  });

  it("updates an edit member to view", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("edit");
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(true);
    await changeRole(PID, "u-target", "view");
    expect(projectMembersRepo.updateRole).toHaveBeenCalledWith(PID, "u-target", "view");
  });

  it("translates a stale row (updateRole returns false) into NotFound", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("edit");
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(false);
    await expect(changeRole(PID, "u-target", "view")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("remove", () => {
  it("throws NotFound when target has no active membership", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    await expect(remove(PID, "u-target")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects removing the owner with Conflict", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("owner");
    await expect(remove(PID, "u-owner")).rejects.toBeInstanceOf(ConflictError);
    expect(projectMembersRepo.softDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a non-owner member", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("edit");
    vi.mocked(projectMembersRepo.softDelete).mockResolvedValueOnce(true);
    await remove(PID, "u-target");
    expect(projectMembersRepo.softDelete).toHaveBeenCalledWith(PID, "u-target");
  });
});
