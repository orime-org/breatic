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

// A real uuid: the role middleware validates the shape before it puts the
// param into a uuid comparison, so a placeholder id is refused up front.
const PROJ_UUID = "11111111-1111-4111-8111-111111111111";

describe("Projects routes", () => {
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
        "/api/v1/projects/not-a-uuid",
        { method: "DELETE", headers: AUTH },
      );
      expect(res.status).toBe(403);
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
      // The body above carries no visibility — the client stopped sending one
      // on 2026-08-07 — so the 5th arg is whatever the schema defaulted to.
      // This is the far end of the only wire that now decides what a new
      // project gets, and the schema end of it is pinned in
      // packages/shared/src/schemas/__tests__/api.test.ts.
      expect(mocks.projectService.create.mock.calls[0]?.[4]).toBe("studio");
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

  describe("DELETE /projects/:id — soft delete", () => {
    it("soft-deletes and returns 200", async () => {
      mocks.projectService.deleteProject.mockResolvedValue(undefined);

      const app = createApp();
      const res = await app.request(`/api/v1/projects/${PROJ_UUID}`, {
        method: "DELETE",
        headers: AUTH,
      });

      expect(res.status).toBe(200);
      expect(mocks.projectService.deleteProject).toHaveBeenCalledWith(PROJ_UUID, "user-1");
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
