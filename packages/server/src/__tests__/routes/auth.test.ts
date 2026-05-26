/**
 * Auth route tests — register, login, logout, getMe.
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

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /auth/register", () => {
    it("registers and returns 201 with user + token + recoveryCode", async () => {
      // PR-a task 6: register signature now returns { user, recoveryCode }
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
      const body = await res.json() as { data: { token: string; recoveryCode: string } };
      expect(body.data.token).toBe("new-token");
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

  describe("POST /auth/login", () => {
    it("logs in and returns token", async () => {
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
      const body = await res.json() as { data: { token: string } };
      expect(body.data.token).toBe("sess-token");
    });
  });

  describe("POST /auth/logout", () => {
    it("logs out authenticated user", async () => {
      mocks.authService.logout.mockResolvedValue(undefined);

      const app = createApp();
      const res = await app.request("/api/v1/auth/logout", {
        method: "POST",
        headers: AUTH,
      });

      expect(res.status).toBe(200);
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
    it("returns current user", async () => {
      mocks.userRepo.getUserById.mockResolvedValue({
        id: "user-1", email: "u@x.com", username: "User",
      });

      const app = createApp();
      const res = await app.request("/api/v1/auth/me", { headers: AUTH });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string } };
      expect(body.data.id).toBe("user-1");
    });

    it("rejects without auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/auth/me");

      expect(res.status).toBe(401);
    });
  });
});
