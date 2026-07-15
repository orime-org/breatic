// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

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

  // v10: every canvas task is project + Space scoped (worker writes
  // back to `project-{pid}/canvas-{spaceId}`). Both UUIDs are required.
  const PID = "11111111-1111-4111-8111-111111111111";
  const SID = "22222222-2222-4222-9222-222222222222";

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
          project_id: PID,
          space_id: SID,
          mode: "append",
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
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(401);
    });

    it("rejects with 402 when the balance is below the estimate — no task row created (#1580 #7 pre-check)", async () => {
      mocks.creditService.getBalance.mockResolvedValue(0);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test-model",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(402);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
    });

    it("rejects an i2i/edit model with no source image BEFORE enqueue (#1675) — no task, no bill", async () => {
      // The model needs a source image but params.images is empty. The gate
      // must fire before taskService.create + enqueue (billing is post-worker),
      // so nothing is created / queued / billed.
      mocks.violatesSourceRequirementForModel.mockReturnValue(true);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {}, // no images
          model: "nano-banana-pro-edit",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("allows an i2i model that carries a source image (#1675 gate passes)", async () => {
      mocks.violatesSourceRequirementForModel.mockReturnValue(false);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { images: ["https://cdn/x.png"] },
          model: "nano-banana-pro-edit",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.taskService.create).toHaveBeenCalled();
    });

    it("rejects a submission with too many reference images BEFORE enqueue (#1735) — no task, no bill", async () => {
      // The submission over-fills a capped list param; the gate must fire
      // before taskService.create + enqueue so nothing is created / queued /
      // billed (the worker would otherwise silently truncate the extras).
      mocks.violatesReferenceCountForModel.mockReturnValue({
        field: "images",
        limit: 14,
        actual: 15,
      });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { images: Array.from({ length: 15 }, (_, i) => `https://cdn/${i}.png`) },
          model: "nano-banana-pro-edit",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("allows a submission within the reference-image cap (#1735 gate passes)", async () => {
      mocks.violatesReferenceCountForModel.mockReturnValue(null);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { images: ["https://cdn/x.png", "https://cdn/y.png"] },
          model: "nano-banana-pro-edit",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.taskService.create).toHaveBeenCalled();
    });

    it("rejects a node-bound body whose node_gens misses the target (#1580 #7 schema gate)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test-model",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
          target_node_id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        }),
      });

      expect(res.status).toBe(400);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
    });

    it("threads node_gens into the BullMQ job payload (#1580 #7 gen echo chain)", async () => {
      const nodeId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test-model",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "append",
          target_node_id: nodeId,
          node_gens: { [nodeId]: 7 },
        }),
      });

      expect(res.status).toBe(201);
      const jobPayload = mockQueueAdd.mock.calls.at(-1)?.[1] as {
        targetNodeIds: string[];
        nodeGens: Record<string, number>;
      };
      expect(jobPayload.targetNodeIds).toEqual([nodeId]);
      expect(jobPayload.nodeGens).toEqual({ [nodeId]: 7 });
    });

    it("hard-fails an overwrite when the handling-OPEN publish fails — task failed, lock released, no enqueue (#1580 adversarial)", async () => {
      // The OPEN event is what installs the live handlingBy.gen + advances
      // leaseGen on the collab side. If it never lands, every subsequent
      // worker write-back for this job is CAS-fenced — the user would be
      // billed for a result that can never reach the node. So the publish
      // is a hard prerequisite, not best-effort.
      const nodeId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      mocks.publishNodeEvent.mockRejectedValueOnce(new Error("stream down"));
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test-model",
          source: "canvas",
          project_id: PID,
          space_id: SID,
          mode: "overwrite",
          target_node_id: nodeId,
          node_gens: { [nodeId]: 3 },
        }),
      });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mocks.taskService.markFailed).toHaveBeenCalled();
      expect(mocks.canvasLock.releaseCanvasNodeLock).toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("POST /canvas/understand — credit pre-check (#1580 adversarial)", () => {
    it("rejects with 402 when the balance is below the estimate — no task row created", async () => {
      mocks.creditService.getBalance.mockResolvedValue(0);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          source_type: "image",
          source_url: "https://cdn/x.png",
          project_id: PID,
          space_id: SID,
        }),
      });

      expect(res.status).toBe(402);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
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
        "/api/v1/canvas/nodes/b0000000-0000-4000-8000-000000000002/history?project_id=a0000000-0000-4000-8000-000000000001&limit=10&offset=0",
        { headers: AUTH },
      );

      expect(res.status).toBe(200);
    });

    it("400 for a non-uuid nodeId (canvas node ids are uuids)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/canvas/nodes/not-a-uuid/history?project_id=a0000000-0000-4000-8000-000000000001",
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
    });
  });
});
