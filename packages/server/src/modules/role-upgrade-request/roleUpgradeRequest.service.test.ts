// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * roleUpgradeRequest.service unit tests — request / approve / reject.
 *
 * The service composes notification + projectMembers writes in a
 * single tx, so tests focus on:
 *   - request: viewer creates one notification in the owner's inbox
 *   - approve: gate the request → mark-read CAS (decide-once) → role-bump
 *     + approved notification
 *   - reject: gate the request → mark-read CAS → rejected notification
 *
 * The mark-read CAS returning false (a concurrent decision already won) is
 * covered as its own case; the real-Postgres concurrency invariant lives in
 * `__tests__/integration/role-upgrade-decision-concurrency.integration.test.ts`.
 *
 * Repo + notification.service are mocked; db.transaction is mocked to
 * run the callback inline so transactional code paths execute without
 * a real PG connection.
 *
 * Spec: access-permission design (2026-05-28) § 6.3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type * as NotificationServiceModule from "../notification/notification.service.js";

// `db` (transaction), `projectMembersRepo`, and the error classes all
// come from `@breatic/core` (the repo + db handle live there; the repo
// moved over in the auth-unification PR). The whole barrel is mocked —
// not spread-from-actual — because importing real `@breatic/core` pulls
// the `ai` SDK + opentelemetry transitive deps vitest's ESM resolver
// chokes on. `db.transaction` runs the callback inline so the
// approve/reject transactional paths execute without a real PG
// connection. Error classes are defined in the factory so the service's
// `throw` and the test's `toBeInstanceOf` share one constructor.
vi.mock("@breatic/core", () => {
  class NotFoundError extends Error {}
  class ForbiddenError extends Error {}
  class ValidationError extends Error {}
  return {
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ marker: "fake-tx" }),
      ),
    },
    projectMembersRepo: {
      updateRole: vi.fn(),
    },
    NotFoundError,
    ForbiddenError,
    ValidationError,
  };
});
vi.mock("../notification/notification.repo.js", () => ({
  create: vi.fn(),
  findById: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock("../notification/notification.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NotificationServiceModule>();
  return {
    ...actual,
    createRoleUpgradeRequest: vi.fn(),
    createRoleUpgradeApproved: vi.fn(),
    createRoleUpgradeRejected: vi.fn(),
  };
});
// The request / approve / reject paths resolve the actor's display identity
// (name + personal-studio slug = @handle) for the bell payload via studio.service.
vi.mock("../studio/studio.service.js", () => ({
  getPersonalStudioProfilesByUserIds: vi.fn(),
}));

import * as notificationRepo from "../notification/notification.repo.js";
import * as notificationService from "../notification/notification.service.js";
import * as studioService from "../studio/studio.service.js";
import { projectMembersRepo } from "@breatic/core";
import * as roleUpgradeRequestService from "./roleUpgradeRequest.service.js";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "@breatic/core";

const OWNER = "u-owner";
const VIEWER = "u-viewer";
const PID = "p-1";
const NID = "n-1";
const VIEWER_PROFILE = { name: "Vicky Viewer", slug: "vicky" };
const OWNER_PROFILE = { name: "Olivia Owner", slug: "olivia" };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no actor profile resolved (callers fall back to ""). Happy-path
  // tests override with a specific name + slug (@handle) per the bell payload.
  vi.mocked(
    studioService.getPersonalStudioProfilesByUserIds,
  ).mockResolvedValue(new Map());
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
    expiresAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("request", () => {
  it("resolves the requester's identity (name + @handle) into the bell payload", async () => {
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[VIEWER, VIEWER_PROFILE]]));
    vi.mocked(notificationService.createRoleUpgradeRequest).mockResolvedValueOnce(
      fakeRequest(),
    );
    const out = await roleUpgradeRequestService.request({
      ownerUserId: OWNER,
      requesterUserId: VIEWER,
      projectId: PID,
      projectName: "Demo",
      projectSlug: "demo-slug",
      message: "Need to edit",
    });
    expect(out.id).toBe(NID);
    expect(
      studioService.getPersonalStudioProfilesByUserIds,
    ).toHaveBeenCalledWith([VIEWER]);
    expect(
      notificationService.createRoleUpgradeRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER,
        projectId: PID,
        payload: expect.objectContaining({
          requesterUserId: VIEWER,
          requesterName: "Vicky Viewer",
          requesterHandle: "vicky",
          requestedRole: "editor",
          message: "Need to edit",
        }),
      }),
    );
  });
});

describe("approve", () => {
  it("happy path — bumps role + creates approved notification (decider identity) + marks request read", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(true);
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[OWNER, OWNER_PROFILE]]));
    vi.mocked(notificationService.createRoleUpgradeApproved).mockResolvedValueOnce(
      fakeRequest({ type: "access.role_upgrade_approved" }),
    );
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(true);

    await roleUpgradeRequestService.approve({
      notificationId: NID,
      ownerUserId: OWNER,
      projectName: "Demo",
      projectSlug: "demo-slug",
    });

    expect(projectMembersRepo.updateRole).toHaveBeenCalledWith(
      PID,
      VIEWER,
      "editor",
      expect.anything(),
    );
    expect(
      studioService.getPersonalStudioProfilesByUserIds,
    ).toHaveBeenCalledWith([OWNER]);
    expect(
      notificationService.createRoleUpgradeApproved,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: VIEWER,
        projectId: PID,
        payload: expect.objectContaining({
          deciderName: "Olivia Owner",
          deciderHandle: "olivia",
        }),
      }),
    );
    expect(notificationRepo.markRead).toHaveBeenCalledWith(
      NID,
      OWNER,
      expect.anything(),
    );
  });

  it("throws NotFound when the request notification doesn't exist", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(null);
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
        projectSlug: "demo-slug",
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
        projectSlug: "demo-slug",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
  });

  it("throws Validation when the notification is not a role-upgrade-request type", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(
      fakeRequest({ type: "studio.member_invited" }),
    );
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
        projectSlug: "demo-slug",
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
        projectSlug: "demo-slug",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFound when role bump fails (requester no longer a member)", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(true);
    vi.mocked(projectMembersRepo.updateRole).mockResolvedValueOnce(false);
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
        projectSlug: "demo-slug",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      notificationService.createRoleUpgradeApproved,
    ).not.toHaveBeenCalled();
  });

  it("throws NotFound and bumps nothing when a concurrent decision already won (mark-read CAS lost)", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    // The CAS mark-read returns false → another decision flipped read_at first.
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(false);
    await expect(
      roleUpgradeRequestService.approve({
        notificationId: NID,
        ownerUserId: OWNER,
        projectName: "Demo",
        projectSlug: "demo-slug",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Loser does no work: no role bump, no approved notification.
    expect(projectMembersRepo.updateRole).not.toHaveBeenCalled();
    expect(
      notificationService.createRoleUpgradeApproved,
    ).not.toHaveBeenCalled();
  });
});

describe("reject", () => {
  it("creates a rejected notification + marks request read; no role bump", async () => {
    vi.mocked(notificationRepo.findById).mockResolvedValueOnce(fakeRequest());
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[OWNER, OWNER_PROFILE]]));
    vi.mocked(notificationService.createRoleUpgradeRejected).mockResolvedValueOnce(
      fakeRequest({ type: "access.role_upgrade_rejected" }),
    );
    vi.mocked(notificationRepo.markRead).mockResolvedValueOnce(true);

    await roleUpgradeRequestService.reject({
      notificationId: NID,
      ownerUserId: OWNER,
      projectName: "Demo",
      projectSlug: "demo-slug",
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
          deciderName: "Olivia Owner",
          deciderHandle: "olivia",
          reason: "Too many editors already",
        }),
      }),
    );
    expect(notificationRepo.markRead).toHaveBeenCalledWith(
      NID,
      OWNER,
      expect.anything(),
    );
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
        projectSlug: "demo-slug",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
