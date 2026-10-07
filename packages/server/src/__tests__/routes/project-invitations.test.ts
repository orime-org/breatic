// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project invitations route — what the owner gets back from sending an invite.
 *
 * The invitee is reached through the bell and the invite email, both of which
 * carry the decision link; the owner's response carries neither the link nor
 * the token it is built from.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
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

const { createInvite } = vi.hoisted(() => ({ createInvite: vi.fn() }));
vi.mock("@server/modules/project-invite/projectInvite.service.js", () => ({
  createInvite,
  listPending: vi.fn().mockResolvedValue([]),
  revokeInvite: vi.fn(),
}));

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "share-token-not-for-the-owner";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("owner");
  createInvite.mockResolvedValue({
    invitationId: "inv-1",
    shareToken: TOKEN,
    inviteeUserId: "u-2",
    inviteeEmail: "b@x.com",
  });
});

describe("POST /projects/:pid/invitations", () => {
  it("answers 201 with ok and carries no link or token back to the owner", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/invitations`, {
      method: "POST",
      headers: { ...AUTH, Origin: "https://app.test" },
      body: JSON.stringify({ email: "b@x.com", role: "viewer" }),
    });

    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ data: { ok: true } });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("/decision");
    expect(createInvite).toHaveBeenCalledWith(PID, "user-1", "b@x.com", "viewer", expect.any(String));
  });
});
