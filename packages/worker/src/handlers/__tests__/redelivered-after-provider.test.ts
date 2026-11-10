// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the node says when a job comes back after the provider was called.
 *
 * The queue can hand the same job over twice — a worker that called the
 * provider and died before billing leaves a task with a result URL and no
 * charge. Policy is to stop there rather than call the provider again, and
 * the run has to end somewhere the user can see.
 *
 * Where it ends is a node's history row, which is read in whatever language
 * the user set. So what lands there is one of our causes, not the sentence
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
const mockReleaseHold = vi.hoisted(() => vi.fn(async () => undefined));
const mockError = vi.hoisted(() => vi.fn());
const mockPendingChargeRequestId = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<string | null> => null));
const mockSettleCharge = vi.hoisted(() => vi.fn(async (_requestId: string): Promise<unknown> => null));
const mockRecordSettleFailure = vi.hoisted(() => vi.fn(async (_requestId: string, _err: unknown): Promise<void> => undefined));

vi.mock("@breatic/core", () => ({
  // Product analytics (inner#1442) runs the job under its consent and reports
  // milestones; neither is what these cases are about.
  runWithConsent: (_consent: unknown, fn: () => unknown) => fn(),
  reportCollaboratorFirstAction: vi.fn(async () => undefined),
  serverAnalyticsWanted: vi.fn(() => false),
  trackServerEvent: vi.fn(),
  projectsRepo: { findOwnerStudioId: vi.fn(async () => undefined) },
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
  logger: { info: vi.fn(), warn: mockWarn, error: mockError, debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: {
    markFailed: mockMarkFailed,
    getByIdInternal: mockGetByIdInternal,
  },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: {},
  creditLotService: {
    pendingChargeRequestId: mockPendingChargeRequestId,
    settleCharge: mockSettleCharge,
    recordSettleFailure: mockRecordSettleFailure,
  },
  creditHoldService: { releaseHold: mockReleaseHold },
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationFailure: mockRecordFailure },
  settleTaskForNode: mockSettleTaskForNode,
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  NO_CONSENT: { analytics: false, ads: false },
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
  extractPromptText: vi.fn(),
}));

import type { Job } from "bullmq";
import type * as SharedModule from "@breatic/shared";

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

  // A cause travels as a code and becomes a sentence where the user is.
  // An operator's sentence stored here reaches every user in one language
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

describe("a job redelivered after it was charged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetByIdInternal.mockResolvedValue({ billedAt: new Date(), billedCredits: 5, result: null });
    mockPendingChargeRequestId.mockResolvedValue(null);
  });

  // With no request left pending the charge was settled (or there was none):
  // a hold still standing is this exit's to release, because the job
  // completes and no failure handler runs after it.
  it("releases the run's credit hold when no charge request is pending", async () => {
    await runTask(JOB);

    expect(mockPendingChargeRequestId).toHaveBeenCalledWith("task", "user-1", "task-1");
    expect(mockSettleCharge).not.toHaveBeenCalled();
    expect(mockReleaseHold).toHaveBeenCalledWith("task-1");
  });

  it("still returns the stored outcome when the release fails", async () => {
    mockReleaseHold.mockRejectedValueOnce(new Error("db down"));

    await expect(runTask(JOB)).resolves.toEqual({ alreadyCompleted: true });
  });
});

// inner#1617: a worker that died between completing the task and settling its
// charge left the request pending. The redelivery settles it, which charges
// once and releases the hold in the settle's own commit.
describe("a job redelivered with its charge still pending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetByIdInternal.mockResolvedValue({ billedAt: new Date(), billedCredits: 5, result: null });
    mockPendingChargeRequestId.mockResolvedValue("req-1");
    mockSettleCharge.mockResolvedValue({ billed: true, charged: "5.000000", shortfall: "0.000000", studioId: "s", lotIds: [] });
  });

  it("settles the pending request and leaves the hold to that settle", async () => {
    await expect(runTask(JOB)).resolves.toEqual({ alreadyCompleted: true });

    expect(mockPendingChargeRequestId).toHaveBeenCalledWith("task", "user-1", "task-1");
    expect(mockSettleCharge).toHaveBeenCalledExactlyOnceWith("req-1");
    expect(mockReleaseHold).not.toHaveBeenCalled();
    expect(mockRecordSettleFailure).not.toHaveBeenCalled();
  });

  it("keeps the hold, logs the failure, leaves the counting to the engine, and still returns the stored outcome when the settle fails", async () => {
    const down = new Error("db down");
    mockSettleCharge.mockRejectedValueOnce(down);

    await expect(runTask(JOB)).resolves.toEqual({ alreadyCompleted: true });

    expect(mockRecordSettleFailure).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      { taskId: "task-1", userId: "user-1", projectId: "proj-1", creditsUsed: 5, wasFirst: false, err: down, requestId: "req-1" },
      "credit_charge_settle_failed",
    );
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });
});
