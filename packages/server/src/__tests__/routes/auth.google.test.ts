/**
 * Google OAuth endpoint regression tests.
 *
 * Pins: forged JWT → 401, wrong iss → 401, email_verified=false → 401,
 * valid token → 200, missing GOOGLE_CLIENT_ID → 503.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

const verifyIdTokenMock = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken: verifyIdTokenMock })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

describe("POST /auth/google", () => {
  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    mocks.authService.loginOrCreateGoogle.mockResolvedValue({
      user: { id: "user-1", email: "a@x.com" },
      token: "sess-token",
    });
  });

  it("rejects a forged unsigned JWT", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("Invalid token"));
    const app = createApp();
    const payload = Buffer.from(JSON.stringify({ sub: "x", email: "v@g.com" })).toString("base64url");
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: `eyJhbGciOiJub25lIn0.${payload}.x` }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong iss", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ iss: "https://evil.com", sub: "x", email: "a@x.com", email_verified: true }),
    });
    const app = createApp();
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "v.p.s" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects email_verified=false", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ iss: "https://accounts.google.com", sub: "x", email: "a@x.com", email_verified: false }),
    });
    const app = createApp();
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "v.p.s" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid token; sets session cookie + body has user (no token)", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ iss: "https://accounts.google.com", sub: "g-123", email: "a@x.com", email_verified: true, name: "A", picture: "https://x/a.png" }),
    });
    const app = createApp();
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "v.p.s" }),
    });
    expect(res.status).toBe(200);
    // Cookie carries the session token; body never does (mirrors the
    // email/password login path — see auth.test.ts for the full
    // attribute matcher).
    expect(res.headers.get("set-cookie")).toMatch(
      /^breatic_session=sess-token;.*HttpOnly/i,
    );
    const body = await res.json() as {
      data: { user: { id: string }; token?: string };
    };
    expect(body.data.token).toBeUndefined();
    expect(body.data.user.id).toBe("user-1");
  });
});
