// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the node says when a job comes back after the provider was called.
 *
 * The queue can hand the same job over twice — a worker that called the
 * provider and died before billing leaves a task with a result URL and no
 * charge. Policy is to stop there rather than call the provider again, and
 * the run has to end somewhere the reader can see.
 *
 * Where it ends is a node's history row, which is read in whatever language
 * the reader set. So what lands there is one of our causes, not the sentence
 * an operator would want: which part of the queue did what is the log's to
 * say, and the log already says it.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockMarkFailed = vi.hoisted(() => vi.fn());
const mockRecordFailure = vi.hoisted(() => vi.fn());
const mockSettleTaskForNode = vi.hoisted(() => vi.fn());
const mockGetByIdInternal = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({})),
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
  logger: { info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: {
    markFailed: mockMarkFailed,
    getByIdInternal: mockGetByIdInternal,
  },
  assetService: {},
  creditLotService: {},
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationFailure: mockRecordFailure },
  settleTaskForNode: mockSettleTaskForNode,
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
  extractPromptText: vi.fn(),
}));

import type { Job } from "bullmq";

import { runTask } from "@worker/handlers/dispatch.js";

const JOB = {
  id: "job-1",
  data: {
    taskId: "task-1",
    taskType: "understand",
    userId: "user-1",
    projectId: "proj-1",
    spaceId: "space-1",
    params: {},
    model: "some-model",
    targetNodeIds: ["node-1"],
  },
} as unknown as Job;

describe("a job redelivered after the provider was already called", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetByIdInternal.mockResolvedValue({
      providerResultUrl: "https://provider.invalid/result.png",
      billedAt: null,
    });
  });

  it("stops without calling the provider again", async () => {
    const result = await runTask(JOB);

    expect(result).toEqual({
      failed: true,
      reason: "no_retry_after_provider",
    });
  });

  // A cause travels as a code and becomes a sentence where the reader is.
  // An operator's sentence stored here reaches every reader in one language
  // and tells them nothing they can act on — resending is what they do next,
  // which is exactly what `internal` says.
  it("leaves the node a cause this product knows, not an operator sentence", async () => {
    await runTask(JOB);

    expect(mockMarkFailed).toHaveBeenCalledWith("task-1", "internal");
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "internal" }),
    );
    expect(mockSettleTaskForNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ errorMessage: "internal" }),
    );
  });

  // Which part broke is the log's to carry, and it names the job so whoever
  // has to find that provider call by hand can.
  it("keeps what an operator needs in the log", async () => {
    await runTask(JOB);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        providerResultUrl: "https://provider.invalid/result.png",
      }),
      expect.stringContaining("redelivered"),
    );
  });
});
