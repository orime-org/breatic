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
  class ContainerJobPending extends Error {}
  return {
    ContainerJobPending,
    runContainerJob: vi.fn(),
    markFailed: vi.fn(),
    moveToDelayed: vi.fn(),
  };
});

vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobPending: h.ContainerJobPending,
  runContainerJob: h.runContainerJob,
}));
vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({ poll_interval: 3000 })),
  getAgentConfig: vi.fn(() => ({})),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: vi.fn(),
    upsertGenerationSucceeded: vi.fn(),
  },
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(),
  getRawEnvVar: vi.fn(),
  getUnderstandConfig: vi.fn(() => ({})),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: {
    markFailed: h.markFailed,
    markRunning: vi.fn(),
    getByIdInternal: vi.fn(async () => null),
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
function containerJob(): Job {
  return {
    id: "job-1",
    attemptsMade: 0,
    opts: { attempts: 3 },
    moveToDelayed: h.moveToDelayed,
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
    h.runContainerJob.mockRejectedValue(new h.ContainerJobPending("still running"));
  });

  it("comes back after one poll interval without spending an attempt", async () => {
    const before = Date.now();

    await expect(runTask(containerJob(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock-token");
    const [at] = h.moveToDelayed.mock.calls[0]! as [number];
    expect(at).toBeGreaterThanOrEqual(before + 3000);
  });

  it("leaves the task running, not failed", async () => {
    await expect(runTask(containerJob(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.markFailed).not.toHaveBeenCalled();
  });
});
