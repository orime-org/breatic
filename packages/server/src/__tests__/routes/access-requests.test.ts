/**
 * Project access request route tests — POST / GET / PATCH + role gating.
 *
 * Mocks @breatic/core entirely; the service layer is exercised against
 * in-memory mocks. Real-DB partial-unique-index behavior is verified
 * separately in the core service test file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = {
  Cookie: "breatic_session=valid-token",
  "Content-Type": "application/json",
};
// Valid RFC 4122 v4 UUIDs.
const PID = "11111111-1111-4111-8111-111111111111";
const REQ_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caller is owner on the project. Tests override per-case.
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("owner");
});

describe("POST /projects/:pid/access-requests", () => {
  it("returns 201 + the request payload when caller submits valid data", async () => {
    // POST is open to any authenticated user (no role gate),
    // so the loadProjectRole default doesn't gate the request.
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ requested_role: "view", message: "please" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("ar-1");
    expect(mocks.accessRequestService.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PID,
        requestedRole: "view",
        message: "please",
      }),
    );
  });

  it("returns 400 on invalid requested_role (not 'view'/'edit')", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ requested_role: "owner" }),
      },
    );
    expect(res.status).toBe(400);
    expect(mocks.accessRequestService.createRequest).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth cookie", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requested_role: "view" }),
      },
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /projects/:pid/access-requests", () => {
  it("returns 200 + pending list when caller is owner", async () => {
    mocks.accessRequestService.listPendingByProject.mockResolvedValue([
      {
        id: REQ_ID,
        projectId: PID,
        requesterUserId: "u-1",
        requestedRole: "view",
        message: null,
        status: "pending",
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ]);
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("returns 403 when caller is not owner (only view role)", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("view");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests`,
      { headers: AUTH },
    );
    expect(res.status).toBe(403);
    expect(mocks.accessRequestService.listPendingByProject).not.toHaveBeenCalled();
  });
});

describe("PATCH /projects/:pid/access-requests/:reqId", () => {
  it("approves a request when decision='approved' + owner", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ decision: "approved" }),
      },
    );
    expect(res.status).toBe(200);
    expect(mocks.accessRequestService.approveRequest).toHaveBeenCalledWith(
      REQ_ID,
      expect.any(String),
    );
    expect(mocks.accessRequestService.rejectRequest).not.toHaveBeenCalled();
  });

  it("rejects a request when decision='rejected' + owner", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ decision: "rejected" }),
      },
    );
    expect(res.status).toBe(200);
    expect(mocks.accessRequestService.rejectRequest).toHaveBeenCalledWith(
      REQ_ID,
      expect.any(String),
    );
    expect(mocks.accessRequestService.approveRequest).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid decision value", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ decision: "maybe" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller is not owner", async () => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue("edit");
    const app = createApp();
    const res = await app.request(
      `/api/v1/projects/${PID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ decision: "approved" }),
      },
    );
    expect(res.status).toBe(403);
    expect(mocks.accessRequestService.approveRequest).not.toHaveBeenCalled();
  });
});

describe("GET /users/me/access-requests", () => {
  it("returns 200 + caller's own request list", async () => {
    mocks.accessRequestService.listByRequester.mockResolvedValue([
      {
        id: REQ_ID,
        projectId: PID,
        requesterUserId: "u-1",
        requestedRole: "view",
        message: null,
        status: "pending",
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ]);
    const app = createApp();
    const res = await app.request(`/api/v1/users/me/access-requests`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("returns 401 when no auth", async () => {
    const app = createApp();
    const res = await app.request(`/api/v1/users/me/access-requests`);
    expect(res.status).toBe(401);
  });
});
