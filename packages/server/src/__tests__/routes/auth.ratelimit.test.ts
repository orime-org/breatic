/**
 * Auth rate limiting regression tests (BUG-010).
 *
 * Verifies that login/register/google endpoints return 429
 * when rate limit is exceeded.
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

// Access the checkRateLimit mock via the core mock
let checkRateLimitMock: ReturnType<typeof vi.fn>;

describe("Auth rate limiting", () => {
  beforeEach(async () => {
    // Get the mock from the module
    const core = await import("@breatic/core") as Record<string, unknown>;
    checkRateLimitMock = core.checkRateLimit as ReturnType<typeof vi.fn>;
    checkRateLimitMock.mockReset();
    mocks.authService.loginEmail.mockReset();
    mocks.authService.register.mockReset();
  });

  it("login returns 429 when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue(false); // rate limited

    const app = createApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@test.com", password: "password123" }),
    });

    expect(res.status).toBe(429);
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(429);
  });

  it("login succeeds when under rate limit", async () => {
    checkRateLimitMock.mockResolvedValue(true); // allowed
    mocks.authService.loginEmail.mockResolvedValue({
      user: { id: "user-1", email: "test@test.com" },
      token: "sess-token",
    });

    const app = createApp();
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@test.com", password: "password123" }),
    });

    expect(res.status).toBe(200);
  });

  it("register returns 429 when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue(false);

    const app = createApp();
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@test.com", password: "password123" }),
    });

    expect(res.status).toBe(429);
  });

  it("google returns 429 when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue(false);

    const app = createApp();
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "fake.jwt.token" }),
    });

    expect(res.status).toBe(429);
  });
});
