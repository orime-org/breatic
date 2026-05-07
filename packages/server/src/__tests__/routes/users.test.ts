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

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Authorization: "Bearer valid-token" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/users", () => {
  it("returns batched display fields stripped of sensitive data", async () => {
    mocks.userRepo.getUsersByIds.mockResolvedValue([
      { id: "u1", email: "a@x.com", username: "alice", avatarUrl: "https://cdn/a.png", credits: 999, emailVerified: true, googleId: "g-1" },
      { id: "u2", email: "b@x.com", username: null, avatarUrl: null, credits: 0, emailVerified: false, googleId: null },
    ]);

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
    expect(body.data[0]).not.toHaveProperty("credits");
    expect(body.data[0]).not.toHaveProperty("emailVerified");
    expect(body.data[0]).not.toHaveProperty("googleId");
  });

  it("requires authentication — 401 when no Bearer token", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/users?ids=u1");
    expect(res.status).toBe(401);
  });

  it("rejects empty ids query — 400", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/users?ids=", { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("caps incoming ids at 100 — 101st id is dropped before repo call", async () => {
    const idList = Array.from({ length: 150 }, (_, i) => `u${i}`).join(",");
    mocks.userRepo.getUsersByIds.mockResolvedValue([]);

    const app = createApp();
    const res = await app.request(`/api/v1/users?ids=${idList}`, { headers: AUTH });

    expect(res.status).toBe(200);
    const passedIds = (mocks.userRepo.getUsersByIds.mock.calls[0]?.[0] as string[] | undefined) ?? [];
    expect(passedIds).toHaveLength(100);
  });
});
