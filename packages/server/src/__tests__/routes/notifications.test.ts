// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Notifications route tests — list / count / mark-read / read-all.
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

// These tests stay about the ROUTE (auth, status codes, envelope); resolving
// names and merging regions are proven against a real database in
// notification-id-refs and cross-region-reads integration tests.
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
const NID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /users/me/notifications", () => {
  it("returns 200 + unread list by default", async () => {
    mocks.notificationService.listFeed.mockResolvedValueOnce({
      items: [
        {
          id: NID,
          userId: "u-1",
          type: "access.role_upgrade_request",
          payload: { requesterUserId: "u-2" },
          projectId: "p-1",
          readAt: null,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          region: null,
        },
      ],
      resolved: { users: {}, studios: {}, projects: {} },
      unavailableRegions: [],
    });
    const app = createApp();
    const res = await app.request(`/api/v1/users/me/notifications`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: unknown[]; resolved: unknown };
    };
    // The envelope now carries the page plus the identities its ids resolve to.
    expect(body.data.items).toHaveLength(1);
    expect(body.data.resolved).toBeDefined();
    expect(mocks.notificationService.listFeed).toHaveBeenCalledWith(expect.any(String), true);
  });

  it("returns the full history when ?unread=false", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/users/me/notifications?unread=false`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(mocks.notificationService.listFeed).toHaveBeenCalledWith(expect.any(String), false);
  });

  it("returns 401 when no auth cookie", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/users/me/notifications`);
    expect(res.status).toBe(401);
  });
});

describe("GET /users/me/notifications/count", () => {
  it("returns 200 + unread count", async () => {
    mocks.notificationService.countFeed.mockResolvedValueOnce({ count: 7, unavailableRegions: [] });
    const app = createApp();
    const res = await app.request(`/api/v1/users/me/notifications/count`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(7);
  });
});

describe("PATCH /users/me/notifications/:id/read", () => {
  it("returns 200 + ok when service succeeds", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/users/me/notifications/${NID}/read`,
      { method: "PATCH", headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(mocks.notificationService.markReadIn).toHaveBeenCalledWith(
      NID,
      expect.any(String),
      null,
    );
  });

  it("marks it in the region the bell named", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/users/me/notifications/${NID}/read?region=sg`,
      { method: "PATCH", headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(mocks.notificationService.markReadIn).toHaveBeenCalledWith(NID, expect.any(String), "sg");
  });
});

describe("POST /users/me/notifications/read-all", () => {
  it("returns 200 + count from service", async () => {
    mocks.notificationService.markAllReadEverywhere.mockResolvedValueOnce(3);
    const app = createApp();
    const res = await app.request(`/api/v1/users/me/notifications/read-all`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(3);
  });
});
