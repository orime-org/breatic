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
  publishActivityNew: vi.fn(),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: vi.fn(),
    upsertGenerationSucceeded: vi.fn(),
  },
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

import {
  cleanupFailedJobNodes,
  reclaimFailedJobById,
} from "@worker/handlers/failed-job-cleanup.js";
import type { TaskJobData } from "@worker/handlers/dispatch.js";
import { taskService, nodeHistoryService } from "@breatic/domain";

const streamRedis = {} as never;

/**
 * Build a minimal failed-job stand-in.
 *
 * Terminal-failure signal is `finishedOn` (BullMQ sets it for BOTH terminal
 * paths — processJob's non-retry branch AND the stalled-death Lua — but
 * NOT for a retryable failure; source-verified against bullmq 5.30.0). A
 * retryable failure has finishedOn undefined.
 * @param data - Job payload overrides.
 * @param finishedOn - Terminal-completion epoch ms; undefined = retry pending.
 * @returns A job-shaped object for the cleanup helper.
 */
function jobWith(
  data: Partial<TaskJobData>,
  finishedOn: number | undefined = 1_700_000_000_000,
): { data: TaskJobData; finishedOn?: number } {
  return {
    data: {
      taskId: "t1",
      taskType: "generate",
      userId: "u1",
      params: {},
      ...data,
    } as TaskJobData,
    finishedOn,
  };
}

describe("cleanupFailedJobNodes (#1569 worker silent-death safety net)", () => {
  beforeEach(() => {
    mockPublishNodeEvent.mockReset();
    vi.mocked(taskService.getByIdInternal).mockReset();
    vi.mocked(nodeHistoryService.recordGenerationSuccess).mockReset();
  });

  it("stamps each node's lease gen from job nodeGens onto the reclaim event (#1580 #7)", async () => {
    const job = jobWith({
      projectId: "p1",
      spaceId: "s1",
      targetNodeIds: ["n1", "n2"],
      nodeGens: { n1: 4, n2: 9 },
    });
    await cleanupFailedJobNodes(streamRedis, job, "worker crashed");
    const events = mockPublishNodeEvent.mock.calls.map(
      ([, e]) => e as { nodeId: string; gen: number },
    );
    expect(events.find((e) => e.nodeId === "n1")?.gen).toBe(4);
    expect(events.find((e) => e.nodeId === "n2")?.gen).toBe(9);
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

  it("fires for a STALLED-DEATH job (finishedOn set) — the exact case the attemptsMade gate missed (#1569 bug B)", async () => {
    // BullMQ's moveStalledJobsToWait Lua moves a maxStalledCount-exceeded
    // job straight to the failed set: it HMSETs finishedOn but does NOT
    // increment attemptsMade. The old gate `attemptsMade < attempts` was
    // therefore true → cleanup skipped → the node stayed a zombie, which
    // is the PRIMARY death this safety net targets. finishedOn is the
    // reliable terminal signal.
    const stalled = jobWith({
      projectId: "p1",
      spaceId: "s1",
      targetNodeIds: ["n1"],
    });
    expect(await cleanupFailedJobNodes(streamRedis, stalled, "job stalled more than allowable limit")).toBe(1);
    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit while a retry is pending (finishedOn absent — the retry re-drives the node)", async () => {
    // Built inline (not via jobWith, whose default-param would re-supply a
    // finishedOn when passed `undefined`) so finishedOn is genuinely absent.
    const job = {
      data: {
        taskId: "t1",
        taskType: "generate",
        userId: "u1",
        params: {},
        projectId: "p1",
        spaceId: "s1",
        targetNodeIds: ["n1"],
      } as TaskJobData,
      // finishedOn intentionally absent — BullMQ leaves it undefined for a
      // retryable failure (job moved to delayed/waiting, not finished).
    };
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

  it("re-records node_history + emits SUCCESS (not failure) for a BILLED terminal-failed task (#1618 A / hole ①)", async () => {
    // A task that billed (Stage 3) then terminally failed before Stage-4
    // recorded — the crash-net must recover the paid result, not stamp
    // 'failed' over it.
    vi.mocked(taskService.getByIdInternal).mockResolvedValue({
      id: "t1",
      userId: "u1",
      taskType: "image",
      billedAt: new Date(),
      billedCredits: 4,
      durationMs: 1000,
      params: {},
      result: {
        model: "resolved-m",
        cost: 0.04,
        outputs: [{ url: "https://x/done.png", cover_url: "https://x/cover.png" }],
      },
    } as never);
    const job = jobWith({
      projectId: "p1",
      spaceId: "s1",
      targetNodeIds: ["n1"],
      nodeGens: { n1: 3 },
    });

    await cleanupFailedJobNodes(streamRedis, job, "job stalled more than allowable limit");

    // The billed result is re-recorded to node_history (recoverable via #1619).
    expect(nodeHistoryService.recordGenerationSuccess).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(nodeHistoryService.recordGenerationSuccess).mock.calls[0]![0],
    ).toMatchObject({ nodeId: "n1", content: "https://x/done.png", taskId: "t1" });
    // The write-back is a SUCCESS (content set), NOT a failure over the paid result.
    const [, event] = mockPublishNodeEvent.mock.calls[0] as [
      unknown,
      { update: Record<string, unknown> },
    ];
    expect(event.update.content).toBe("https://x/done.png");
  });
});

describe("reclaimFailedJobById (#1580 #6 cross-process QueueEvents handler)", () => {
  beforeEach(() => {
    mockPublishNodeEvent.mockReset();
    vi.mocked(taskService.getByIdInternal).mockReset();
    vi.mocked(nodeHistoryService.recordGenerationSuccess).mockReset();
  });

  it("fetches the job by id and writes back every target node of a finally-failed job", async () => {
    // QueueEvents 'failed' delivers only { jobId, failedReason } cross-process;
    // this handler re-fetches the job (retained by removeOnFail age) to read
    // its data + finishedOn, then delegates to the shared write-back.
    const job = jobWith({
      projectId: "p1",
      spaceId: "s1",
      targetNodeIds: ["n1", "n2"],
    });
    const getJob = vi.fn(async (id: string) => (id === "job-42" ? job : undefined));
    const emitted = await reclaimFailedJobById(
      { getJob },
      streamRedis,
      "job-42",
      "boom",
    );
    expect(getJob).toHaveBeenCalledWith("job-42");
    expect(emitted).toBe(2);
    expect(mockPublishNodeEvent).toHaveBeenCalledTimes(2);
  });

  it("no-ops when the job cannot be fetched (removed / unknown id)", async () => {
    const getJob = vi.fn(async () => undefined);
    const emitted = await reclaimFailedJobById(
      { getJob },
      streamRedis,
      "gone",
      "boom",
    );
    expect(emitted).toBe(0);
    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });

  it("still respects the finishedOn terminal gate (a retryable fetched job → no write-back)", async () => {
    const retryable = {
      data: {
        taskId: "t1",
        taskType: "generate",
        userId: "u1",
        params: {},
        projectId: "p1",
        spaceId: "s1",
        targetNodeIds: ["n1"],
      } as TaskJobData,
      // finishedOn absent — retry pending.
    };
    const getJob = vi.fn(async () => retryable);
    expect(
      await reclaimFailedJobById({ getJob }, streamRedis, "j", "boom"),
    ).toBe(0);
    expect(mockPublishNodeEvent).not.toHaveBeenCalled();
  });
});
