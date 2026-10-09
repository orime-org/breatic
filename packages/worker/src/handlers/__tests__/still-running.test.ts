// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A run whose upstream work is still going when a pickup ends (inner#888
 * §8.1, inner#1337).
 *
 * The run gives its worker slot back and comes back later, without spending
 * one of the queue's attempts: a container job or an upstream prediction may
 * run for the whole two-hour task budget. A run past that budget ends once,
 * as expired, and the node's row says so.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  /** Stand-in for the real class, matched by `instanceof` in the dispatcher. */
  class StillRunning extends Error {
    constructor(readonly resumeAt: number) {
      super("still running");
    }
  }
  /** Stand-in for the real class, matched by `instanceof` in the dispatcher. */
  class TaskDeadlinePassed extends Error {
    constructor() {
      super("expired");
    }
  }
  return {
    StillRunning,
    TaskDeadlinePassed,
    warn: vi.fn(),
    runContainerJob: vi.fn(),
    runCatalogTask: vi.fn(),
    taskDeadline: vi.fn(),
    markFailed: vi.fn(),
    moveToDelayed: vi.fn(),
    getByIdInternal: vi.fn(),
    markCompletedAndBill: vi.fn(),
    markRunning: vi.fn(),
    settleTaskForNode: vi.fn(),
  };
});

vi.mock("@worker/providers/still-running.js", () => ({
  StillRunning: h.StillRunning,
  TaskDeadlinePassed: h.TaskDeadlinePassed,
}));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.taskDeadline }));
vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobFailed: class extends Error {},
  runContainerJob: h.runContainerJob,
}));
vi.mock("@worker/providers/run-steps.js", () => ({ runCatalogTask: h.runCatalogTask }));
vi.mock("@worker/providers/generate.js", () => ({
  validateModelParams: (_modality: string, model: string, params: Record<string, unknown>) => [model, params],
}));
vi.mock("@worker/handlers/step-deps.js", () => ({ stepDepsFor: () => ({}) }));
vi.mock("@worker/handlers/prompt-params.js", () => ({
  takePromptAndValidate: (params: Record<string, unknown>) => ["a cat", undefined, params],
}));
vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({})),
  getAgentConfig: vi.fn(() => ({})),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: vi.fn(),
    upsertGenerationSucceeded: vi.fn(),
  },
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(async () => ({ keyFromUrl: () => "video/out.mp4" })),
  getRawEnvVar: vi.fn(),
  getUnderstandConfig: vi.fn(() => ({})),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: {
    markFailed: h.markFailed,
    markRunning: h.markRunning,
    getByIdInternal: h.getByIdInternal,
    recordProviderResult: vi.fn(),
    recordProviderTaskId: vi.fn(),
    markCompletedAndBill: h.markCompletedAndBill,
  },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: { resolveOwnerStudioId: vi.fn(async () => "studio-1") },
  creditLotService: {},
  creditsForUsd: vi.fn(() => 0),
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationFailure: vi.fn() },
  settleTaskForNode: h.settleTaskForNode,
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));

import { DelayedError, type Job } from "bullmq";

import { runTask } from "@worker/handlers/dispatch.js";

const DEADLINE = 1_800_000_000_000;

/**
 * A job as the queue hands it over.
 * @param data - What differs from a canvas image generation.
 * @param attemptsMade - Attempts already spent.
 * @returns The job.
 */
function jobOf(data: Record<string, unknown>, attemptsMade = 0): Job {
  return {
    id: "job-1",
    attemptsMade,
    opts: { attempts: 3 },
    moveToDelayed: h.moveToDelayed,
    extendLock: async () => 1,
    data: {
      taskId: "task-1",
      taskType: "image",
      userId: "user-1",
      projectId: "proj-1",
      spaceId: "space-1",
      params: { prompt: "a cat" },
      model: "nano-banana-2",
      targetNodeIds: ["node-1"],
      ...data,
    },
  } as unknown as Job;
}

/**
 * A container mini-tool job.
 * @param attemptsMade - Attempts already spent.
 * @returns The job.
 */
function containerJob(attemptsMade = 0): Job {
  return jobOf(
    { taskType: "video", model: undefined, params: {}, source: "mini_tool", toolId: "video.cut", sourceKey: "v/src.mp4" },
    attemptsMade,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getByIdInternal.mockResolvedValue(null);
  h.markRunning.mockResolvedValue(new Date());
  h.taskDeadline.mockResolvedValue(DEADLINE);
  h.runContainerJob.mockRejectedValue(new h.StillRunning(DEADLINE - 60_000));
  h.runCatalogTask.mockRejectedValue(new h.StillRunning(DEADLINE - 60_000));
});

describe("a container job still running when a pickup ends", () => {
  it("comes back at the time the container run named, without spending an attempt", async () => {
    await expect(runTask(containerJob(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.moveToDelayed).toHaveBeenCalledWith(DEADLINE - 60_000, "lock-token");
  });

  // A container job keeps its id across pickups, so no pickup can bill the upstream twice.
  it("raises no duplicate-cost warning when a retried container job comes back", async () => {
    await expect(runTask(containerJob(1), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
  });

  it("leaves the task running, not failed", async () => {
    await expect(runTask(containerJob(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.markFailed).not.toHaveBeenCalled();
  });

  // A run picked up many times is one run: its duration starts at the first pickup.
  it("records the duration from the start markRunning keeps, not from the last pickup", async () => {
    h.markRunning.mockResolvedValue(new Date(Date.now() - 600_000));
    h.getByIdInternal.mockResolvedValue({ status: "running", startedAt: new Date(), billedAt: null, providerResultUrl: null, providerTaskId: null });
    h.runContainerJob.mockResolvedValue([{ outputs: [{ url: "https://cdn/out.mp4" }], cost: 0 }, 1]);

    await runTask(containerJob(), "lock-token").catch(() => undefined);

    const [, , , durationMs] = h.markCompletedAndBill.mock.calls[0]! as [string, unknown, number, number];
    expect(durationMs).toBeGreaterThanOrEqual(600_000);
  });
});

describe("an upstream prediction still running when a pickup ends", () => {
  it("comes back at the time the poll named, without spending an attempt", async () => {
    await expect(runTask(jobOf({}), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.moveToDelayed).toHaveBeenCalledWith(DEADLINE - 60_000, "lock-token");
    expect(h.markFailed).not.toHaveBeenCalled();
  });

  it("hands the task's deadline to the steps of a canvas generation", async () => {
    await runTask(jobOf({}), "lock-token").catch(() => undefined);

    expect(h.taskDeadline).toHaveBeenCalledWith("task-1");
    expect(h.runCatalogTask.mock.calls[0]![1]).toMatchObject({ taskId: "task-1", deadlineAt: DEADLINE });
  });

  it("hands the task's deadline to the steps of a model mini-tool", async () => {
    await runTask(jobOf({ source: "mini_tool", toolId: "image.remove-bg", model: undefined }), "lock-token").catch(
      () => undefined,
    );

    expect(h.runCatalogTask.mock.calls[0]![1]).toMatchObject({ taskId: "task-1", deadlineAt: DEADLINE });
  });

  it("fails a run whose task row is gone, without putting it back on the queue", async () => {
    h.taskDeadline.mockResolvedValue(null);

    await runTask(jobOf({}, 2), "lock-token").catch(() => undefined);

    expect(h.runCatalogTask).not.toHaveBeenCalled();
    expect(h.moveToDelayed).not.toHaveBeenCalled();
    expect(h.markFailed).toHaveBeenCalled();
  });
});

describe("a run past its two-hour deadline", () => {
  beforeEach(() => {
    h.runCatalogTask.mockRejectedValue(new h.TaskDeadlinePassed());
  });

  it("settles on the first attempt that finds it, with attempts still left", async () => {
    const result = await runTask(jobOf({}, 0), "lock-token");

    expect(result).toMatchObject({ failed: true, reason: "expired" });
    expect(h.moveToDelayed).not.toHaveBeenCalled();
  });

  it("settles the node's row as expired, not failed", async () => {
    await runTask(jobOf({}, 0), "lock-token");

    expect(h.settleTaskForNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ taskId: "task-1", nodeId: "node-1", outcome: "expired" }),
    );
  });

  it("settles a model mini-tool's row as expired too", async () => {
    await runTask(jobOf({ source: "mini_tool", toolId: "image.remove-bg", model: undefined }, 0), "lock-token");

    expect(h.settleTaskForNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ outcome: "expired" }),
    );
  });

  it("settles any other failure as failed", async () => {
    h.runCatalogTask.mockRejectedValue(new Error("boom"));

    await runTask(jobOf({}, 2), "lock-token").catch(() => undefined);

    expect(h.settleTaskForNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ outcome: "failed" }),
    );
  });
});
