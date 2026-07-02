// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for handlers/failed-job-cleanup.ts (#1569 hole ②).
 *
 * When BullMQ judges a job dead WITHOUT the handler's own failure paths
 * running (worker crashed after markRunning, stalled death after
 * maxStalledCount), nothing wrote the node's Yjs `handling` back — the
 * node stayed a zombie forever. `cleanupFailedJobNodes` is the
 * `worker.on('failed')` safety net that emits the standard failure
 * write-back for every target node of a FINALLY-failed job.
 *
 * No real Redis — publishNodeEvent from @breatic/core is fully mocked
 * (same pattern as emit-node-state-update.test.ts).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockPublishNodeEvent = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  publishNodeEvent: mockPublishNodeEvent,
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
}));

vi.mock("@breatic/domain", () => ({
  taskService: {
    getByIdInternal: vi.fn(),
    markRunning: vi.fn(),
    markFailed: vi.fn(),
    markCompletedAndBill: vi.fn(),
    recordProviderResult: vi.fn(),
    setResolvedSkills: vi.fn(),
  },
  creditService: { deduct: vi.fn() },
  nodeHistoryService: {
    recordGenerationSuccess: vi.fn(),
    recordGenerationFailure: vi.fn(),
  },
  getModel: vi.fn(),
  buildToolSet: vi.fn(),
  runAgentLoop: vi.fn(),
  verifyCanvasNodeLock: vi.fn(),
  releaseCanvasNodeLock: vi.fn(),
  getModelCatalog: vi.fn(),
  resolveModelPricing: vi.fn(),
}));

vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (pid: string, sid: string) => `project-${pid}/canvas-${sid}`,
}));

// mini-tool-registry + local handlers + ai are pulled in transitively by
// handlers/dispatch.ts (which we import for emitNodeStateFailed) — mock
// them so the otel / provider chains never load (same as
// emit-node-state-update.test.ts).
vi.mock("@worker/mini-tool-registry.js", () => ({
  resolveMiniToolEntry: vi.fn(),
}));
vi.mock("@worker/handlers/local/index.js", () => ({
  runLocalHandler: vi.fn(),
}));
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import type { TaskJobData } from "@worker/handlers/dispatch.js";

const streamRedis = {} as never;

/**
 * Build a minimal failed-job stand-in.
 * @param data - Job payload overrides.
 * @param attemptsMade - Attempts already consumed.
 * @param attempts - Configured max attempts.
 * @returns A job-shaped object for the cleanup helper.
 */
function jobWith(
  data: Partial<TaskJobData>,
  attemptsMade = 3,
  attempts = 3,
): { data: TaskJobData; attemptsMade: number; opts: { attempts?: number } } {
  return {
    data: {
      taskId: "t1",
      taskType: "generate",
      userId: "u1",
      params: {},
      ...data,
    } as TaskJobData,
    attemptsMade,
    opts: { attempts },
  };
}

describe("cleanupFailedJobNodes (#1569 worker silent-death safety net)", () => {
  beforeEach(() => {
    mockPublishNodeEvent.mockReset();
  });

  it("emits the standard failure write-back for every target node of a finally-failed job", async () => {
    const job = jobWith({
      projectId: "p1",
      spaceId: "s1",
      targetNodeIds: ["n1", "n2"],
    });
    const emitted = await cleanupFailedJobNodes(streamRedis, job, "job stalled more than allowable limit");
    expect(emitted).toBe(2);
    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);
    const [, event] = mockPublishNodeEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event).toMatchObject({
      type: "node-state-update",
      docName: expect.stringContaining("canvas-s1"),
      nodeId: "n1",
      update: {
        state: "idle",
        handlingBy: null,
      },
    });
    expect(
      (event.update as Record<string, unknown>).errorMessage,
    ).toContain("stalled");
  });

  it("does NOT emit while retries remain (the retry will re-drive the node)", async () => {
    const job = jobWith(
      { projectId: "p1", spaceId: "s1", targetNodeIds: ["n1"] },
      1,
      3,
    );
    expect(await cleanupFailedJobNodes(streamRedis, job, "boom")).toBe(0);
    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });

  it("no-ops for non-canvas jobs (no projectId/spaceId or no targetNodeIds)", async () => {
    expect(
      await cleanupFailedJobNodes(streamRedis, jobWith({ targetNodeIds: ["n1"] }), "x"),
    ).toBe(0);
    expect(
      await cleanupFailedJobNodes(
        streamRedis,
        jobWith({ projectId: "p1", spaceId: "s1", targetNodeIds: [] }),
        "x",
      ),
    ).toBe(0);
    expect(await cleanupFailedJobNodes(streamRedis, undefined, "x")).toBe(0);
    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });

  it("swallows publish errors per node (best-effort — one bad node must not skip the rest)", async () => {
    mockPublishNodeEvent
      .mockRejectedValueOnce(new Error("stream down"))
      .mockResolvedValueOnce(undefined);
    const job = jobWith({
      projectId: "p1",
      spaceId: "s1",
      targetNodeIds: ["n1", "n2"],
    });
    const emitted = await cleanupFailedJobNodes(streamRedis, job, "boom");
    expect(emitted).toBe(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);
  });
});
