// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * notification.service unit tests — typed constructors + list / mark
 * read semantics.
 *
 * Repo is mocked; tests verify the service maps the right payload
 * into the right `type` + targets the right `userId` (since user-mix
 * bugs here would leak notifications across accounts).
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 7.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./notification.repo.js", () => ({
  create: vi.fn(),
  listUnreadByUser: vi.fn(),
  listAllByUser: vi.fn(),
  countUnread: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  findById: vi.fn(),
}));

import * as notificationRepo from "./notification.repo.js";
import * as notificationService from "./notification.service.js";
import { NotFoundError } from "@breatic/core";

const OWNER = "u-owner";
const REQUESTER = "u-viewer";
const PID = "p-1";
const NID = "n-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRoleUpgradeRequest", () => {
  it("inserts a row addressed to the owner with the right type + payload", async () => {
    vi.mocked(notificationRepo.create).mockResolvedValueOnce({
      id: NID,
      userId: OWNER,
      type: "access.role_upgrade_request",
      payload: { requesterUserId: REQUESTER },
      projectId: PID,
      readAt: null,
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const out = await notificationService.createRoleUpgradeRequest({
      ownerUserId: OWNER,
      projectId: PID,
      payload: {
        requesterUserId: REQUESTER,
        projectName: "Demo",
        requestedRole: "editor",
        message: "please",
      },
    });
    expect(out.id).toBe(NID);
    const args = vi.mocked(notificationRepo.create).mock.calls[0]?.[0];
    expect(args?.userId).toBe(OWNER);
    expect(args?.type).toBe("access.role_upgrade_request");
    expect(args?.projectId).toBe(PID);
    expect(args?.payload).toMatchObject({
      requesterUserId: REQUESTER,
      requestedRole: "editor",
    });
  });
});

describe("createRoleUpgradeApproved / Rejected", () => {
  it("approved notification targets the requester (not the owner)", async () => {
    vi.mocked(notificationRepo.create).mockResolvedValueOnce({
      id: NID,
      userId: REQUESTER,
      type: "access.role_upgrade_approved",
      payload: {},
      projectId: PID,
      readAt: null,
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await notificationService.createRoleUpgradeApproved({
      requesterUserId: REQUESTER,
      projectId: PID,
      payload: { projectName: "Demo", newRole: "editor" },
    });
    const args = vi.mocked(notificationRepo.create).mock.calls[0]?.[0];
    expect(args?.userId).toBe(REQUESTER);
    expect(args?.type).toBe("access.role_upgrade_approved");
  });

  it("rejected notification targets the requester", async () => {
    vi.mocked(notificationRepo.create).mockResolvedValueOnce({
      id: NID,
      userId: REQUESTER,
      type: "access.role_upgrade_rejected",
      payload: {},
      projectId: PID,
      readAt: null,
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await notificationService.createRoleUpgradeRejected({
      requesterUserId: REQUESTER,
      projectId: PID,
      payload: { projectName: "Demo", reason: "Too many editors" },
    });
    const args = vi.mocked(notificationRepo.create).mock.calls[0]?.[0];
    expect(args?.userId).toBe(REQUESTER);
    expect(args?.type).toBe("access.role_upgrade_rejected");
  });
});

describe("createMemberJoined", () => {
  it("notification targets the owner with the new member's id in payload", async () => {
    const newMember = "u-newcomer";
    vi.mocked(notificationRepo.create).mockResolvedValueOnce({
      id: NID,
      userId: OWNER,
      type: "access.member_joined",
      payload: { newMemberUserId: newMember },
      projectId: PID,
      readAt: null,
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await notificationService.createMemberJoined({
      ownerUserId: OWNER,
      projectId: PID,
      payload: {
        newMemberUserId: newMember,
        projectName: "Demo",
        role: "viewer",
      },
    });
    const args = vi.mocked(notificationRepo.create).mock.calls[0]?.[0];
    expect(args?.userId).toBe(OWNER);
    expect(args?.type).toBe("access.member_joined");
    expect(args?.payload).toMatchObject({ newMemberUserId: newMember });
  });
});

describe("markRead", () => {
  it("delegates to repo + does not throw when repo returns true", async () => {
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(true);
    await expect(
      notificationService.markRead(NID, OWNER),
    ).resolves.toBeUndefined();
    expect(notificationRepo.markRead).toHaveBeenCalledWith(NID, OWNER);
  });

  it("throws NotFound when repo returns false (already-read / wrong user / missing)", async () => {
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(false);
    await expect(notificationService.markRead(NID, OWNER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("listUnread + countUnread + markAllRead", () => {
  it("listUnread delegates to repo", async () => {
    vi.mocked(notificationRepo.listUnreadByUser).mockResolvedValueOnce([]);
    const out = await notificationService.listUnread(OWNER);
    expect(out).toEqual([]);
    expect(notificationRepo.listUnreadByUser).toHaveBeenCalledWith(OWNER);
  });

  it("countUnread returns the repo count", async () => {
    vi.mocked(notificationRepo.countUnread).mockResolvedValueOnce(5);
    const n = await notificationService.countUnread(OWNER);
    expect(n).toBe(5);
  });

  it("markAllRead returns the row count", async () => {
    vi.mocked(notificationRepo.markAllRead).mockResolvedValueOnce(3);
    const n = await notificationService.markAllRead(OWNER);
    expect(n).toBe(3);
  });
});
