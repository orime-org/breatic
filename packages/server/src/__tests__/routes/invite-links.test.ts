// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Share / invite link route tests — create / list / revoke / consume
 * + role gating + invitee_email dispatch path.
 *
 * 2026-05-29 follow-up: body schema now uses an explicit `kind`
 * discriminator ('email' | 'link') instead of inferring from
 * `invitee_email` presence. zod discriminatedUnion enforces the
 * pairing — the kind='email' branch demands invitee_email; the
 * kind='link' branch forbids it. Tests below cover both happy paths
 * + each rejection mode.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

vi.mock("@server/modules/auth/user.repo.js", async () => {
  const { userRepoMock } = await import("../helpers/mock-core.js");
  return userRepoMock();
});

vi.mock("@server/infra/mailer.js", async () => {
  const { mailerMock } = await import("../helpers/mock-core.js");
  return mailerMock();
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = {
  Cookie: "breatic_session=valid-token",
  "Content-Type": "application/json",
};
const PID = "11111111-1111-4111-8111-111111111111";
const LID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("owner");
});

describe("POST /projects/:pid/invite-links", () => {
  it("returns 201 + the link when owner creates a kind='link' (multi-use) link", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ kind: "link", role: "viewer" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("sl-1");
    expect(mocks.shareLinkService.createLink).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "link",
        boundEmail: null,
      }),
    );
    // No invitee_email → no mailer dispatch
    expect(
      mocks.shareInviteMail.buildShareInviteMail,
    ).not.toHaveBeenCalled();
  });

  it("dispatches share invite mail when kind='email' + invitee_email provided", async () => {
    // PR-d 08 TDD backfill: this test originally simplified the
    // assertion to mocks.shareLinkService.createLink because the
    // dispatch helper short-circuited on `if (!inviter) return` —
    // root cause was that mocks.sendMail wasn't exposed on `mocks`
    // so the spy couldn't be re-armed per-test, AND userRepo.
    // getUserById returned a non-null default so inviter was actually
    // populated correctly. The buildShareInviteMail spy IS reached.
    // Restored to the precise contract assertion.
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          kind: "email",
          role: "editor",
          invitee_email: "new@example.com",
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(mocks.shareLinkService.createLink).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PID,
        role: "editor",
        kind: "email",
        boundEmail: "new@example.com",
      }),
    );
    expect(mocks.shareInviteMail.buildShareInviteMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeEmail: "new@example.com",
        // role on the builder comes from the *created link* (mock
        // returns role='viewer'), not the request body. Matches
        // production: builder reads link.role to keep mail copy in
        // sync with what the link actually grants.
      }),
    );
    expect(mocks.sendMail).toHaveBeenCalled();
  });

  it("link creation succeeds even when sendMail throws (graceful degradation)", async () => {
    // PR-d TDD backfill: dispatchInviteeMail is wrapped in try/catch
    // so a mail failure doesn't fail the link creation. Verify the
    // request still 201s + the link is still in shareLinkService.
    mocks.sendMail.mockRejectedValueOnce(new Error("smtp connection lost"));
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          kind: "email",
          role: "viewer",
          invitee_email: "new@example.com",
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(mocks.shareLinkService.createLink).toHaveBeenCalled();
  });

  it("returns 403 when caller is not owner", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("editor");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ kind: "link", role: "viewer" }),
      },
    );
    expect(res.status).toBe(403);
    expect(mocks.shareLinkService.createLink).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid role (owner not grantable)", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ kind: "link", role: "owner" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid invitee_email format", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          kind: "email",
          role: "viewer",
          invitee_email: "not-an-email",
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when kind='email' is missing invitee_email", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ kind: "email", role: "viewer" }),
      },
    );
    expect(res.status).toBe(400);
    expect(mocks.shareLinkService.createLink).not.toHaveBeenCalled();
  });

  it("returns 400 when kind='link' includes an invitee_email", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          kind: "link",
          role: "viewer",
          invitee_email: "stray@example.com",
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(mocks.shareLinkService.createLink).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:pid/invite-links", () => {
  it("returns 200 + link list when owner", async () => {
    mocks.shareLinkService.listByProject.mockResolvedValue([
      {
        id: LID,
        projectId: PID,
        createdByUserId: "u-1",
        token: "abc",
        role: "viewer",
        kind: "link",
        boundEmail: null,
        consumedAt: null,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ]);
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("returns 403 when caller is not owner", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("viewer");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      { headers: AUTH },
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /projects/:pid/invite-links/:linkId", () => {
  it("returns 200 + ok when owner revokes a link", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links/${LID}`,
      { method: "DELETE", headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(mocks.shareLinkService.revokeLink).toHaveBeenCalledWith(LID);
  });

  it("returns 403 when caller is not owner", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("editor");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links/${LID}`,
      { method: "DELETE", headers: AUTH },
    );
    expect(res.status).toBe(403);
    expect(mocks.shareLinkService.revokeLink).not.toHaveBeenCalled();
  });
});

describe("POST /invite-links/:token/consume", () => {
  it("returns 200 + resolved link for any authenticated caller", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/invite-links/abc-token/consume`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("sl-1");
    // The route passes the caller's user id (consumer) + email so the
    // service can enroll them as a project member.
    expect(mocks.shareLinkService.consumeLink).toHaveBeenCalledWith(
      "abc-token",
      "user-1",
      "u@x.com",
    );
  });

  it("returns 401 when no auth cookie", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/invite-links/abc-token/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
