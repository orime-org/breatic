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
    updateData: vi.fn(),
    info: vi.fn(),
    slotFull: { value: false },
    threeD: vi.fn(),
    understandMediaAt: vi.fn(),
  };
});

vi.mock("@worker/providers/still-running.js", () => ({
  StillRunning: h.StillRunning,
  TaskDeadlinePassed: h.TaskDeadlinePassed,
  assertBeforeDeadline: (deadlineAt: number): void => {
    if (Date.now() >= deadlineAt) throw new h.TaskDeadlinePassed();
  },
}));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.taskDeadline }));
vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobFailed: class extends Error {},
  runContainerJob: h.runContainerJob,
}));
vi.mock("@worker/providers/run-steps.js", () => ({ runCatalogTask: h.runCatalogTask }));
vi.mock("@worker/providers/three-d/index.js", () => ({
  validateThreeDParams: (model: string, params: Record<string, unknown>) => [model, params],
  generateAsync: h.threeD,
}));
vi.mock("@worker/providers/generate.js", () => ({
  validateModelParams: (_modality: string, model: string, params: Record<string, unknown>) => [model, params],
}));
vi.mock("@worker/handlers/step-deps.js", () => ({ stepDepsFor: () => ({}) }));
vi.mock("@worker/handlers/understand-slots.js", () => ({
  withUnderstandSlot: async <T>(read: () => Promise<T>): Promise<T> => {
    if (h.slotFull.value) throw new h.StillRunning(DEADLINE - 60_000);
    return read();
  },
}));
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
  logger: { info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() },
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
  understandMediaAt: h.understandMediaAt,
  MediaUnavailable: class extends Error {},
  UnderstandRefused: class extends Error {},
  createUsageRecorder: () => ({ recordServiceCall: vi.fn(), settle: async () => 0 }),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));

import { DelayedError, type Job } from "bullmq";

import { runTask } from "@worker/handlers/dispatch.js";

const DEADLINE = 1_800_000_000_000;
const CREATED = new Date(DEADLINE - 7_200_000);

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
    stalledCounter: 0,
    opts: { attempts: 3 },
    moveToDelayed: h.moveToDelayed,
    updateData: h.updateData,
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
  vi.restoreAllMocks();
  h.slotFull.value = false;
  h.getByIdInternal.mockResolvedValue({
    createdAt: CREATED,
    billedAt: null,
    providerResultUrl: null,
    providerTaskId: null,
  });
  h.markRunning.mockResolvedValue(new Date());
  h.taskDeadline.mockResolvedValue(DEADLINE);
  h.runContainerJob.mockRejectedValue(new h.StillRunning(DEADLINE - 60_000));
  h.runCatalogTask.mockRejectedValue(new h.StillRunning(DEADLINE - 60_000));
  h.threeD.mockRejectedValue(new h.StillRunning(DEADLINE - 60_000));
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

    expect(h.taskDeadline).toHaveBeenCalledWith("task-1", CREATED);
    expect(h.runCatalogTask.mock.calls[0]![1]).toMatchObject({ taskId: "task-1", deadlineAt: DEADLINE });
  });

  it("hands the task's deadline to the steps of a model mini-tool", async () => {
    await runTask(jobOf({ source: "mini_tool", toolId: "image.remove-bg", model: undefined }), "lock-token").catch(
      () => undefined,
    );

    expect(h.runCatalogTask.mock.calls[0]![1]).toMatchObject({ taskId: "task-1", deadlineAt: DEADLINE });
  });

  it("puts a container job back on the queue past the task deadline: the container judges its own, with a grace", async () => {
    vi.spyOn(Date, "now").mockReturnValue(DEADLINE + 1);

    await expect(runTask(containerJob(), "lock-token")).rejects.toBeInstanceOf(DelayedError);
    expect(h.taskDeadline).not.toHaveBeenCalled();
  });

  it("fails a run whose task row is gone, without putting it back on the queue", async () => {
    h.taskDeadline.mockRejectedValue(new Error("task task-1 has no row to run against"));

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

describe("work still going at the two-hour deadline", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(DEADLINE);
  });

  it("settles a generation as expired instead of putting it back on the queue", async () => {
    const result = await runTask(jobOf({}, 0), "lock-token");

    expect(result).toMatchObject({ failed: true, reason: "expired" });
    expect(h.moveToDelayed).not.toHaveBeenCalled();
    expect(h.settleTaskForNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ taskId: "task-1", outcome: "expired" }),
    );
  });

  it("settles a reading picked up past its deadline as expired, without reading the media", async () => {
    const result = await runTask(
      jobOf({ taskType: "understand", model: undefined, params: { source_type: "image", source_url: "https://a/cat.png" } }),
      "lock-token",
    );

    expect(result).toMatchObject({ failed: true, reason: "expired" });
    expect(h.understandMediaAt).not.toHaveBeenCalled();
  });

  it("settles a reading that never got a place as expired", async () => {
    h.slotFull.value = true;

    const result = await runTask(
      jobOf({ taskType: "understand", model: undefined, params: { source_type: "image", source_url: "https://a/cat.png" } }),
      "lock-token",
    );

    expect(result).toMatchObject({ failed: true, reason: "expired" });
    expect(h.understandMediaAt).not.toHaveBeenCalled();
    expect(h.moveToDelayed).not.toHaveBeenCalled();
  });
});

describe("a reading that finds every place taken", () => {
  it("goes back to the queue before its deadline", async () => {
    h.slotFull.value = true;

    await expect(
      runTask(
        jobOf({ taskType: "understand", model: undefined, params: { source_type: "image", source_url: "https://a/cat.png" } }),
        "lock-token",
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(h.moveToDelayed).toHaveBeenCalledWith(DEADLINE - 60_000, "lock-token");
  });
});

describe("the retry log lines", () => {
  /**
   * A job on its second attempt.
   * @param reported - The attempt the log lines were already written for.
   * @returns The job.
   */
  function retried(reported?: number): Job {
    const job = jobOf({}, 1);
    if (reported !== undefined) (job.data as Record<string, unknown>).retryReported = reported;
    return job;
  }

  /**
   * A reading on its second attempt: a retry reads the media and asks the service again.
   * @param attemptsMade - Attempts already spent.
   * @param reported - The attempt the log lines were already written for.
   * @returns The job.
   */
  function retriedReading(attemptsMade = 1, reported?: number): Job {
    const job = jobOf(
      { taskType: "understand", model: undefined, params: { source_type: "image", source_url: "https://a/cat.png" } },
      attemptsMade,
    );
    if (reported !== undefined) (job.data as Record<string, unknown>).retryReported = reported;
    return job;
  }

  it("warns once on the pickup that starts a retry of a run that calls its upstream again, and records it", async () => {
    await runTask(retriedReading(), "lock-token").catch(() => undefined);

    expect(h.warn).toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
    expect(h.updateData).toHaveBeenCalledWith(expect.objectContaining({ retryReported: 1 }));
  });

  it("stays quiet on the later pickups of the same attempt", async () => {
    await runTask(retriedReading(1, 1), "lock-token").catch(() => undefined);

    expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
    expect(h.updateData).not.toHaveBeenCalled();
  });

  it("warns again on the pickup that starts the next retry", async () => {
    await runTask(retriedReading(2, 1), "lock-token").catch(() => undefined);

    expect(h.warn).toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
    expect(h.updateData).toHaveBeenCalledWith(expect.objectContaining({ retryReported: 2 }));
  });

  it("names the task in a reading's duplicate-cost warning", async () => {
    await runTask(retriedReading(), "lock-token").catch(() => undefined);

    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", taskType: "understand", attempt: 2 }),
      "provider_reinvoked_on_retry_potential_duplicate_cost",
    );
  });

  // A worker that died mid-run leaves its job stalled; the queue hands it out
  // again without counting an attempt, and the run before may have submitted.
  it("counts a stalled redelivery as a retry starting, once", async () => {
    const stalled = retriedReading(0);
    (stalled as unknown as { stalledCounter: number }).stalledCounter = 1;

    await runTask(stalled, "lock-token").catch(() => undefined);

    expect(h.warn).toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
    expect(h.updateData).toHaveBeenCalledWith(expect.objectContaining({ retryReported: 1 }));
  });

  it("stays quiet on a later pickup after a stalled redelivery was reported", async () => {
    const stalled = retriedReading(0, 1);
    (stalled as unknown as { stalledCounter: number }).stalledCounter = 1;

    await runTask(stalled, "lock-token").catch(() => undefined);

    expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
  });

  it("logs the stored upstream id on the pickup that starts a retry", async () => {
    h.getByIdInternal.mockResolvedValue({
      createdAt: CREATED,
      billedAt: null,
      providerResultUrl: null,
      providerTaskId: "ws-1",
    });

    await runTask(jobOf({ taskType: "three_d", model: "meshy-6" }, 1), "lock-token").catch(() => undefined);

    expect(h.info).toHaveBeenCalledWith(expect.anything(), "async_resume_stored_provider_task");
    expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
  });

  it("leaves a generation's warning to the step that submits again, and tells the steps a retry starts", async () => {
    await runTask(retried(), "lock-token").catch(() => undefined);

    expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "provider_reinvoked_on_retry_potential_duplicate_cost");
    expect(h.runCatalogTask.mock.calls[0]![1]).toMatchObject({ retryStarting: true });
  });

  it("tells a generation's steps no retry starts on a later pickup of the same attempt", async () => {
    await runTask(retried(1), "lock-token").catch(() => undefined);

    expect(h.runCatalogTask.mock.calls[0]![1]).toMatchObject({ retryStarting: false });
  });

  it("tells a 3D submit that a retry starts, for the submit to say so", async () => {
    await runTask(jobOf({ taskType: "three_d", model: "meshy-6" }, 1), "lock-token").catch(() => undefined);

    expect(h.threeD.mock.calls[0]![3]).toMatchObject({ retryStarting: true });
  });

  it("logs a stored upstream id once per attempt, not on every pickup", async () => {
    h.getByIdInternal.mockResolvedValue({
      createdAt: CREATED,
      billedAt: null,
      providerResultUrl: null,
      providerTaskId: "ws-1",
    });

    await runTask(retried(1), "lock-token").catch(() => undefined);

    expect(h.info).not.toHaveBeenCalledWith(expect.anything(), "async_resume_stored_provider_task");
  });
});
