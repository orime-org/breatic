/**
 * POST /auth/google env toggle invariant (PR-a task 1).
 *
 * Locks current behavior (per spec amend 2026-05-26 § 5.1):
 *
 *   - Google OAuth is an *implicit* toggle: when GOOGLE_CLIENT_ID is unset,
 *     the endpoint returns 503 "Google OAuth is not configured" — NOT 404.
 *   - Self-hosted installs without Google credentials boot cleanly and
 *     the endpoint surfaces the misconfiguration via 503 (visible to
 *     callers) instead of pretending the route doesn't exist.
 *
 * Defends against future regressions:
 *   - Don't add a separate GOOGLE_OAUTH_ENABLED env (redundant).
 *   - Don't route to 404 when unconfigured (hides misconfig).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// Override coreMock env to force GOOGLE_CLIENT_ID empty for this whole file
vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const m = await coreMock(importOriginal);
  (m as { env: Record<string, unknown> }).env.GOOGLE_CLIENT_ID = "";
  return m;
});

import { createApp } from "../../app.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("POST /auth/google — env toggle invariant (锁现状回归)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when GOOGLE_CLIENT_ID is empty (implicit toggle)", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ credential: "any-id-token-fake" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(503);
    // Server returns the i18n key (or its English locale value once
    // `loadLocales()` has run). The route test environment doesn't
    // boot the locale loader, so `t()` falls back to the key itself;
    // we assert the key directly to keep the test hermetic.
    expect(body.error.message).toBe("server.auth.google_oauth_unconfigured");
  });

  it("does NOT return 404 — endpoint exists, just surfaces misconfig (route mounted unconditionally)", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/google", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ credential: "any" }),
    });

    expect(res.status).not.toBe(404);
  });
});
