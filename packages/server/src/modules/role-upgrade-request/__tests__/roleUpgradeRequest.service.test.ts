// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * roleUpgradeRequest.service unit tests — the gates, and what each one leaves
 * behind.
 *
 * A decision is answered days after it was filed, so the service re-checks
 * every premise before acting. Which check fires is only half of it; the other
 * half is what the failure DOES to the request, and the four outcomes are
 * deliberately not the same:
 *
 *   - already handled → 409, row untouched (somebody else already settled it)
 *   - timed out       → 409, row settled `expired`, bell entry retired
 *   - not the owner   → 403, row untouched (still valid for the real owner)
 *   - premise gone    → 409, row settled `expired`, bell entry retired
 *
 * Getting the third one wrong in either direction is a live defect: settle it
 * and a stranger's click burns a request the real owner never saw; skip the
 * check and a former owner decides a project they no longer hold.
 *
 * Everything here is about branch order and side effects, which mocks show
 * precisely. What the row lock actually does under concurrency is not
 * mockable and lives in the integration tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type * as NotificationServiceModule from "../../notification/notification.service.js";

// The service under test appends feed rows via the activity helper — stub it
// out (its own behaviour is covered by the projectActivity tests).
vi.mock("@server/modules/activity/projectActivity.service.js", () => ({
  recordProjectActivity: vi.fn(async () => {}),
}));

// `db` (transaction), `projectMembersRepo` and the error classes all come from
// `@breatic/core`. The whole barrel is mocked — not spread from actual —
// because importing the real one pulls the `ai` SDK and opentelemetry deps
// vitest's ESM resolver chokes on. `db.transaction` runs its callback inline so
// the transactional paths execute without a PG connection. The error classes
// are defined in the factory so the service's `throw` and the test's
// `toBeInstanceOf` share one constructor.
vi.mock("@breatic/core", () => {
  class NotFoundError extends Error {}
  class ForbiddenError extends Error {}
  class ConflictError extends Error {}
  return {
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ marker: "fake-tx" }),
      ),
    },
    projectMembersRepo: {
      getRole: vi.fn(),
      updateRoleUnderOwner: vi.fn(),
    },
    NotFoundError,
    ForbiddenError,
    ConflictError,
  };
});
vi.mock("../roleUpgradeRequests.repo.js", () => ({
  createPending: vi.fn(),
  attachNotification: vi.fn(),
  lockRequest: vi.fn(),
  settleIfPending: vi.fn(async () => true),
  cancelIfPending: vi.fn(),
  findLiveForRequester: vi.fn(),
}));
vi.mock("../../notification/notification.repo.js", () => ({
  create: vi.fn(),
  findById: vi.fn(),
  markRead: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("../../notification/notification.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NotificationServiceModule>();
  return {
    ...actual,
    createRoleUpgradeRequest: vi.fn(),
    createRoleUpgradeApproved: vi.fn(),
    createRoleUpgradeRejected: vi.fn(),
  };
});
// The request / approve / reject paths resolve the actor's display identity
// (name + personal-studio slug = @handle) for the bell payload.
vi.mock("../../studio/studio.service.js", () => ({
  getPersonalStudioProfilesByUserIds: vi.fn(),
}));
// The outcome notification's project label is read from the repo with the
// transaction's own handle — reading it through the service would reach for a
// second pooled connection while the first is still held.
vi.mock("../../project/project.repo.js", () => ({
  getProjectById: vi.fn(),
  lockLiveProject: vi.fn(),
}));
// The deadline comes from `config/limits.yaml`; pinning it here keeps this
// file away from the YAML loader and makes "both carry the SAME instant" an
// exact assertion rather than an approximate one.
vi.mock("@server/config/limits.js", () => ({
  getDecisionWindowMs: (): number => 7 * 24 * 60 * 60 * 1000,
  getDecisionWindowDays: (): number => 7,
  getDecisionWindowSeconds: (): number => 7 * 24 * 60 * 60,
}));
// The owner's address for the best-effort email, and the transport itself. The
// mail is the half of this flow that nothing else observes: the bell entry is
// visible in the payload assertions, a mail that is never sent is visible
// nowhere.
vi.mock("@server/modules/auth/user.repo.js", () => ({
  getUserById: vi.fn(),
}));
vi.mock("@server/infra/mailer.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
}));

import * as notificationRepo from "../../notification/notification.repo.js";
import * as notificationService from "../../notification/notification.service.js";
import * as studioService from "../../studio/studio.service.js";
import * as projectRepo from "../../project/project.repo.js";
import * as requestsRepo from "../roleUpgradeRequests.repo.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { sendMail } from "@server/infra/mailer.js";
import { projectMembersRepo } from "@breatic/core";
import * as roleUpgradeRequestService from "../roleUpgradeRequest.service.js";
import { NotFoundError, ForbiddenError, ConflictError } from "@breatic/core";

const OWNER = "u-owner";
const VIEWER = "u-viewer";
const PID = "p-1";
const RID = "r-1";
const NID = "n-1";
const VIEWER_PROFILE = { name: "Vicky Viewer", slug: "vicky" };
const OWNER_PROFILE = { name: "Olivia Owner", slug: "olivia" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestsRepo.settleIfPending).mockResolvedValue(true);
  // Default: no actor profile resolved (callers fall back to ""). Happy-path
  // tests override with a specific name + slug (@handle) per the bell payload.
  vi.mocked(
    studioService.getPersonalStudioProfilesByUserIds,
  ).mockResolvedValue(new Map());
  vi.mocked(projectRepo.lockLiveProject).mockResolvedValue(true);
  vi.mocked(userRepo.getUserById).mockResolvedValue({
    id: OWNER,
    email: "olivia@example.com",
  } as Awaited<ReturnType<typeof userRepo.getUserById>>);
  vi.mocked(projectMembersRepo.getRole).mockImplementation(
    async (_projectId: string, userId: string) =>
      userId === OWNER ? "owner" : "viewer",
  );
  vi.mocked(projectRepo.getProjectById).mockResolvedValue({
    id: PID,
    name: "Demo",
    slug: "demo",
  } as Awaited<ReturnType<typeof projectRepo.getProjectById>>);
});

/**
 * A locked request row as the decision path sees it.
 * @param overrides - Fields to vary per case.
 * @returns The locked row.
 */
function lockedRow(
  overrides: Partial<{
    status: string;
    expired: boolean;
    notificationId: string | null;
  }> = {},
): Awaited<ReturnType<typeof requestsRepo.lockRequest>> {
  return {
    id: RID,
    projectId: PID,
    requesterUserId: VIEWER,
    requestedRole: "editor",
    status: (overrides.status ?? "pending") as "pending",
    notificationId:
      overrides.notificationId === undefined ? NID : overrides.notificationId,
    expired: overrides.expired ?? false,
  };
}

/**
 * A notification row, for the constructors that return one.
 * @returns A fake bell entry.
 */
function fakeNotification(): Awaited<
  ReturnType<typeof notificationService.createRoleUpgradeRequest>
> {
  return {
    id: NID,
    userId: OWNER,
    type: "access.role_upgrade_request",
    payload: { requesterUserId: VIEWER },
    projectId: PID,
    readAt: null,
    expiresAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("request", () => {
  it("files the row and the bell entry with one shared deadline", async () => {
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[VIEWER, VIEWER_PROFILE]]));
    vi.mocked(requestsRepo.createPending).mockResolvedValueOnce({
      id: RID,
      shareToken: "t".repeat(64), retiredNotificationIds: [],
    });
    vi.mocked(
      notificationService.createRoleUpgradeRequest,
    ).mockResolvedValueOnce(fakeNotification());

    const before = Date.now();
    const out = await roleUpgradeRequestService.request({
      ownerUserId: OWNER,
      requesterUserId: VIEWER,
      projectId: PID,
      projectName: "Demo",
      message: "Need to edit",
    });

    expect(out.requestId).toBe(RID);
    const filed = vi.mocked(requestsRepo.createPending).mock.calls[0]?.[0];
    const announced = vi.mocked(notificationService.createRoleUpgradeRequest)
      .mock.calls[0]?.[0];
    // Two projections of one fact: a viewer must never see them disagree about
    // when the request dies. Asserted as identity rather than against a fixed
    // instant — pinning a date would only be testing what the mock returns,
    // while THIS is the property the two writes have to share.
    expect(announced?.expiresAt).toEqual(filed?.expiresAt);
    // And it is the configured window out, not some other number.
    const aheadMs = filed!.expiresAt.getTime() - before;
    expect(aheadMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(aheadMs).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 60_000);
    expect(announced?.payload).toEqual(
      expect.objectContaining({
        requesterUserId: VIEWER,
        requesterName: "Vicky Viewer",
        requestedRole: "editor",
        message: "Need to edit",
      }),
    );
  });

  it("emails the owner a link to the same request", async () => {
    // The bell entry only reaches an owner who opens the app. This flow is the
    // one of the five that had no email at all, and a builder with no caller
    // looks exactly like a builder with one — so the assertion is on the
    // transport, not on the template.
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[VIEWER, VIEWER_PROFILE]]));
    vi.mocked(requestsRepo.createPending).mockResolvedValueOnce({
      id: RID,
      shareToken: "t".repeat(64),
      retiredNotificationIds: [],
    });
    vi.mocked(
      notificationService.createRoleUpgradeRequest,
    ).mockResolvedValueOnce(fakeNotification());

    await roleUpgradeRequestService.request({
      ownerUserId: OWNER,
      requesterUserId: VIEWER,
      projectId: PID,
      projectName: "Demo",
      message: "Need to edit",
      origin: "https://app.test",
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendMail).mock.calls[0]?.[0];
    expect(mail?.to).toBe("olivia@example.com");
    // The same token the bell row carries — one request, one link.
    expect(mail?.html).toContain(
      `https://app.test/decision?token=${"t".repeat(64)}`,
    );
    // The reason is the whole basis for the answer, so it travels with it.
    expect(mail?.html).toContain("Need to edit");
  });

  it("skips the email when the caller had no Origin to build a link from", async () => {
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[VIEWER, VIEWER_PROFILE]]));
    vi.mocked(requestsRepo.createPending).mockResolvedValueOnce({
      id: RID,
      shareToken: "t".repeat(64),
      retiredNotificationIds: [],
    });
    vi.mocked(
      notificationService.createRoleUpgradeRequest,
    ).mockResolvedValueOnce(fakeNotification());

    await roleUpgradeRequestService.request({
      ownerUserId: OWNER,
      requesterUserId: VIEWER,
      projectId: PID,
      projectName: "Demo",
    });

    // A link to nowhere is worse than no email; the bell entry still landed.
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("links the bell entry back to the request", async () => {
    // Without the link, nothing can take the entry down when the request ends,
    // and it outlives its own subject.
    vi.mocked(requestsRepo.createPending).mockResolvedValueOnce({
      id: RID,
      shareToken: "t".repeat(64), retiredNotificationIds: [],
    });
    vi.mocked(
      notificationService.createRoleUpgradeRequest,
    ).mockResolvedValueOnce(fakeNotification());

    await roleUpgradeRequestService.request({
      ownerUserId: OWNER,
      requesterUserId: VIEWER,
      projectId: PID,
      projectName: "Demo",
    });

    expect(requestsRepo.attachNotification).toHaveBeenCalledWith(
      RID,
      NID,
      expect.anything(),
    );
  });

  it("turns the one-live-request violation into a conflict", async () => {
    // The index speaks SQLSTATE; the route needs an AppError. Matched on the
    // code rather than the message, which is localised — and on the shape
    // drizzle actually throws inside a transaction: the driver error carrying
    // `code` is hung off `.cause`, so a flat top-level check never fires and
    // the conflict escapes as an unclassified 500.
    vi.mocked(requestsRepo.createPending).mockRejectedValueOnce(
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
        }),
      }),
    );

    await expect(
      roleUpgradeRequestService.request({
        ownerUserId: OWNER,
        requesterUserId: VIEWER,
        projectId: PID,
        projectName: "Demo",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("lets an unrelated failure through unchanged", async () => {
    const boom = new Error("connection reset");
    vi.mocked(requestsRepo.createPending).mockRejectedValueOnce(boom);

    await expect(
      roleUpgradeRequestService.request({
        ownerUserId: OWNER,
        requesterUserId: VIEWER,
        projectId: PID,
        projectName: "Demo",
      }),
    ).rejects.toBe(boom);
  });
});

describe("approve", () => {
  it("promotes, settles, retires the bell entry and announces the outcome", async () => {
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());
    vi.mocked(projectMembersRepo.updateRoleUnderOwner).mockResolvedValueOnce(
      true,
    );
    vi.mocked(
      studioService.getPersonalStudioProfilesByUserIds,
    ).mockResolvedValueOnce(new Map([[OWNER, OWNER_PROFILE]]));

    await roleUpgradeRequestService.approve({
      requestId: RID,
      ownerUserId: OWNER,
    });

    expect(projectMembersRepo.updateRoleUnderOwner).toHaveBeenCalledWith(
      PID,
      VIEWER,
      "viewer",
      "editor",
      OWNER,
      expect.anything(),
    );
    expect(requestsRepo.settleIfPending).toHaveBeenCalledWith(
      RID,
      "approved",
      OWNER,
      expect.anything(),
    );
    expect(notificationRepo.retire).toHaveBeenCalledWith(
      NID,
      expect.anything(),
    );
    expect(
      notificationService.createRoleUpgradeApproved,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: VIEWER,
        projectId: PID,
        payload: expect.objectContaining({
          deciderUserId: OWNER,
          deciderName: "Olivia Owner",
          newRole: "editor",
        }),
      }),
    );
  });

  it("answers 404 when there is no such request", async () => {
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(null);

    await expect(
      roleUpgradeRequestService.approve({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(projectMembersRepo.updateRoleUnderOwner).not.toHaveBeenCalled();
  });

  it("answers 409 for an already-handled request without touching it", async () => {
    // The loser of a concurrent decision lands here. It must not overwrite the
    // winner's terminal status, and it must not retire a bell entry the winner
    // already dealt with.
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(
      lockedRow({ status: "rejected" }),
    );

    await expect(
      roleUpgradeRequestService.approve({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(requestsRepo.settleIfPending).not.toHaveBeenCalled();
    expect(notificationRepo.retire).not.toHaveBeenCalled();
    expect(projectMembersRepo.updateRoleUnderOwner).not.toHaveBeenCalled();
  });

  it("settles a timed-out request instead of leaving it pending forever", async () => {
    // Nobody answered in time, so no other path will ever write this down —
    // "expired" is by definition the case where nothing else runs. Leaving it
    // pending would hold the requester's slot for good.
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(
      lockedRow({ expired: true }),
    );

    await expect(
      roleUpgradeRequestService.approve({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(requestsRepo.settleIfPending).toHaveBeenCalledWith(
      RID,
      "expired",
      null,
      expect.anything(),
    );
    expect(notificationRepo.retire).toHaveBeenCalledWith(
      NID,
      expect.anything(),
    );
    expect(projectMembersRepo.updateRoleUnderOwner).not.toHaveBeenCalled();
  });

  it("refuses a decider who is not the current owner, and leaves the request alone", async () => {
    // The defect this whole flow was rebuilt around: a former owner still
    // holding the bell entry for a project they transferred away. They get 403
    // — and crucially the request survives, because it is still perfectly
    // valid for whoever owns the project now.
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());
    // The caller is no longer the owner.
    vi.mocked(projectMembersRepo.getRole).mockResolvedValue("editor");

    await expect(
      roleUpgradeRequestService.approve({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(requestsRepo.settleIfPending).not.toHaveBeenCalled();
    expect(notificationRepo.retire).not.toHaveBeenCalled();
    expect(projectMembersRepo.updateRoleUnderOwner).not.toHaveBeenCalled();
  });

  it("retires the request when its subject is no longer a viewer", async () => {
    // The conditional write refused: the requester was promoted or removed
    // while the request waited. Nothing to grant, so the request is over.
    //
    // Two `getRole` answers, because the refusal is ambiguous on its own: the
    // gate asks first, and the `!won` branch asks again to find out WHICH
    // premise failed. Both say owner here, so the caller still holds the
    // project and the refusal is about the requester.
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());
    vi.mocked(projectMembersRepo.updateRoleUnderOwner).mockResolvedValueOnce(
      false,
    );

    await expect(
      roleUpgradeRequestService.approve({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(notificationRepo.retire).toHaveBeenCalledWith(
      NID,
      expect.anything(),
    );
    expect(
      notificationService.createRoleUpgradeApproved,
    ).not.toHaveBeenCalled();
  });

  it("leaves the request alone when it is the DECIDER who lost the project", async () => {
    // The same refused write, the other reason: a transfer committed between
    // the gate and the statement. The caller may no longer decide, but the
    // request is still perfectly valid for whoever owns the project now —
    // settling it here would let a stranger destroy it, and the new owner
    // would never see it.
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());
    // The decider lost the project between the gate and the write.
    vi.mocked(projectMembersRepo.getRole).mockImplementation(
      async (_projectId: string, userId: string) =>
        userId === OWNER ? "editor" : "viewer",
    );
    vi.mocked(projectMembersRepo.updateRoleUnderOwner).mockResolvedValueOnce(
      false,
    );

    await expect(
      roleUpgradeRequestService.approve({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(requestsRepo.settleIfPending).not.toHaveBeenCalled();
    expect(notificationRepo.retire).not.toHaveBeenCalled();
  });
});

describe("reject", () => {
  it("settles, retires the bell entry and announces the refusal", async () => {
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());

    await roleUpgradeRequestService.reject({
      requestId: RID,
      ownerUserId: OWNER,
    });

    expect(requestsRepo.settleIfPending).toHaveBeenCalledWith(
      RID,
      "rejected",
      OWNER,
      expect.anything(),
    );
    expect(notificationRepo.retire).toHaveBeenCalledWith(
      NID,
      expect.anything(),
    );
    expect(
      notificationService.createRoleUpgradeRejected,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: VIEWER,
        payload: expect.objectContaining({ deciderUserId: OWNER }),
      }),
    );
  });

  it("never writes a member row", async () => {
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());

    await roleUpgradeRequestService.reject({
      requestId: RID,
      ownerUserId: OWNER,
    });

    expect(projectMembersRepo.updateRoleUnderOwner).not.toHaveBeenCalled();
  });

  it("refuses a decider who is not the current owner", async () => {
    // Rejecting writes no role, but it CONSUMES the request and tells the
    // requester they were turned down. Leaving this open would let a former
    // owner silently burn every request the real owner was meant to answer.
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());
    // The caller is no longer the owner.
    vi.mocked(projectMembersRepo.getRole).mockResolvedValue("editor");

    await expect(
      roleUpgradeRequestService.reject({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      notificationService.createRoleUpgradeRejected,
    ).not.toHaveBeenCalled();
    expect(requestsRepo.settleIfPending).not.toHaveBeenCalled();
  });

  it("retires the request rather than refusing something already granted", async () => {
    vi.mocked(requestsRepo.lockRequest).mockResolvedValueOnce(lockedRow());
    // The requester is already an editor: nothing left to refuse.
    vi.mocked(projectMembersRepo.getRole).mockImplementation(
      async (_projectId: string, userId: string) =>
        userId === OWNER ? "owner" : "editor",
    );

    await expect(
      roleUpgradeRequestService.reject({
        requestId: RID,
        ownerUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(notificationRepo.retire).toHaveBeenCalledWith(
      NID,
      expect.anything(),
    );
    expect(
      notificationService.createRoleUpgradeRejected,
    ).not.toHaveBeenCalled();
  });
});

describe("cancel", () => {
  it("withdraws the request and takes the owner's bell entry down with it", async () => {
    vi.mocked(requestsRepo.cancelIfPending).mockResolvedValueOnce({
      notificationId: NID,
    });

    await roleUpgradeRequestService.cancel(RID, VIEWER);

    expect(requestsRepo.cancelIfPending).toHaveBeenCalledWith(
      RID,
      VIEWER,
      expect.anything(),
    );
    expect(notificationRepo.retire).toHaveBeenCalledWith(
      NID,
      expect.anything(),
    );
  });

  it("answers 404 when the request is not the caller's, or not live", async () => {
    // The repo's guard collapses both into no match, and so does this: telling
    // a stranger apart from a stale click would leak that the request exists.
    vi.mocked(requestsRepo.cancelIfPending).mockResolvedValueOnce(null);

    await expect(
      roleUpgradeRequestService.cancel(RID, VIEWER),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(notificationRepo.retire).not.toHaveBeenCalled();
  });

  it("survives a request that never got a bell entry", async () => {
    vi.mocked(requestsRepo.cancelIfPending).mockResolvedValueOnce({
      notificationId: null,
    });

    await roleUpgradeRequestService.cancel(RID, VIEWER);

    expect(notificationRepo.retire).not.toHaveBeenCalled();
  });
});

/**
 * The decision window, which this flow did not have until now.
 *
 * The other four decision flows (both invites, both transfers) each write a
 * deadline and each refuse a decision made after it. This one wrote nothing
 * and refused nothing, so a request sat in an owner's inbox forever. Bringing
 * it into the shared window is both halves — writing the deadline is what
 * makes it exist, refusing past it is what makes it real. A deadline the
 * system announces and then ignores is worse than none: it would call the
 * request void while still granting editor on it.
 */
// The "decision window" block that used to sit here came from the branch that
// configured the window; it drove `request()` with a `projectSlug` this flow no
// longer takes and asserted through a `fakeRequest` helper for the old return
// shape. Every property it checked is covered by tests that survived the
// merge: the shared deadline by "files the row and the bell entry with one
// shared deadline", the timed-out settle by "settles a timed-out request
// instead of leaving it pending forever", and refusing to answer past the
// deadline by decision-respond's "a timed-out request cannot be answered" —
// which now guards all five flows through the one gate rather than this one.

