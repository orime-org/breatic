/**
 * Regression tests for the `/auth/google` endpoint.
 *
 * The original implementation decoded the JWT payload without verifying
 * the signature, `iss`, `aud`, or `exp`, which let any attacker forge
 * an ID token and log in as any user. These tests pin the hardened
 * contract:
 *
 *   1. A request with a fake / unsigned token is rejected with 401.
 *   2. A request for a verified-but-issuer-spoofed token is rejected.
 *   3. A valid token (mocked via `google-auth-library`) logs in.
 *   4. When `GOOGLE_CLIENT_ID` is missing, the endpoint returns 503.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock AI SDK to avoid OpenTelemetry dep issues
vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// Mock infra
vi.mock("../../db/client.js", () => ({
  rawPg: Object.assign(
    (_strings: TemplateStringsArray) => Promise.resolve([]),
    { end: () => Promise.resolve() },
  ),
  db: {},
  closeDb: () => Promise.resolve(),
}));

vi.mock("../../infra/redis.js", () => {
  const mockRedis = {
    ping: () => Promise.resolve("PONG"),
    on: () => mockRedis,
    get: () => Promise.resolve(null),
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
    sadd: () => Promise.resolve(1),
    smembers: () => Promise.resolve([]),
  };
  return {
    getRedis: () => mockRedis,
    closeRedis: () => Promise.resolve(),
  };
});

// Capture verifyIdToken calls so we can assert on them
const verifyIdTokenMock = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: verifyIdTokenMock,
  })),
}));

// Mock the auth service — we're only testing the verification layer,
// not the user-linking logic.
vi.mock("../../modules/auth.service.js", () => ({
  register: vi.fn(),
  loginEmail: vi.fn(),
  loginOrCreateGoogle: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "alice@example.com" },
    token: "sess-token",
  }),
  logout: vi.fn(),
}));

describe("POST /auth/google", () => {
  const origClientId = process.env.GOOGLE_CLIENT_ID;

  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    vi.resetModules();
  });

  afterEach(() => {
    if (origClientId === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = origClientId;
    }
  });

  it("rejects a forged unsigned JWT (the original CVE)", async () => {
    // verifyIdToken throws when signature / aud / iss / exp checks fail
    verifyIdTokenMock.mockRejectedValue(new Error("Invalid token signature"));

    const { createApp } = await import("../../app.js");
    const app = createApp();

    // Construct a "JWT" the old implementation would have accepted:
    // header.payload.sig, where payload is base64-encoded JSON with
    // a victim's email.
    const payload = Buffer.from(
      JSON.stringify({ sub: "victim-sub", email: "victim@gmail.com" }),
    ).toString("base64url");
    const fakeToken = `eyJhbGciOiJub25lIn0.${payload}.x`;

    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: fakeToken }),
    });

    expect(res.status).toBe(401);
    expect(verifyIdTokenMock).toHaveBeenCalledWith({
      idToken: fakeToken,
      audience: "test-client-id.apps.googleusercontent.com",
    });
  });

  it("rejects a token with a wrong `iss` claim", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        iss: "https://evil.example.com",
        sub: "x",
        email: "alice@example.com",
        email_verified: true,
      }),
    });

    const { createApp } = await import("../../app.js");
    const app = createApp();

    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "valid-sig.payload.sig" }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects a token where `email_verified` is false", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        iss: "https://accounts.google.com",
        sub: "x",
        email: "alice@example.com",
        email_verified: false,
      }),
    });

    const { createApp } = await import("../../app.js");
    const app = createApp();

    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "v.p.s" }),
    });

    expect(res.status).toBe(401);
  });

  it("accepts a fully verified token", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        iss: "https://accounts.google.com",
        sub: "google-sub-123",
        email: "alice@example.com",
        email_verified: true,
        name: "Alice",
        picture: "https://example.com/a.png",
      }),
    });

    const { createApp } = await import("../../app.js");
    const app = createApp();

    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "v.p.s" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string } };
    expect(body.data.token).toBe("sess-token");
  });

  it("returns 503 when GOOGLE_CLIENT_ID is not configured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    vi.resetModules();

    const { createApp } = await import("../../app.js");
    const app = createApp();

    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "v.p.s" }),
    });

    expect(res.status).toBe(503);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });
});
