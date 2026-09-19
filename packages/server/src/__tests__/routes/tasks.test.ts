// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
    mocks.creditLotService.getSpendableCredits.mockResolvedValue(100);
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

    /** A canvas task body, with whatever the test wants to vary merged in. */
    const canvasTask = (extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        task_type: "image",
        params: { prompt: "a cat" },
        model: "test-model",
        source: "canvas",
        project_id: PID,
        space_id: SID,
        mode: "append",
        ...extra,
      });

    // This entry took a skill_name straight off the request body into the
    // task row and the queue, with nothing asked. The three tests below are
    // the canvas half of the pair the chat entry already had; without them
    // the gate could be deleted and nothing would go red.
    it("rejects a skill this surface does not serve with 403", async () => {
      // The surface axis specifically: the skill exists, the user may fire
      // it, and it is still not something canvas offers.
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: canvasTask({ skill_name: "creative_research" }),
      });

      expect(res.status).toBe(403);
    });

    it("rejects a skill the user may not fire with 403", async () => {
      // A skill canvas DOES serve, so the surface axis lets it through and
      // the refusal can only come from the authorization one. Naming a
      // chat-only skill here would be stopped a step earlier and this test
      // would pass without ever reaching what it is named for.
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: canvasTask({ skill_name: "canvas_gated" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/not user-invocable/);
    });

    it("lets through a skill canvas serves", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: canvasTask({ skill_name: "canvas_fixture" }),
      });

      expect(res.status).toBe(201);
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
      mocks.creditLotService.getSpendableCredits.mockResolvedValue(0);
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

    it("accepts a second overwrite onto a node that already has one running (#186)", async () => {
      // A node carries several tasks at once now. Both are enqueued and both
      // reach an end of their own; whichever result the user keeps is decided
      // on the node's task list, not by refusing the second request.
      const nodeId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const app = createApp();
      const body = JSON.stringify({
        task_type: "image",
        params: {},
        model: "test-model",
        source: "canvas",
        project_id: PID,
        space_id: SID,
        mode: "overwrite",
        target_node_id: nodeId,
      });

      const first = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body,
      });
      const second = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body,
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    });

  });

  describe("POST /canvas/node-history/snapshot", () => {
    // A text node's words live in the canvas document, and a history row is
    // the only copy of them that survives the next edit. This is the browser's
    // one way to write one, so the endpoint validates what it is handed and
    // asks the same question every write to a project asks.
    it("records what the node holds right now", async () => {
      mocks.nodeHistoryService.recordSnapshot.mockResolvedValue({ id: "h-9" });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/node-history/snapshot", {
        method: "POST",
        headers: AUTH,
        // The row is written against a project and a node. Nothing here reads
        // a Space, and `node_history` has no column for one.
        body: JSON.stringify({
          project_id: PID,
          node_id: "11111111-1111-4111-8111-111111111111",
          text: "A red bicycle against a brick wall.",
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(
        PID,
        expect.any(String),
        "editor",
      );
      expect(mocks.nodeHistoryService.recordSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PID,
          nodeId: "11111111-1111-4111-8111-111111111111",
          content: "A red bicycle against a brick wall.",
        }),
      );
    });

    // A snapshot of nothing is not one: the row would show the reader a
    // blank line they cannot tell apart from any other. The browser greys
    // the item out on a node saying nothing; this is the same rule where it
    // is authoritative.
    it("refuses a snapshot of nothing", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/node-history/snapshot", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          node_id: "11111111-1111-4111-8111-111111111111",
          text: "",
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.nodeHistoryService.recordSnapshot).not.toHaveBeenCalled();
    });

    it("refuses a node id that is not one", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/node-history/snapshot", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          node_id: "not-a-uuid",
          text: "x",
        }),
      });

      expect(res.status).toBe(422);
    });
  });

  describe("POST /canvas/understand — what a refusal leaves behind", () => {
    // The node's row is opened before the credit gate so a refusal has
    // somewhere to be said. That order leaves this route holding two rows,
    // and a refusal has to finish both — a task left `pending` is one no
    // worker will ever touch and no sweep will ever end.
    it("ends the task it created when the balance is short", async () => {
      mocks.creditLotService.getSpendableCredits.mockResolvedValue(0);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          space_id: SID,
          source_type: "image",
          source_url: "https://assets.invalid/image/a.png",
          node_ids: ["11111111-1111-4111-8111-111111111111"],
        }),
      });

      expect(res.status).toBe(402);
      expect(mocks.taskService.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        "no_credits",
      );
    });
  });

  describe("POST /canvas/understand — a refused run still has a row", () => {
    // The node is on the canvas before this request goes out, so a refusal
    // has somewhere to be said: the row this run opened is settled `failed`
    // with the cause, and the node shows failed=1 (downstream-node-creation
    // decision, stage 4). A toast with no row behind it would leave a node
    // sitting there with nothing to explain it.
    it("settles the row it opened when the balance is short", async () => {
      mocks.creditLotService.getSpendableCredits.mockResolvedValue(0);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          source_type: "image",
          source_url: "https://cdn/x.png",
          node_ids: ["node-9"],
          project_id: PID,
          space_id: SID,
        }),
      });

      expect(res.status).toBe(402);
      expect(mocks.nodeTaskService.open).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: "node-9" }),
      );
      expect(mocks.nodeTaskService.settle).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", errorMessage: "no_credits" }),
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("opens no row for a run that named no node", async () => {
      mocks.creditLotService.getSpendableCredits.mockResolvedValue(0);
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
      expect(mocks.nodeTaskService.open).not.toHaveBeenCalled();
    });
  });

  describe("GET /canvas/nodes/:nodeId/history", () => {
    it("returns node history as { data: { entries, total } } (#1619 envelope)", async () => {
      const entry = { id: "h-1", entryType: "generation", status: "success" };
      // Mock the SERVICE's real shape ({ entries, total }); the route reads
      // result.entries, so a stale { data, total } mock would silently make
      // entries undefined and still pass a status-only assertion.
      mocks.nodeHistoryService.listByNode.mockResolvedValue({
        entries: [entry],
        total: 1,
      });

      const app = createApp();
      const res = await app.request(
        "/api/v1/canvas/nodes/b0000000-0000-4000-8000-000000000002/history?project_id=a0000000-0000-4000-8000-000000000001&limit=10&offset=0",
        { headers: AUTH },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { entries: [entry], total: 1 } });
    });

    it("422 for a non-uuid nodeId (canvas node ids are uuids)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/canvas/nodes/not-a-uuid/history?project_id=a0000000-0000-4000-8000-000000000001",
        { headers: AUTH },
      );
      expect(res.status).toBe(422);
    });
  });
});
