/**
 * Mini-tools credit pre-check regression test (BUG-015) +
 * target_node_id forwarding + validation tests (Phase 2 forward-fix A.4).
 *
 * Verifies that:
 *  - Mini-tool endpoints return 402 when user has insufficient credits.
 *  - target_node_id is forwarded to the BullMQ job payload as targetNodeIds.
 *  - Missing or invalid target_node_id is rejected with 400.
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
import { mocks, mockQueueAdd, mockCreateQueue } from "../helpers/mock-core.js";

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };

/** Valid UUID for target_node_id in all "happy path" requests. */
const VALID_NODE_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("Mini-tools credit pre-check (BUG-015)", () => {
  beforeEach(() => {
    mocks.creditService.getBalance.mockReset();
    mocks.taskService.create.mockReset();
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
    mockQueueAdd.mockReset();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
  });

  it("rejects image tool with 402 when insufficient credits", async () => {
    mocks.creditService.getBalance.mockResolvedValue(0);

    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        target_node_id: VALID_NODE_ID,
      }),
    });

    expect(res.status).toBe(402);
  });

  it("allows image tool when credits sufficient", async () => {
    mocks.creditService.getBalance.mockResolvedValue(100);

    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        target_node_id: VALID_NODE_ID,
      }),
    });

    expect(res.status).toBe(201);
  });
});

describe("Mini-tools target_node_id forwarding (Phase 2 forward-fix A.4)", () => {
  beforeEach(() => {
    mocks.creditService.getBalance.mockReset();
    mocks.creditService.getBalance.mockResolvedValue(100);
    mocks.taskService.create.mockReset();
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
    mocks.taskService.setJobId.mockReset();
    mockQueueAdd.mockReset();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
  });

  it("forwards target_node_id to the BullMQ job payload as targetNodeIds array", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        target_node_id: VALID_NODE_ID,
      }),
    });

    expect(res.status).toBe(201);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const [, jobPayload] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobPayload.targetNodeIds).toEqual([VALID_NODE_ID]);
  });

  it("includes source: 'mini_tool' in BullMQ job payload (worker dispatcher routing)", async () => {
    // Regression guard for the Phase 2 bug where source was missing from
    // payload, causing worker to fall through to AIGC direct path which
    // expects a `model` field. Caught in dev smoke test (PR #16).
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        target_node_id: VALID_NODE_ID,
      }),
    });

    expect(res.status).toBe(201);
    const [, jobPayload] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobPayload.source).toBe("mini_tool");
  });

  it("includes projectId in BullMQ job payload (required by emitNodeStateFailed)", async () => {
    // Regression guard for the Phase 2 bug where projectId was missing
    // from payload. The worker computes docName = projectDocName(projectId)
    // when emitting failure events; missing projectId throws inside the
    // emit helper. Caught in dev smoke test (PR #16).
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        project_id: "11111111-1111-1111-1111-111111111111",
        target_node_id: VALID_NODE_ID,
      }),
    });

    expect(res.status).toBe(201);
    const [, jobPayload] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobPayload.projectId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("queues to 'tasks' (not 'mini-tools') so the worker picks up the job", async () => {
    // Regression guard for the Phase 2 bug where mini-tools.ts called
    // createQueue("mini-tools") but the worker only listens on "tasks".
    // Tasks would silently sit pending forever. Caught in dev smoke test (PR #16).
    const app = createApp();
    await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        target_node_id: VALID_NODE_ID,
      }),
    });

    // The mini-tools route initializes its queue via createQueue at module load time;
    // mockCreateQueue captures every call across the test process.
    const queueNames = mockCreateQueue.mock.calls.map((call) => call[0]);
    expect(queueNames).toContain("tasks");
    expect(queueNames).not.toContain("mini-tools");
  });

  it("rejects with 400 when target_node_id is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        // target_node_id deliberately omitted
      }),
    });

    expect(res.status).toBe(400);
    // No job should be queued
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("rejects with 400 when target_node_id is not a valid UUID", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        target_node_id: "not-a-uuid",
      }),
    });

    expect(res.status).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
