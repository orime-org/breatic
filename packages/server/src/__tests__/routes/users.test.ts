// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Users route tests — batch lookup + cap.
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

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/users", () => {
  it("returns batched display fields — name resolved from the personal studio, sensitive fields stripped", async () => {
    // The display name AND avatar both come from each user's personal studio
    // (pointer model — #1808), read with the address from the global profiles
    // (inner#1955). u2 is mid-onboarding (no studio) → name + avatar null.
    mocks.profilesService.profilesOf.mockResolvedValue(
      new Map([
        ["u1", { name: "alice", handle: "alice", avatarUrl: "https://cdn/a.png", email: "a@x.com", deleted: false }],
        ["u2", { name: null, handle: null, avatarUrl: null, email: "b@x.com", deleted: false }],
      ]),
    );

    const app = createApp();
    const res = await app.request("/api/v1/users?ids=u1,u2", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: "u1",
      email: "a@x.com",
      username: "alice",
      avatar_url: "https://cdn/a.png",
    });
    // u2 has no personal studio yet → username falls back to null.
    expect(body.data[1]).toEqual({
      id: "u2",
      email: "b@x.com",
      username: null,
      avatar_url: null,
    });
    expect(body.data[0]).not.toHaveProperty("credits");
    expect(body.data[0]).not.toHaveProperty("emailVerified");
    expect(body.data[0]).not.toHaveProperty("googleId");
  });

  it("requires authentication — 401 when no Bearer token", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/users?ids=u1");
    expect(res.status).toBe(401);
  });

  it("rejects empty ids query — 422", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/users?ids=", { headers: AUTH });
    expect(res.status).toBe(422);
  });

  it("caps incoming ids at 100 — 101st id is dropped before the profile read", async () => {
    const idList = Array.from({ length: 150 }, (_, i) => `u${i}`).join(",");
    const app = createApp();
    const res = await app.request(`/api/v1/users?ids=${idList}`, { headers: AUTH });

    expect(res.status).toBe(200);
    const passedIds = (mocks.profilesService.profilesOf.mock.calls[0]?.[0] as string[] | undefined) ?? [];
    expect(passedIds).toHaveLength(100);
  });
});
