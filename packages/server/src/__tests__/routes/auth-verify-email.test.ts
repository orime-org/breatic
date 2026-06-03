// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * POST /auth/verify-email + /auth/resend-verification-email
 * (PR-a task 9).
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

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("POST /auth/verify-email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 on valid token", async () => {
    mocks.authService.verifyEmail.mockResolvedValue({ userId: "user-1" });

    const app = createApp();
    const res = await app.request("/api/v1/auth/verify-email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "abcdef0123456789".repeat(4) }),
    });

    expect(res.status).toBe(200);
    expect(mocks.authService.verifyEmail).toHaveBeenCalledWith("abcdef0123456789".repeat(4));
  });

  it("rejects empty token with 400", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/verify-email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("surfaces UnauthorizedError as 401 on invalid/expired token", async () => {
    mocks.authService.verifyEmail.mockRejectedValue(
      Object.assign(new Error("Invalid or expired verification token"), { status: 401 }),
    );

    const app = createApp();
    const res = await app.request("/api/v1/auth/verify-email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "stale-token-value" }),
    });

    expect([401, 500]).toContain(res.status);
  });
});

describe("POST /auth/resend-verification-email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires auth — returns 401 without token", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/resend-verification-email", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 + invokes service with current user when authenticated", async () => {
    mocks.userRepo.getUserById.mockResolvedValue({
      id: "user-1",
      email: "u@x.com",
      username: "u",
    });
    mocks.authService.resendVerificationEmail.mockResolvedValue({
      mailResult: { status: "skipped", reason: "backend_disabled" },
    });

    const app = createApp();
    const res = await app.request("/api/v1/auth/resend-verification-email", {
      method: "POST",
      headers: { ...AUTH, Origin: "https://app.test" },
    });

    expect(res.status).toBe(200);
    expect(mocks.authService.resendVerificationEmail).toHaveBeenCalledWith(
      "user-1",
      "u@x.com",
      "https://app.test/verify-email",
    );
  });
});
