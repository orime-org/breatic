/**
 * Mini-tools credit pre-check regression test (BUG-015) +
 * history_item_id forwarding + validation tests (Phase 1 catchup).
 *
 * Verifies that:
 *  - Mini-tool endpoints return 402 when user has insufficient credits.
 *  - history_item_id is forwarded to the BullMQ job payload.
 *  - Missing or invalid history_item_id is rejected with 400.
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
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };

/** Valid UUID for history_item_id in all "happy path" requests. */
const VALID_HISTORY_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

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
        history_item_id: VALID_HISTORY_ID,
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
        history_item_id: VALID_HISTORY_ID,
      }),
    });

    expect(res.status).toBe(201);
  });
});

describe("Mini-tools history_item_id forwarding (Phase 1 catchup)", () => {
  beforeEach(() => {
    mocks.creditService.getBalance.mockReset();
    mocks.creditService.getBalance.mockResolvedValue(100);
    mocks.taskService.create.mockReset();
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
    mocks.taskService.setJobId.mockReset();
    mockQueueAdd.mockReset();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
  });

  it("forwards history_item_id to the BullMQ job payload", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        history_item_id: VALID_HISTORY_ID,
      }),
    });

    expect(res.status).toBe(201);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const [, jobPayload] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobPayload.historyItemId).toBe(VALID_HISTORY_ID);
  });

  it("rejects with 400 when history_item_id is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        // history_item_id deliberately omitted
      }),
    });

    expect(res.status).toBe(400);
    // No job should be queued
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("rejects with 400 when history_item_id is not a valid UUID", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
        history_item_id: "not-a-uuid",
      }),
    });

    expect(res.status).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
