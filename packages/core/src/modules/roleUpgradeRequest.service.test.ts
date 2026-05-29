/**
 * roleUpgradeRequest.service unit tests — request / approve / reject.
 *
 * The service composes notification + projectMembers writes in a
 * single tx, so tests focus on:
 *   - request: viewer creates one notification in the owner's inbox
 *   - approve: gate the request, then role-bump + double notification
 *     + mark-read happen
 *   - reject: gate the request, then rejected-notification + mark-read
 *
 * Repo + notification.service are mocked; db.transaction is mocked to
 * run the callback inline so transactional code paths execute without
 * a real PG connection.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 6.3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type * as NotificationServiceModule from "./notification.service.js";

vi.mock("../db/client.js", () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ marker: "fake-tx" }),
    ),
  },
}));
vi.mock("./notification.repo.js", () => ({
  create: vi.fn(),
  findById: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock("./notification.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NotificationServiceModule>();
  return {
    ...actual,
    createRoleUpgradeRequest: vi.fn(),
    createRoleUpgradeApproved: vi.fn(),
    createRoleUpgradeRejected: vi.fn(),
  };
});
vi.mock("./projectMembers.repo.js", () => ({
  updateRole: vi.fn(),
}));

import * as notificationRepo from "./notification.repo.js";
import * as notificationService from "./notification.service.js";
import * as projectMembersRepo from "./projectMembers.repo.js";
import * as roleUpgradeRequestService from "./roleUpgradeRequest.service.js";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "../errors.js";

const OWNER = "u-owner";
const VIEWER = "u-viewer";
const PID = "p-1";
const NID = "n-1";

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeRequest(overrides: Partial<{
  id: string;
  userId: string;
  type: string;
  projectId: string | null;
  readAt: Date | null;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    id: overrides.id ?? NID,
    userId: overrides.userId ?? OWNER,
    type: overrides.type ?? "access.role_upgrade_request",
    payload: overrides.payload ?? { requesterUserId: VIEWER },
    projectId: overrides.projectId === undefined ? PID : overrides.projectId,
    readAt: overrides.readAt ?? null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("request", () => {
  it("delegates to notificationService.createRoleUpgradeRequest with the right payload", async () => {
    vi.mocked(notificationService.createRoleUpgradeRequest).mockResolvedValueOnce(
      fakeRequest(),
    );
    const out = await roleUpgradeRequestService.request({
      ownerUserId: OWNER,
      requesterUserId: VIEWER,
      projectId: PID,
      projectName: "Demo",
      message: "Need to edit",
    });
    expect(out.id).toBe(NID);
    expect(
      notificationService.createRoleUpgradeRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER,
        projectId: PID,
        payload: expect.objectContaining({
          requesterUserId: VIEWER,
          requestedRole: "edit",
          message: "Need to edit",
        }),
      }),
    );
  });
});

describe("approve", () => {
  it("happy path — bumps role + creates approved notification + marks request read", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(true);
    vi.mocked(notificationService.createRoleUpgradeApproved).mockResolvedValueOnce(
      fakeRequest({ type: "access.role_upgrade_approved" }),
    );
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(true);

    await roleUpgradeRequestService.approve({
      notificationId: NID,
      ownerUserId: OWNER,
      projectName: "Demo",
    });

    expect(projectMembersRepo.updateRole).toHaveBeenCalledWith(
      PID,
      VIEWER,
      "edit",
    );
    expect(
      notificationService.createRoleUpgradeApproved,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: VIEWER,
        projectId: PID,
      }),
    );
    expect(notificationRepo.markRead).toHaveBeenCalledWith(NID, OWNER);
  });

  it("throws NotFound when the request notification doesn't exist", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(null);
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
  });

  it("throws Forbidden when the notification belongs to a different owner", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(
      fakeRequest({ userId: "u-stranger" }),
    );
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
  });

  it("throws Validation when the notification is not a role-upgrade-request type", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(
      fakeRequest({ type: "access.member_joined" }),
    );
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws NotFound when the request was already decided (read)", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(
      fakeRequest({ readAt: new Date() }),
    );
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFound when role bump fails (requester no longer a member)", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(false);
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      notificationService.createRoleUpgradeApproved,
    ).not.toHaveBeenCalled();
  });
});

describe("reject", () => {
  it("creates a rejected notification + marks request read; no role bump", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    vi.mocked(notificationService.createRoleUpgradeRejected).mockResolvedValueOnce(
      fakeRequest({ type: "access.role_upgrade_rejected" }),
    );
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(true);

    await roleUpgradeRequestService.reject({
      notificationId: NID,
      ownerUserId: OWNER,
      projectName: "Demo",
      reason: "Too many editors already",
    });

    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
    expect(
      notificationService.createRoleUpgradeRejected,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: VIEWER,
        projectId: PID,
        payload: expect.objectContaining({
          reason: "Too many editors already",
        }),
      }),
    );
    expect(notificationRepo.markRead).toHaveBeenCalledWith(NID, OWNER);
  });

  it("throws Forbidden when the notification belongs to a different owner", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(
      fakeRequest({ userId: "u-stranger" }),
    );
    await expect(
      roleUpgradeRequestService.reject({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
