/**
 * Spaces route tests — POST/DELETE + role gating + Redis publish.
 *
 * The route delegates to:
 *   - `publishSpaceCreated` / `publishSpaceDeleted` (Redis pub/sub on
 *     DB2 — collab subscriber applies the meta-doc Y.Map mutation)
 *   - `yjsDocRepo.softDeleteByName` (PG soft delete on the
 *     `yjs_documents` row)
 *
 * Both are mocked here. Real-DB invariant assertions live in the
 * v10-schema-invariants integration test.
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
const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("edit");
  mocks.publishSpaceCreated.mockResolvedValue(undefined);
  mocks.publishSpaceDeleted.mockResolvedValue(undefined);
  mocks.yjsDocRepo.softDeleteByName.mockResolvedValue(true);
});

describe("POST /api/v1/projects/:pid/spaces", () => {
  it("returns 201 + new space id; publishes space:created", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "canvas", name: "Untitled" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; type: string; name: string } };
    expect(body.data.type).toBe("canvas");
    expect(body.data.name).toBe("Untitled");
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(mocks.publishSpaceCreated).toHaveBeenCalledWith(PID, {
      spaceId: body.data.id,
      spaceType: "canvas",
      name: "Untitled",
      createdBy: "user-1",
    });
  });

  it("rejects view-only members with 403", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("view");
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "canvas", name: "Untitled" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.publishSpaceCreated).not.toHaveBeenCalled();
  });

  it("rejects non-members with 403", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue(null);
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "canvas", name: "Untitled" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-canvas Space types with 422 (V1 only canvas)", async () => {
    // Route accepts the body shape (Zod allows all three kinds for
    // forward-compat) but the handler throws ValidationError → 422
    // for document / timeline until those kinds ship.
    const app = createApp();
    const docRes = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "document", name: "Notes" }),
    });
    expect(docRes.status).toBe(422);

    const tlRes = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "timeline", name: "Edit" }),
    });
    expect(tlRes.status).toBe(422);

    expect(mocks.publishSpaceCreated).not.toHaveBeenCalled();
  });

  it("rejects unknown Space types and missing fields with 400", async () => {
    const app = createApp();

    const noType = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "X" }),
    });
    expect(noType.status).toBe(400);

    const wrongType = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "wat", name: "X" }),
    });
    expect(wrongType.status).toBe(400);

    const emptyName = await app.request(`/api/v1/projects/${PID}/spaces`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ type: "canvas", name: "" }),
    });
    expect(emptyName.status).toBe(400);
  });
});

describe("DELETE /api/v1/projects/:pid/spaces/:sid", () => {
  it("soft-deletes the canvas-{sid} doc row + publishes space:deleted", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/spaces/${SID}`, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(mocks.yjsDocRepo.softDeleteByName).toHaveBeenCalledWith(
      `project-${PID}/canvas-${SID}`,
    );
    expect(mocks.publishSpaceDeleted).toHaveBeenCalledWith(PID, {
      spaceId: SID,
      deletedBy: "user-1",
    });
  });

  it("rejects view-only members with 403", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("view");
    const app = createApp();
    const res = await app.request(`/api/v1/projects/${PID}/spaces/${SID}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(403);
    expect(mocks.publishSpaceDeleted).not.toHaveBeenCalled();
    expect(mocks.yjsDocRepo.softDeleteByName).not.toHaveBeenCalled();
  });
});
