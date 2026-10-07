// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

// A real uuid: the role middleware validates the shape before it puts the
// param into a uuid comparison, so a placeholder id is refused up front.
const PROJ_UUID = "11111111-1111-4111-8111-111111111111";

describe("Projects routes", () => {
  it("returns 404 for an invalid project lookup id without querying the database", async () => {
    const res = await createApp().request("/api/v1/projects/not-a-uuid", { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 404 } });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectService.assertAccess.mockResolvedValue(undefined);
  });

  describe("project id validation (middleware, not per-route)", () => {
    it("refuses a malformed project id with 403, not a 500", async () => {
      // The role middleware puts this param into a uuid comparison, so a
      // non-uuid would make Postgres reject the statement and surface as an
      // unclassified 500. Checked in the middleware rather than per route:
      // every project route is behind it, and a per-route validator is one
      // more thing each new route has to remember.
      const res = await createApp().request(
        "/api/v1/projects/not-a-uuid/transfer-owner",
        { method: "POST", headers: AUTH, body: JSON.stringify({ toUserId: "u-2" }) },
      );
      expect(res.status).toBe(403);
    });

    it("refuses a malformed id on a route gated in the service with 422", async () => {
      const res = await createApp().request(
        "/api/v1/projects/not-a-uuid/duplicate",
        { method: "POST", headers: AUTH },
      );
      expect(res.status).toBe(422);
      expect(mocks.projectService.duplicate).not.toHaveBeenCalled();
    });
  });

  describe("POST /projects — create", () => {
    it("creates a project and returns 201", async () => {
      mocks.projectService.create.mockResolvedValue({
        id: PROJ_UUID, userId: "user-1", name: "My Project",
      });

      const app = createApp();
      const res = await app.request("/api/v1/projects", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          studioId: "11111111-1111-4111-8111-111111111111",
          name: "My Project",
          slug: "my-project",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { id: string } };
      expect(body.data.id).toBe(PROJ_UUID);
      // The route extracts studioId from the body and passes it to create as
      // the 2nd arg — the create gate authorizes the caller's role on it.
      expect(mocks.projectService.create.mock.calls[0]?.[1]).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
      // The 5th arg is the space type, which the schema defaults to canvas.
      expect(mocks.projectService.create.mock.calls[0]?.[4]).toBe("canvas");
    });

    it("stores the name without its surrounding whitespace", async () => {
      mocks.projectService.create.mockResolvedValue({ id: PROJ_UUID });
      const res = await createApp().request("/api/v1/projects", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ studioId: PROJ_UUID, name: "  My Project \n", slug: "my-project" }),
      });

      expect(res.status).toBe(201);
      expect(mocks.projectService.create.mock.calls[0]?.[2]).toBe("My Project");
    });

    it("rejects a whitespace-only name with 422", async () => {
      const res = await createApp().request("/api/v1/projects", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ studioId: PROJ_UUID, name: "   ", slug: "my-project" }),
      });

      expect(res.status).toBe(422);
      expect(mocks.projectService.create).not.toHaveBeenCalled();
    });

    it("rejects missing name with 422", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/projects", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(422);
    });
  });

  describe("POST /projects/:id/archive and /restore — studio admin, decided in the service", () => {
    it("archives for the caller and answers 200 without asking the caller's project role", async () => {
      mocks.projectService.archive.mockResolvedValue(undefined);
      const res = await createApp().request(`/api/v1/projects/${PROJ_UUID}/archive`, {
        method: "POST",
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(mocks.projectService.archive).toHaveBeenCalledWith(PROJ_UUID, "user-1");
      expect(mocks.projectAuthService.loadProjectRole).not.toHaveBeenCalled();
    });

    it("restores for the caller and answers 200", async () => {
      mocks.projectService.restore.mockResolvedValue(undefined);
      const res = await createApp().request(`/api/v1/projects/${PROJ_UUID}/restore`, {
        method: "POST",
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      expect(mocks.projectService.restore).toHaveBeenCalledWith(PROJ_UUID, "user-1");
    });

    it("refuses a malformed project id before reaching the service", async () => {
      const res = await createApp().request("/api/v1/projects/not-a-uuid/archive", {
        method: "POST",
        headers: AUTH,
      });
      expect(res.status).toBe(422);
      expect(mocks.projectService.archive).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /projects/:id — partial update (DD #152)", () => {
    it("PATCH updates project name (returns {data: ProjectEntity})", async () => {
      mocks.projectService.update.mockResolvedValue({ id: PROJ_UUID, name: "New Name" });

      const app = createApp();
      const res = await app.request(`/api/v1/projects/${PROJ_UUID}`, {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ name: "New Name" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string; name: string } };
      expect(body.data.name).toBe("New Name");
    });

    it("PATCH stores the new name without its surrounding whitespace", async () => {
      mocks.projectService.update.mockResolvedValue({ id: PROJ_UUID, name: "New Name" });
      const res = await createApp().request(`/api/v1/projects/${PROJ_UUID}`, {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ name: "\t New Name  " }),
      });

      expect(res.status).toBe(200);
      expect(mocks.projectService.update.mock.calls[0]?.[2]).toMatchObject({ name: "New Name" });
    });

    it("PATCH rejects a whitespace-only name with 422", async () => {
      const res = await createApp().request(`/api/v1/projects/${PROJ_UUID}`, {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ name: "   " }),
      });

      expect(res.status).toBe(422);
      expect(mocks.projectService.update).not.toHaveBeenCalled();
    });

    it("PUT method is no longer accepted (DD #152 — REST semantic align with members.patch)", async () => {
      const app = createApp();
      const res = await app.request(`/api/v1/projects/${PROJ_UUID}`, {
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
