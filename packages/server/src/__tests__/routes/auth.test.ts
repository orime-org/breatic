// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Auth route tests — register, login, logout, getMe.
 *
 * Session is delivered as an httpOnly session cookie (2026-05-26
 * cookie migration). Response bodies no longer carry the raw token;
 * protected routes read the cookie via Hono's cookie helper.
 *
 * The real name is deployment-scoped (`sessionCookieName()` →
 * `breatic_session_{REDIS_KEY_PREFIX}`, #1831), but the core mock here
 * pins it to the bare `breatic_session` so these fixtures assert route
 * behaviour rather than tracking an env-derived value. The name itself
 * is covered by `core/infra/__tests__/session-cookie-name.test.ts`, and
 * the wiring end to end by the integration suites (which call the real
 * `sessionCookieName()`).
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
        data: {
          user: { id: string; personalStudio: unknown };
          recoveryCode: string;
          token?: string;
        };
      };
      // Token MUST NOT appear in the JSON body — that would defeat
      // the httpOnly cookie's XSS protection.
      expect(body.data.token).toBeUndefined();
      expect(body.data.user.id).toBe("user-new");
      expect(body.data.recoveryCode).toBe("ABCD-EFGH-JKLM-NPQR");
      // #1882: every /auth/* response carries `personalStudio` in the same
      // shape. Step one of registration has not picked a slug yet, so the
      // correct value is an explicit null — the KEY has to be there. Omitting
      // it made the frontend's `AuthUser` type a lie (it declares the field,
      // the wire never carried it) and `personalStudio?.name ?? null` then read
      // undefined, silently degrading the display name to the email local part.
      expect(body.data.user).toHaveProperty("personalStudio");
      expect(body.data.user.personalStudio).toBeNull();
    });

    it("rejects invalid email with 422", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "not-an-email", password: "password123" }),
      });

      expect(res.status).toBe(422);
    });

    it("rejects short password with 422", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "valid@test.com", password: "123" }),
      });

      expect(res.status).toBe(422);
    });
  });

  describe("POST /auth/setup-studio", () => {
    it("creates the personal studio for the slug and returns { personalStudio: { name, slug, avatarUrl } }", async () => {
      mocks.studioService.createPersonalStudio.mockResolvedValue({
        id: "studio-9", name: "my-handle", slug: "my-handle",
        avatarUrl: null,
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
        data: { personalStudio: { name: string; slug: string; avatarUrl: string | null } };
      };
      // #1882: a freshly created studio has no avatar yet, but the KEY ships —
      // all four /auth/* responses return one shape, no exception.
      expect(body.data.personalStudio).toEqual({
        name: "my-handle", slug: "my-handle", avatarUrl: null,
      });
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

    it("rejects a malformed slug with 422 (uppercase / too short — schema guard)", async () => {
      const app = createApp();
      const bad = await app.request("/api/v1/auth/setup-studio", {
        method: "POST",
        headers: { ...SESSION_COOKIE, ...JSON_HEADERS },
        body: JSON.stringify({ slug: "AB" }),
      });
      expect(bad.status).toBe(422);
      expect(mocks.studioService.createPersonalStudio).not.toHaveBeenCalled();
    });
  });

  describe("POST /auth/login", () => {
    it("logs in and emits Set-Cookie, body has no token", async () => {
      mocks.authService.loginEmail.mockResolvedValue({
        user: { id: "user-1", email: "u@x.com" },
        token: "sess-token",
      });
      mocks.studioService.getPersonalStudio.mockResolvedValue({
        id: "studio-1", name: "Alice", slug: "alice",
        avatarUrl: "https://cdn/alice.png",
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
        data: {
          user: {
            id: string;
            personalStudio: { name: string; slug: string; avatarUrl: string | null } | null;
          };
          token?: string;
        };
      };
      expect(body.data.token).toBeUndefined();
      expect(body.data.user.id).toBe("user-1");
      // #1882: this is the response the login TAB is populated from, and it
      // used to omit personalStudio entirely — so that tab derived its display
      // name from the email local part while every refreshed tab (which goes
      // through /auth/me) showed the studio name. Same account, two names.
      expect(body.data.user.personalStudio).toEqual({
        name: "Alice", slug: "alice", avatarUrl: "https://cdn/alice.png",
      });
    });

    it("returns personalStudio: null when the account has not finished onboarding", async () => {
      mocks.authService.loginEmail.mockResolvedValue({
        user: { id: "user-1", email: "u@x.com" },
        token: "sess-token",
      });
      mocks.studioService.getPersonalStudio.mockResolvedValue(null);

      const app = createApp();
      const res = await app.request("/api/v1/auth/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "u@x.com", password: "password123" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { user: { personalStudio: unknown } };
      };
      // Null, not absent: the onboarding gate reads this as "send them to
      // slug setup", and an absent key would read as undefined instead.
      expect(body.data.user).toHaveProperty("personalStudio");
      expect(body.data.user.personalStudio).toBeNull();
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
    it("returns current user + personalStudio { name, slug, avatarUrl } when the user has a studio", async () => {
      mocks.userRepo.getUserById.mockResolvedValue({
        id: "user-1", email: "u@x.com",
      });
      mocks.studioService.getPersonalStudio.mockResolvedValue({
        id: "studio-1", name: "Alice", slug: "alice",
        avatarUrl: "https://cdn/alice.png",
      });

      const app = createApp();
      const res = await app.request("/api/v1/auth/me", {
        headers: SESSION_COOKIE,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: {
          id: string;
          personalStudio: { name: string; slug: string; avatarUrl: string | null } | null;
        };
      };
      expect(body.data.id).toBe("user-1");
      // The onboarding-gate data: a completed account exposes its studio.
      // #1882 adds avatarUrl here — the service already loads the whole studio
      // row, the route was simply dropping the field while assembling the
      // response, which left the store's avatar unset on every cold load.
      expect(body.data.personalStudio).toEqual({
        name: "Alice", slug: "alice", avatarUrl: "https://cdn/alice.png",
      });
      // INV-3 (#1808) still holds, and #1882 does NOT weaken it: the avatar is
      // a property of the personal STUDIO, never of the user. It rides inside
      // `personalStudio` (the pointer model #1808 established); a regression
      // that hangs it off the user object again trips here.
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
