// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/core";

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { UserEntity } from "@breatic/shared";

const mocks = vi.hoisted(() => ({
  findProjectCandidates: vi.fn(),
  findStudioCandidates: vi.fn(),
  claimInvitation: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof MockModule0>()),
  logger: { error: mocks.error },
}));

vi.mock("@server/modules/invitation/invitation-lifecycle.service.js", () => ({
  invitationRepo: (kind: "project" | "studio") => ({
    findPendingEmailCandidates: kind === "project" ? mocks.findProjectCandidates : mocks.findStudioCandidates,
  }),
  claimInvitation: mocks.claimInvitation,
}));

import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";

const USER: UserEntity = {
  id: "invitee", email: "Invitee@Example.Test", emailVerified: true,
  googleId: null, locale: "en", membershipTier: "base",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"), deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findProjectCandidates.mockResolvedValue([]);
  mocks.findStudioCandidates.mockResolvedValue([]);
  mocks.claimInvitation.mockReset().mockResolvedValue(undefined);
});

describe("email invitation compensation", () => {
  it("does not scan or convert for an unverified account", async () => {
    await claimEmailInvitations({ ...USER, emailVerified: false });

    expect(mocks.findProjectCandidates).not.toHaveBeenCalled();
    expect(mocks.findStudioCandidates).not.toHaveBeenCalled();
    expect(mocks.claimInvitation).not.toHaveBeenCalled();
  });

  it("scans both invitation kinds using the normalized verified address", async () => {
    mocks.findProjectCandidates.mockResolvedValue([{ id: "project-invite", targetId: "project" }]);
    mocks.findStudioCandidates.mockResolvedValue([{ id: "studio-invite", targetId: "studio" }]);

    await claimEmailInvitations(USER);

    expect(mocks.findProjectCandidates).toHaveBeenCalledExactlyOnceWith("invitee@example.test");
    expect(mocks.findStudioCandidates).toHaveBeenCalledExactlyOnceWith("invitee@example.test");
    expect(mocks.claimInvitation.mock.calls).toEqual([
      ["project", "project-invite", "project", "invitee"],
      ["studio", "studio-invite", "studio", "invitee"],
    ]);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("continues with the next row and invitation kind after one conversion fails", async () => {
    const failure = new Error("notification transaction failed");
    mocks.findProjectCandidates.mockResolvedValue([
      { id: "failed-invite", targetId: "project" },
      { id: "next-invite", targetId: "another-project" },
    ]);
    mocks.findStudioCandidates.mockResolvedValue([{ id: "studio-invite", targetId: "studio" }]);
    mocks.claimInvitation.mockRejectedValueOnce(failure);

    await expect(claimEmailInvitations(USER)).resolves.toBeUndefined();

    expect(mocks.claimInvitation.mock.calls).toEqual([
      ["project", "failed-invite", "project", "invitee"],
      ["project", "next-invite", "another-project", "invitee"],
      ["studio", "studio-invite", "studio", "invitee"],
    ]);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith({
      err: failure, ctx: { userId: "invitee", kind: "project", invitationId: "failed-invite" },
    }, "email_invitation_claim_failed");
  });

  it("returns after a candidate scan failure and retries on the next authenticated call", async () => {
    const failure = new Error("database unavailable");
    mocks.findProjectCandidates.mockRejectedValueOnce(failure);
    mocks.findProjectCandidates.mockResolvedValueOnce([{ id: "retry-invite", targetId: "project" }]);

    await expect(claimEmailInvitations(USER)).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith({
      err: failure, ctx: { userId: "invitee" },
    }, "email_invitation_claim_failed");

    await claimEmailInvitations(USER);

    expect(mocks.findProjectCandidates).toHaveBeenCalledTimes(2);
    expect(mocks.claimInvitation.mock.calls).toEqual([
      ["project", "retry-invite", "project", "invitee"],
    ]);
  });

  it("keeps every later candidate eligible independently of earlier conversion failures", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
      async (failures) => {
        vi.clearAllMocks();
        const candidates = failures.map((_failed, index) => ({ id: `invite-${index}`, targetId: `project-${index}` }));
        mocks.findProjectCandidates.mockResolvedValue(candidates);
        mocks.findStudioCandidates.mockResolvedValue([{ id: "studio-invite", targetId: "studio" }]);
        mocks.claimInvitation.mockReset().mockImplementation(async (_kind: string, id: string) => {
          const index = candidates.findIndex((candidate) => candidate.id === id);
          if (index >= 0 && failures[index]) throw new Error("candidate conversion failed");
        });

        await claimEmailInvitations(USER);

        expect(mocks.claimInvitation.mock.calls).toEqual([
          ...candidates.map((candidate) => ["project", candidate.id, candidate.targetId, "invitee"]),
          ["studio", "studio-invite", "studio", "invitee"],
        ]);
        expect(mocks.error).toHaveBeenCalledTimes(failures.filter(Boolean).length);
      },
    ), { numRuns: 40 });
  });
});
