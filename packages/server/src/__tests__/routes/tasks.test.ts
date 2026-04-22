/**
 * Tasks route tests — list, get, canvas task creation.
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

describe("Tasks routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectService.assertAccess.mockResolvedValue(undefined);
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
    mocks.creditService.getBalance.mockResolvedValue(100);
  });

  describe("GET /tasks — list", () => {
    it("returns task list", async () => {
      mocks.taskService.list.mockResolvedValue([
        { id: "task-1", taskType: "image", status: "completed" },
      ]);

      const app = createApp();
      const res = await app.request("/api/v1/tasks?limit=10&offset=0", { headers: AUTH });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /tasks/:id — get", () => {
    it("returns a single task", async () => {
      mocks.taskService.get.mockResolvedValue({
        id: "task-1", taskType: "image", status: "completed", userId: "user-1",
      });

      const app = createApp();
      const res = await app.request("/api/v1/tasks/task-1", { headers: AUTH });

      expect(res.status).toBe(200);
    });
  });

  describe("POST /canvas/tasks — create canvas task", () => {
    it("creates task and returns 201", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { prompt: "a cat" },
          model: "test-model",
          source: "canvas",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { task_id: string } };
      expect(body.data.task_id).toBe("task-1");
    });

    it("rejects without auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test",
          source: "canvas",
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /canvas/nodes/:nodeId/history", () => {
    it("returns node history", async () => {
      mocks.nodeHistoryService.listByNode.mockResolvedValue({
        data: [{ id: "h-1", type: "generation", status: "success" }],
        total: 1,
      });

      const app = createApp();
      const res = await app.request(
        "/api/v1/canvas/nodes/node-1/history?project_id=a0000000-0000-4000-8000-000000000001&limit=10&offset=0",
        { headers: AUTH },
      );

      expect(res.status).toBe(200);
    });
  });
});
