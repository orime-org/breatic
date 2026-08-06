// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Role-upgrade request route tests — the POST submission gate.
 *
 * The owner's decide route used to be tested here too; deciding now happens at
 * `/decisions` for all five flows, and the single-entrance integration suite
 * pins the old PATCH as unrouted.
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

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = {
  Cookie: "breatic_session=valid-token",
  "Content-Type": "application/json",
};
const PID = "11111111-1111-4111-8111-111111111111";
/** The token the service really puts in the owner's bell payload. */
const SHARE_TOKEN = "s".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("viewer");
  // The POST route resolves the owner through the service (prohibition
  // #1 — routes call services, not repos), so drive the service mock.
  mocks.projectMembersService.getOwner.mockResolvedValue("u-owner");
  // The real return shape, token and all: a mock that omitted the token would
  // let the route go on leaking it while the test below stayed green.
  mocks.roleUpgradeRequestService.request.mockResolvedValue({
    requestId: "r-1",
    notification: {
      id: "n-1",
      userId: "u-owner",
      type: "access.role_upgrade_request",
      payload: { shareToken: SHARE_TOKEN, requesterUserId: "u-viewer" },
      projectId: PID,
      readAt: null,
      expiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  mocks.projectService.get.mockResolvedValue({
    id: PID,
    name: "Demo Project",
    studioId: "s-1",
    ownerUserId: "u-owner",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe("POST /projects/:pid/role-upgrade-requests", () => {
  it("returns 201 + notification when caller is viewer + project has owner", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/role-upgrade-requests`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ message: "Please" }),
      },
    );
    expect(res.status).toBe(201);
    expect(mocks.roleUpgradeRequestService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "u-owner",
        projectId: PID,
        message: "Please",
      }),
    );
  });

  it("does not hand the requester the token that answers their own request", async () => {
    // The token names the request to whoever holds it, and the only two
    // responses meant to carry one are the sender's copyable link and the
    // recipient's bell row. The requester is neither: they cannot answer
    // their own upgrade, and there is no share box on this flow.
    //
    // It leaked by shape rather than by intent — the route returned the whole
    // notification it had just written for the OWNER, and `shareToken` rides
    // in that payload. Nothing in the client ever read it.
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/role-upgrade-requests`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ message: "Please" }),
      },
    );

    expect(res.status).toBe(201);
    const body = await res.text();
    expect(body).not.toContain(SHARE_TOKEN);
    expect(body).toContain("r-1");
  });

  it("returns 403 when caller is editor (not viewer)", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("editor");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/role-upgrade-requests`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(403);
    expect(mocks.roleUpgradeRequestService.request).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth cookie", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/role-upgrade-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
  });
});

