/**
 * Project members route tests — list/invite/patch/delete + role gating.
 *
 * Mocks @breatic/core entirely; the v10 ladder (`requireRole` →
 * projectAuthService.loadProjectRole) and projectMembersService are
 * exercised against in-memory mocks. Real-DB partial-unique-index
 * behavior is verified separately during migration setup.
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
// Valid RFC 4122 v4 UUIDs (third group starts with `4`, fourth with `8/9/a/b`).
// zod 4's `.uuid()` enforces the variant nibble.
const PID = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-9222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caller is owner on the project.
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("owner");
});

describe("GET /projects/:pid/members", () => {
  it("returns 200 + member list when caller is at least view", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("view");
    mocks.projectMembersService.list.mockResolvedValue([
      { projectId: PID, userId: "u1", role: "owner", addedBy: null, addedAt: new Date(), deletedAt: null },
    ]);

    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members`, { headers: AUTH });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("returns 403 when caller has no membership", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members`, { headers: AUTH });

    expect(res.status).toBe(403);
  });
});

describe("POST /projects/:pid/members — invite", () => {
  it("owner can invite a new edit member; returns 201", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ user_id: TARGET, role: "edit" }),
    });

    expect(res.status).toBe(201);
    expect(mocks.projectMembersService.invite).toHaveBeenCalledWith(PID, TARGET, "edit", "user-1");
  });

  it("non-owner (edit) cannot invite — 403", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("edit");

    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ user_id: TARGET, role: "view" }),
    });

    expect(res.status).toBe(403);
    expect(mocks.projectMembersService.invite).not.toHaveBeenCalled();
  });

  it("rejects role='owner' in invite body with 400 (transfer-owner is V2)", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ user_id: TARGET, role: "owner" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects malformed user_id with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ user_id: "not-a-uuid", role: "view" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /projects/:pid/members/:userId — change role", () => {
  it("owner can change a member's role; returns 200", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members/${TARGET}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ role: "view" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.projectMembersService.changeRole).toHaveBeenCalledWith(PID, TARGET, "view");
  });

  it("rejects role='owner' in patch body with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members/${TARGET}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ role: "owner" }),
    });

    expect(res.status).toBe(400);
  });

  it("non-owner cannot PATCH — 403", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("edit");

    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members/${TARGET}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ role: "view" }),
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /projects/:pid/members/:userId — remove", () => {
  it("owner can remove a member; returns 200", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members/${TARGET}`, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(mocks.projectMembersService.remove).toHaveBeenCalledWith(PID, TARGET);
  });

  it("non-owner cannot remove — 403", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("view");

    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/members/${TARGET}`, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(403);
  });
});
