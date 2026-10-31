// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return {
    ...domainMock(),
    studioAuthService: { assertStudioRole: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock, mocks: sharedMocks } = await import("../helpers/mock-core.js");
  return {
    ...(await serverModulesMock(importOriginal)),
    studioService: {
      ...sharedMocks.studioService,
      getStudioBySlug: vi.fn().mockResolvedValue({ id: "studio-1", type: "team" }),
    },
  };
});

const invitationMocks = vi.hoisted(() => ({
  createProjectInvite: vi.fn(),
  createStudioInvite: vi.fn(),
}));

vi.mock("@server/modules/project-invite/projectInvite.service.js", () => ({
  createInvite: invitationMocks.createProjectInvite,
  listPending: vi.fn().mockResolvedValue([]),
  revokeInvite: vi.fn(),
}));

vi.mock("@server/modules/studio/studioInvite.service.js", () => ({
  createInvite: invitationMocks.createStudioInvite,
  listPending: vi.fn().mockResolvedValue([]),
  revokeInvite: vi.fn(),
}));

import { createApp } from "@server/app.js";
import { mocks } from "@server/__tests__/helpers/mock-core.js";
import { PROXY_PEER } from "@server/__tests__/helpers/peer.js";

const PID = "11111111-1111-4111-8111-111111111111";
const IP = "203.0.113.9";
const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json", "x-real-ip": IP };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("owner");
  mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 37 });
  invitationMocks.createProjectInvite.mockResolvedValue({ pendingSignup: true });
  invitationMocks.createStudioInvite.mockResolvedValue({ pendingSignup: true });
});

describe("invitation delivery throttles", () => {
  it.each([
    [`/api/v1/projects/${PID}/invitations`, "viewer"],
    ["/api/v1/studio/creative-team/members", "guest"],
  ])("limits %s by the inviter's user id", async (path, role) => {
    const response = await createApp().request(path, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ email: "new@example.test", role }),
    }, PROXY_PEER);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    expect(mocks.checkRateLimit).toHaveBeenCalledOnce();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), [
      { key: "invite:user-1", max: 1000, windowSeconds: 60 },
    ]);
    expect(invitationMocks.createProjectInvite).not.toHaveBeenCalled();
    expect(invitationMocks.createStudioInvite).not.toHaveBeenCalled();
  });

  it("limits the public invitation preview by the trusted client address", async () => {
    const response = await createApp().request(
      `/api/v1/auth/invitation?token=${"b".repeat(64)}`,
      { headers: { "x-real-ip": IP } },
      PROXY_PEER,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    expect(mocks.checkRateLimit).toHaveBeenCalledOnce();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), [
      { key: `invite-preview:${IP}`, max: 1000, windowSeconds: 60 },
    ]);
  });

  it("logs the invitation action and user quota key when a request is limited", async () => {
    const core = await import("@breatic/core");
    await createApp().request(`/api/v1/projects/${PID}/invitations`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ email: "new@example.test", role: "viewer" }),
    }, PROXY_PEER);

    expect(core.logger.warn).toHaveBeenCalledWith({
      actions: ["invite"], keys: ["invite:user-1"],
    }, "rate_limit_hit");
  });
});
