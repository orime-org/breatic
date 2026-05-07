/**
 * Cross-tenant ownership enforcement tests.
 *
 * Verifies that client-supplied project_id / conversation_id are
 * checked against the authenticated user before any side effect runs.
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
import { ForbiddenError } from "@breatic/core";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };
const PROJ_UUID = "11111111-1111-4111-8111-111111111111";
const SPACE_UUID = "33333333-3333-4333-9333-333333333333";
const CONV_UUID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.projectService.assertAccess.mockReset().mockResolvedValue(undefined);
  mocks.conversationService.assertAccess.mockReset().mockResolvedValue(undefined);
  mocks.taskService.create.mockReset().mockResolvedValue({ id: "t1", taskType: "image" });
  mocks.taskService.setJobId.mockReset();
  mocks.nodeHistoryService.listByNode.mockReset();
  mocks.attachmentService.listByConversation.mockReset().mockResolvedValue([]);
});

describe("POST /canvas/tasks — project_id ownership", () => {
  it("rejects with 403 when caller does not own the project", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("nope"));
    const app = createApp();
    const res = await app.request("/api/v1/canvas/tasks", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PROJ_UUID,
        space_id: SPACE_UUID,
        task_type: "image",
        params: { prompt: "hi", node_id: "n-1" },
        model: "test",
      }),
    });
    expect(res.status).toBe(403);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
  });
});

describe("GET /canvas/nodes/:nodeId/history — project_id ownership", () => {
  it("rejects with 403 when caller does not own the project", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("nope"));
    const app = createApp();
    const res = await app.request(
      `/api/v1/canvas/nodes/n-1/history?project_id=${PROJ_UUID}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(403);
    expect(mocks.nodeHistoryService.listByNode).not.toHaveBeenCalled();
  });
});

describe("GET /assets/presign — project ownership", () => {
  it("rejects with 403 for unowned project", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("nope"));
    const app = createApp();
    const res = await app.request(
      `/api/v1/assets/presign?filename=a.png&content_type=image/png&project_id=${PROJ_UUID}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /chat/conversations/:id/attachments — conversation ownership", () => {
  it("rejects with 403 for unowned conversation", async () => {
    mocks.conversationService.assertAccess.mockRejectedValue(new ForbiddenError("nope"));
    const app = createApp();
    const res = await app.request(
      `/api/v1/chat/conversations/${CONV_UUID}/attachments`,
      { headers: AUTH },
    );
    expect(res.status).toBe(403);
    expect(mocks.attachmentService.listByConversation).not.toHaveBeenCalled();
  });
});
