/**
 * Share / invite link route tests — create / list / revoke / consume
 * + role gating + invitee_email dispatch path.
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
  it("returns 201 + the link when owner creates a single-use copy link", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ role: "view" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("sl-1");
    expect(mocks.shareLinkService.createLink).toHaveBeenCalled();
    // No invitee_email → no mailer dispatch
    expect(
      mocks.accessRequestMail.buildShareInviteMail,
    ).not.toHaveBeenCalled();
  });

  it("dispatches share invite mail when invitee_email is provided", async () => {
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
          role: "edit",
          invitee_email: "new@example.com",
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(mocks.shareLinkService.createLink).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PID,
        role: "edit",
        boundEmail: "new@example.com",
      }),
    );
    expect(mocks.accessRequestMail.buildShareInviteMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeEmail: "new@example.com",
        // role on the builder comes from the *created link* (mock
        // returns role='view'), not the request body. Matches
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
          role: "view",
          is_permanent: false,
          invitee_email: "new@example.com",
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(mocks.shareLinkService.createLink).toHaveBeenCalled();
  });

  it("returns 403 when caller is not owner", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("edit");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/invite-links`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ role: "view" }),
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
        body: JSON.stringify({ role: "owner", is_permanent: false }),
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
          role: "view",
          is_permanent: false,
          invitee_email: "not-an-email",
        }),
      },
    );
    expect(res.status).toBe(400);
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
        role: "view",
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
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("view");
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
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("edit");
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
    expect(mocks.shareLinkService.consumeLink).toHaveBeenCalledWith(
      "abc-token",
      expect.any(String),
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
