// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Projects route tests — CRUD + soft delete + ownership.
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

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

describe("Projects routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectService.assertAccess.mockResolvedValue(undefined);
  });

  describe("POST /projects — create", () => {
    it("creates a project and returns 201", async () => {
      mocks.projectService.create.mockResolvedValue({
        id: "proj-1", userId: "user-1", name: "My Project",
      });

      const app = createApp();
      const res = await app.request("/api/v1/projects", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ name: "My Project" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { id: string } };
      expect(body.data.id).toBe("proj-1");
    });

    it("rejects missing name with 400", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/projects", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /projects — list", () => {
    it("returns paginated project list", async () => {
      mocks.projectService.list.mockResolvedValue([
        { id: "proj-1", name: "A" },
        { id: "proj-2", name: "B" },
      ]);

      const app = createApp();
      const res = await app.request("/api/v1/projects", { headers: AUTH });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });
  });

  describe("DELETE /projects/:id — soft delete", () => {
    it("soft-deletes and returns 200", async () => {
      mocks.projectService.deleteProject.mockResolvedValue(undefined);

      const app = createApp();
      const res = await app.request("/api/v1/projects/proj-1", {
        method: "DELETE",
        headers: AUTH,
      });

      expect(res.status).toBe(200);
      expect(mocks.projectService.deleteProject).toHaveBeenCalledWith("proj-1", "user-1");
    });
  });

  describe("PATCH /projects/:id — partial update (DD #152)", () => {
    it("PATCH updates project name (returns {data: ProjectEntity})", async () => {
      mocks.projectService.update.mockResolvedValue({ id: "proj-1", name: "New Name" });

      const app = createApp();
      const res = await app.request("/api/v1/projects/proj-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ name: "New Name" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string; name: string } };
      expect(body.data.name).toBe("New Name");
    });

    it("PUT method is no longer accepted (DD #152 — REST semantic align with members.patch)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/projects/proj-1", {
        method: "PUT",
        headers: AUTH,
        body: JSON.stringify({ name: "Should Not Work" }),
      });

      // Hono router returns 404 for unregistered method on registered path
      expect(res.status).toBe(404);
    });
  });

  describe("Auth enforcement", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });

      expect(res.status).toBe(401);
    });
  });
});
