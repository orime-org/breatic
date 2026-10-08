// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A container job still running when a round of waiting ends (inner#888 §8.1).
 *
 * The run gives its worker slot back and comes back later, without spending
 * one of the queue's attempts: the job may run for the whole task budget,
 * and three attempts of one round each would end it long before that.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  /** Stand-in for the real class, matched by `instanceof` in the dispatcher. */
  class ContainerJobPending extends Error {
    constructor(readonly resumeAt: number) {
      super("still running");
    }
  }
  return {
    ContainerJobPending,
    warn: vi.fn(),
    runContainerJob: vi.fn(),
    markFailed: vi.fn(),
    moveToDelayed: vi.fn(),
    getByIdInternal: vi.fn(),
    markCompletedAndBill: vi.fn(),
    markRunning: vi.fn(),
  };
});

vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobPending: h.ContainerJobPending,
  runContainerJob: h.runContainerJob,
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
    setResolvedSkills: vi.fn(),
    markCompletedAndBill: h.markCompletedAndBill,
  },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: {},
  creditLotService: {},
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationFailure: vi.fn() },
  settleTaskForNode: vi.fn(),
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));

import { DelayedError, type Job } from "bullmq";

import { runTask } from "@worker/handlers/dispatch.js";

/**
 * A container mini-tool job as the queue hands it over.
 * @returns The job.
 */
function containerJob(attemptsMade = 0): Job {
  return {
    id: "job-1",
    attemptsMade,
    opts: { attempts: 3 },
    moveToDelayed: h.moveToDelayed,
    extendLock: async () => 1,
    data: {
      taskId: "task-1",
      taskType: "video",
      userId: "user-1",
      projectId: "proj-1",
      spaceId: "space-1",
      params: {},
      source: "mini_tool",
      toolId: "video.cut",
      sourceKey: "v/src.mp4",
      targetNodeIds: ["node-1"],
    },
  } as unknown as Job;
}

describe("a container job still running when a round of waiting ends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getByIdInternal.mockResolvedValue(null);
    h.markRunning.mockResolvedValue(new Date());
    h.runContainerJob.mockRejectedValue(new h.ContainerJobPending(1_800_000_000_000));
  });

  it("comes back at the time the container run named, without spending an attempt", async () => {
    await expect(runTask(containerJob(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.moveToDelayed).toHaveBeenCalledWith(1_800_000_000_000, "lock-token");
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
