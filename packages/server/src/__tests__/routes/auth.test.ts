// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Auth route tests — register, login, logout, getMe.
 *
 * Session is delivered as an httpOnly `breatic_session` cookie
 * (2026-05-26 cookie migration). Response bodies no longer carry
 * the raw token; protected routes read the cookie via Hono's cookie
 * helper, which means `getCookie` returns `valid-token` when the
 * `Cookie: breatic_session=valid-token` header is on the request.
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

const SESSION_COOKIE = { Cookie: "breatic_session=valid-token" };
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Cookie-attribute invariant matcher — parses a Set-Cookie header
 * the route emitted and asserts every required option (httpOnly,
 * SameSite, Path, Max-Age, plus the cookie name + value). Asserting
 * one big regex per case makes drift loud: any missed attribute
 * surfaces immediately.
 */
function assertSessionCookie(
  setCookieHeader: string | null,
  expectedValue: string,
): void {
  expect(setCookieHeader).not.toBeNull();
  const h = setCookieHeader!;
  expect(h).toMatch(new RegExp(`^breatic_session=${expectedValue}(;|$)`));
  expect(h).toMatch(/HttpOnly/i);
  expect(h).toMatch(/SameSite=Lax/i);
  expect(h).toMatch(/Path=\//i);
  expect(h).toMatch(/Max-Age=2592000/); // 30 days in seconds
  // Dev mode (ENV=dev in mock-core) must NOT emit `Secure` so the
  // browser accepts the cookie over http://localhost.
  expect(h).not.toMatch(/Secure/i);
}

describe("Auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /auth/register", () => {
    it("registers and returns 201 with user + recoveryCode + Set-Cookie", async () => {
      mocks.authService.register.mockResolvedValue({
        user: { id: "user-new", email: "new@test.com" },
        recoveryCode: "ABCD-EFGH-JKLM-NPQR",
      });
      mocks.authService.loginEmail.mockResolvedValue({
        user: { id: "user-new", email: "new@test.com" },
        token: "new-token",
      });

      const app = createApp();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "new@test.com", password: "password123" }),
      });

      expect(res.status).toBe(201);
      assertSessionCookie(res.headers.get("set-cookie"), "new-token");
      const body = await res.json() as {
        data: { user: { id: string }; recoveryCode: string; token?: string };
      };
      // Token MUST NOT appear in the JSON body — that would defeat
      // the httpOnly cookie's XSS protection.
      expect(body.data.token).toBeUndefined();
      expect(body.data.user.id).toBe("user-new");
      expect(body.data.recoveryCode).toBe("ABCD-EFGH-JKLM-NPQR");
    });

    it("rejects invalid email with 400", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "not-an-email", password: "password123" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects short password with 400", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "valid@test.com", password: "123" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /auth/setup-studio", () => {
    it("creates the personal studio for the slug and returns { personalStudio: { name, slug } }", async () => {
      mocks.studioService.createPersonalStudio.mockResolvedValue({
        id: "studio-9", name: "my-handle", slug: "my-handle",
        createdByUserId: "user-1", type: "personal",
      });

      const app = createApp();
      const res = await app.request("/api/v1/auth/setup-studio", {
        method: "POST",
        headers: { ...SESSION_COOKIE, ...JSON_HEADERS },
        body: JSON.stringify({ slug: "my-handle" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        data: { personalStudio: { name: string; slug: string } };
      };
      expect(body.data.personalStudio).toEqual({ name: "my-handle", slug: "my-handle" });
      expect(mocks.studioService.createPersonalStudio).toHaveBeenCalledWith(
        "user-1",
        "my-handle",
      );
    });

    it("rejects an unauthenticated caller with 401 (setup-studio is gated)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/setup-studio", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug: "my-handle" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a malformed slug with 400 (uppercase / too short — schema guard)", async () => {
      const app = createApp();
      const bad = await app.request("/api/v1/auth/setup-studio", {
        method: "POST",
        headers: { ...SESSION_COOKIE, ...JSON_HEADERS },
        body: JSON.stringify({ slug: "AB" }),
      });
      expect(bad.status).toBe(400);
      expect(mocks.studioService.createPersonalStudio).not.toHaveBeenCalled();
    });
  });

  describe("POST /auth/login", () => {
    it("logs in and emits Set-Cookie, body has no token", async () => {
      mocks.authService.loginEmail.mockResolvedValue({
        user: { id: "user-1", email: "u@x.com" },
        token: "sess-token",
      });

      const app = createApp();
      const res = await app.request("/api/v1/auth/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "u@x.com", password: "password123" }),
      });

      expect(res.status).toBe(200);
      assertSessionCookie(res.headers.get("set-cookie"), "sess-token");
      const body = await res.json() as {
        data: { user: { id: string }; token?: string };
      };
      expect(body.data.token).toBeUndefined();
      expect(body.data.user.id).toBe("user-1");
    });
  });

  describe("POST /auth/logout", () => {
    it("clears the session cookie and 200s", async () => {
      mocks.authService.logout.mockResolvedValue(undefined);

      const app = createApp();
      const res = await app.request("/api/v1/auth/logout", {
        method: "POST",
        headers: SESSION_COOKIE,
      });

      expect(res.status).toBe(200);
      const clear = res.headers.get("set-cookie");
      expect(clear).not.toBeNull();
      // A delete is signalled by Max-Age=0 (Hono's deleteCookie
      // also emits an Expires in the past for older browsers).
      expect(clear).toMatch(/^breatic_session=/);
      expect(clear).toMatch(/Max-Age=0/);
      expect(mocks.authService.logout).toHaveBeenCalledWith("valid-token");
    });

    it("rejects unauthenticated logout with 401", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/logout", {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /auth/me", () => {
    it("returns current user + personalStudio { name, slug } when the user has a studio", async () => {
      mocks.userRepo.getUserById.mockResolvedValue({
        id: "user-1", email: "u@x.com",
      });
      mocks.studioService.getPersonalStudio.mockResolvedValue({
        id: "studio-1", name: "Alice", slug: "alice",
      });

      const app = createApp();
      const res = await app.request("/api/v1/auth/me", {
        headers: SESSION_COOKIE,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { id: string; personalStudio: { name: string; slug: string } | null };
      };
      expect(body.data.id).toBe("user-1");
      // The onboarding-gate data: a completed account exposes its studio.
      expect(body.data.personalStudio).toEqual({ name: "Alice", slug: "alice" });
      // INV-3 (#1808): avatar is removed from the auth hot path — /auth/me no
      // longer carries an `avatarUrl` (it was a dead field on the frontend;
      // own-avatar display is future #1809). A regression that re-adds it to
      // the auth context / this response trips here.
      expect(body.data).not.toHaveProperty("avatarUrl");
    });

    it("returns personalStudio: null for a user who has not finished onboarding (gate signal)", async () => {
      // Invariant #4/#7: a registered-but-no-slug user must surface
      // personalStudio==null so the frontend gate routes them to setup.
      mocks.userRepo.getUserById.mockResolvedValue({
        id: "user-1", email: "u@x.com",
      });
      mocks.studioService.getPersonalStudio.mockResolvedValue(null);

      const app = createApp();
      const res = await app.request("/api/v1/auth/me", {
        headers: SESSION_COOKIE,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: { personalStudio: unknown } };
      expect(body.data.personalStudio).toBeNull();
    });

    it("rejects without the session cookie", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/me");

      expect(res.status).toBe(401);
    });

    it("ignores an `Authorization: Bearer ...` header (cookie-only)", async () => {
      // After the migration, Bearer auth must be a hard 401 — leaving
      // the legacy fallback open would silently re-create the XSS
      // exfiltration surface the cookie migration removed.
      const app = createApp();
      const res = await app.request("/api/v1/auth/me", {
        headers: { Authorization: "Bearer valid-token" },
      });

      expect(res.status).toBe(401);
    });
  });
});
