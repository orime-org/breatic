/**
 * projectMembers.service unit tests — invariant enforcement.
 *
 * Mocks the repo to assert that the service refuses to inviting an
 * existing owner, refuses to PATCH the owner's role, and refuses to
 * soft-delete the owner. The partial unique index in PG is the
 * ultimate guard, but the service catches these earlier with a
 * 409 Conflict so the route layer can surface a friendly message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./projectMembers.repo.js", () => ({
  getRole: vi.fn(),
  listByProjectId: vi.fn(),
  upsertMember: vi.fn(),
  updateRole: vi.fn(),
  softDelete: vi.fn(),
}));

// Stub the Redis pub/sub helper so the unit test runs without an
// ioredis connection. PR-C wired publishMembersChanged into every
// successful service path (after the repo mutates).
vi.mock("../infra/control-events.js", () => ({
  publishMembersChanged: vi.fn().mockResolvedValue(undefined),
}));

import * as repo from "./projectMembers.repo.js";
import {
  invite,
  changeRole,
  remove,
} from "./projectMembers.service.js";
import { ConflictError, NotFoundError } from "../errors.js";

const PID = "p1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invite", () => {
  it("rejects inviting an existing owner with Conflict", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce("owner");
    await expect(invite(PID, "u-owner", "edit", "u-owner")).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(repo.upsertMember).not.toHaveBeenCalled();
  });

  it("upserts a new member when target is not the owner", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce(null);
    await invite(PID, "u-target", "edit", "u-inviter");
    expect(repo.upsertMember).toHaveBeenCalledWith(PID, "u-target", "edit", "u-inviter");
  });

  it("revives a previously-removed member (repo upsert handles deletedAt clear)", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce(null); // soft-deleted = no active role
    await invite(PID, "u-target", "view", "u-inviter");
    expect(repo.upsertMember).toHaveBeenCalledWith(PID, "u-target", "view", "u-inviter");
  });
});

describe("changeRole", () => {
  it("throws NotFound when target has no active membership", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce(null);
    await expect(changeRole(PID, "u-target", "edit")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects PATCH'ing the owner's role with Conflict", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce("owner");
    await expect(changeRole(PID, "u-owner", "edit")).rejects.toBeInstanceOf(ConflictError);
    expect(repo.updateRole).not.toHaveBeenCalled();
  });

  it("updates an edit member to view", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce("edit");
    vi.mocked(repo.updateRole).mockResolvedValueOnce(true);
    await changeRole(PID, "u-target", "view");
    expect(repo.updateRole).toHaveBeenCalledWith(PID, "u-target", "view");
  });

  it("translates a stale row (updateRole returns false) into NotFound", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce("edit");
    vi.mocked(repo.updateRole).mockResolvedValueOnce(false);
    await expect(changeRole(PID, "u-target", "view")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("remove", () => {
  it("throws NotFound when target has no active membership", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce(null);
    await expect(remove(PID, "u-target")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects removing the owner with Conflict", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce("owner");
    await expect(remove(PID, "u-owner")).rejects.toBeInstanceOf(ConflictError);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a non-owner member", async () => {
    vi.mocked(repo.getRole).mockResolvedValueOnce("edit");
    vi.mocked(repo.softDelete).mockResolvedValueOnce(true);
    await remove(PID, "u-target");
    expect(repo.softDelete).toHaveBeenCalledWith(PID, "u-target");
  });
});
