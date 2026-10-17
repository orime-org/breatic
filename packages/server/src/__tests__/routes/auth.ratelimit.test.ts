// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Auth rate limiting (BUG-010, inner#1478).
 *
 * Each pre-auth route is limited by the client address our proxy wrote, and
 * login, forgot-password and recovery-code reset also by that address paired
 * with the email, so people behind one egress address do not use up each
 * other's attempts. Every quota of a route is judged in one call.
 */

import { createHash } from "node:crypto";
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
import { PROXY_PEER } from "../helpers/peer.js";

const IP = "203.0.113.9";
const EMAIL = "test@test.com";
const EMAIL_HASH = createHash("sha256").update(EMAIL).digest("hex");

let checkRateLimitMock: ReturnType<typeof vi.fn>;

/**
 * POST a JSON body to an auth route from a proxied client.
 * @param path - The route under `/api/v1/auth`.
 * @param body - The JSON body.
 * @returns The response.
 */
async function post(path: string, body: unknown): Promise<Response> {
  return createApp().request(
    `/api/v1/auth${path}`,
    { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": IP }, body: JSON.stringify(body) },
    PROXY_PEER,
  );
}

/**
 * The keys of the quotas the last `checkRateLimit` call judged.
 * @returns The keys, in order.
 */
function judgedKeys(): string[] {
  const quotas = checkRateLimitMock.mock.calls.at(-1)?.[1] as { key: string }[];
  return quotas.map((q) => q.key);
}

describe("Auth rate limiting", () => {
  beforeEach(async () => {
    const core = (await import("@breatic/core")) as Record<string, unknown>;
    checkRateLimitMock = core.checkRateLimit as ReturnType<typeof vi.fn>;
    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 37 });
    mocks.authService.loginEmail.mockReset();
    mocks.authService.register.mockReset();
  });

  it.each([
    ["/login", { email: EMAIL, password: "password123" }, [`login-ip:${IP}`, `login:${IP}:${EMAIL_HASH}`]],
    ["/forgot-password", { email: EMAIL }, [`forgot-ip:${IP}`, `forgot:${IP}:${EMAIL_HASH}`]],
    [
      "/reset-password-with-recovery-code",
      { email: EMAIL, recoveryCode: "ABCD-EFGH-IJKL-MNOP", newPassword: "password123" },
      [`reset-recovery-ip:${IP}`, `reset-recovery:${IP}:${EMAIL_HASH}`],
    ],
    ["/register", { email: EMAIL, password: "password123" }, [`register:${IP}`]],
    ["/google", { credential: "fake.jwt.token" }, [`google:${IP}`]],
    ["/register/resend", {}, [`register-resend:${IP}`]],
    ["/register/verify", { code: "123456" }, [`register-verify:${IP}`]],
    ["/reset-password", { token: "t", password: "password123" }, [`reset:${IP}`]],
  ])("%s is limited by its quotas and answers 429 with the reported wait", async (path, body, keys) => {
    const res = await post(path, body);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("37");
    expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
    expect(judgedKeys()).toEqual(keys);
  });

  it("login succeeds when under every quota", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    mocks.authService.loginEmail.mockResolvedValue({
      user: { id: "user-1", email: EMAIL },
      token: "sess-token",
    });
    const res = await post("/login", { email: EMAIL, password: "password123" });
    expect(res.status).toBe(200);
  });

  it("logs a structured rate_limit_hit warn when a request is limited", async () => {
    const core = (await import("@breatic/core")) as Record<string, unknown>;
    const warn = (core.logger as { warn: ReturnType<typeof vi.fn> }).warn;
    warn.mockClear();
    await post("/login", { email: EMAIL, password: "password123" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ actions: ["login-ip", "login"] }), "rate_limit_hit");
  });
});
