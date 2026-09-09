// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Landing a finished generation on its node (#186, design §3.6).
 *
 * The settle that ends a generation carries the result with it: the content
 * url and the cover reach the node through that one call and no other. So a
 * failure there is the difference between the user seeing their image and the
 * node staying empty after they were charged for it — the same reason
 * `video-cover-job` fails its job rather than swallowing a failed publish.
 *
 * On a live run the throw is what makes BullMQ redeliver, and the redelivery
 * lands: `settle` reports `landed` for a row that already holds this outcome,
 * so the second pass republishes the result. On the terminal crash-net pass
 * there is no delivery left to make, so the failure is recorded and the net
 * carries on.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockRecordSuccess = vi.hoisted(() => vi.fn());
const mockSettleTaskForNode = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({})),
  getAgentConfig: vi.fn(() => ({})),
  projectActivitiesRepo: { insert: vi.fn() },
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: mockError, debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  taskService: {},
  assetService: {},
  creditLotService: {},
  resolveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationSuccess: mockRecordSuccess },
  settleTaskForNode: mockSettleTaskForNode,
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
}));

import { recordGenerationForNodes } from "@worker/handlers/dispatch.js";

const CTX = {
  projectId: "proj-1",
  userId: "user-1",
  taskId: "task-1",
  taskType: "image",
  metadata: { model: "m", cost: 10 },
};

const OUTPUTS = [{ nodeId: "node-1", url: "https://cdn/image/result.png" }];

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordSuccess.mockResolvedValue({ id: "history-1" });
});

describe("recordGenerationForNodes, the settle that carries the result", () => {
  it("hands the row its history and the content the node will show", async () => {
    mockSettleTaskForNode.mockResolvedValue(undefined);

    await recordGenerationForNodes(
      {} as never,
      "project-proj-1/canvas-space-1",
      CTX,
      OUTPUTS,
      {},
    );

    // `nodeHistoryId` is what the list left-joins to read a row's content, so
    // without it every done row comes back empty and loses its Replace.
    expect(mockSettleTaskForNode).toHaveBeenCalledWith(
      {},
      "project-proj-1/canvas-space-1",
      expect.objectContaining({
        taskId: "task-1",
        nodeId: "node-1",
        outcome: "done",
        nodeHistoryId: "history-1",
        result: expect.objectContaining({ content: OUTPUTS[0]!.url }),
      }),
    );
  });

  it("settles an output that produced no url as failed, saying so (#196)", async () => {
    // Stage 3 has already charged for this run by the time this is reached
    // (`dispatch.ts` bills before it settles), so leaving the row alone costs
    // the user credits for a node that stays empty. The row does not sit in
    // `running` either — the next read of that node's list harvests it to
    // `expired`, which names the wrong cause: nothing timed out, the provider
    // came back without an artifact. Only `failed` says what happened.
    mockSettleTaskForNode.mockResolvedValue(undefined);

    await recordGenerationForNodes(
      {} as never,
      "project-proj-1/canvas-space-1",
      CTX,
      [{ nodeId: "node-1", url: undefined }],
      {},
    );

    expect(mockSettleTaskForNode).toHaveBeenCalledWith(
      {},
      "project-proj-1/canvas-space-1",
      expect.objectContaining({
        taskId: "task-1",
        nodeId: "node-1",
        outcome: "failed",
        // A cause we author travels as a code, so the sentence is written in
        // the reader's language rather than frozen in the worker's (#186 §7.1).
        errorMessage: "no_result",
      }),
    );
    // A result is what carries content to the node; there is none to carry.
    expect(mockSettleTaskForNode.mock.calls[0]?.[2]).not.toHaveProperty("result");
    // No artifact means no history row to point at either.
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it("fails the job on a live run so the delivery is made again", async () => {
    mockSettleTaskForNode.mockRejectedValue(new Error("stream is gone"));

    await expect(
      recordGenerationForNodes({} as never, "project-proj-1/canvas-space-1", CTX, OUTPUTS, {
        rethrowOnRecordFailure: true,
      }),
    ).rejects.toThrow("stream is gone");
  });

  it("records the failure and carries on past the crash-net pass", async () => {
    mockSettleTaskForNode.mockRejectedValue(new Error("stream is gone"));

    await recordGenerationForNodes(
      {} as never,
      "project-proj-1/canvas-space-1",
      CTX,
      OUTPUTS,
      {},
    );

    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", nodeId: "node-1" }),
      expect.stringContaining("node_task settle"),
    );
  });
});
