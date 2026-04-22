/**
 * BUG-033 regression test — canvas task rollback on lock failure.
 *
 * The canvas task-create route builds the DB task row first, then tries
 * to acquire the node lock. If the lock is already held by another
 * task (another user mid-generation), the route must soft-delete the
 * task it just created — otherwise we accumulate orphan "pending"
 * rows that never get enqueued and never finish.
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
  Authorization: "Bearer valid-token",
  "Content-Type": "application/json",
};

describe("Canvas task creation — lock conflict rollback (BUG-033)", () => {
  beforeEach(() => {
    mocks.taskService.create.mockClear();
    mocks.taskService.create.mockResolvedValue({ id: "task-abc", taskType: "image" });
    mocks.taskService.softDelete.mockClear();
    mocks.creditService.getBalance.mockResolvedValue(1000);
    mocks.acquireNodeLock.mockReset();
    mocks.acquireNodeLock.mockResolvedValue(true); // default: lock succeeds
  });

  it("soft-deletes the orphan task when node lock is already held", async () => {
    mocks.acquireNodeLock.mockResolvedValue(false);

    const app = createApp();
    const res = await app.request("/api/v1/canvas/tasks", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        task_type: "image",
        project_id: "proj-1",
        model: "test-model",
        params: { node_id: "node-1" },
      }),
    });

    expect(res.status).toBe(409);
    // The task row was created, so it must also be soft-deleted.
    expect(mocks.taskService.create).toHaveBeenCalledTimes(1);
    expect(mocks.taskService.softDelete).toHaveBeenCalledTimes(1);
    expect(mocks.taskService.softDelete).toHaveBeenCalledWith("task-abc");
  });

  it("does NOT soft-delete when the lock is acquired successfully", async () => {
    mocks.acquireNodeLock.mockResolvedValue(true);

    const app = createApp();
    const res = await app.request("/api/v1/canvas/tasks", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        task_type: "image",
        project_id: "proj-1",
        model: "test-model",
        params: { node_id: "node-1" },
      }),
    });

    expect(res.status).toBeLessThan(400);
    expect(mocks.taskService.softDelete).not.toHaveBeenCalled();
  });
});
