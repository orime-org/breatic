// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The credits a finished run records and charges are rounded up to whole
 * cents once, before the task row, the node's history, the activity feed and
 * the charge read them (inner#1666), whichever lane priced the run: a model
 * generation, a reading or a container mini-tool. The rounding sits after the
 * vendor has returned, so a figure it cannot round passes through untouched
 * instead of throwing: the charge refuses a cost that is not a number, and a
 * negative one charges nothing.
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
  /** Stand-in for a container job the Durable Object ended as failed. */
  class ContainerJobFailed extends Error {}
  return {
    StillRunning,
    ContainerJobFailed,
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
    upsertGenerationSucceeded: vi.fn(),
    chargeForGeneration: vi.fn(),
    error: vi.fn(),
    readingCredits: { value: 0 },
    recordGenerationSuccess: vi.fn(async (_entry: unknown) => ({ id: "history-1" })),
  };
});

vi.mock("@worker/providers/still-running.js", () => ({
  StillRunning: h.StillRunning,
}));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.taskDeadline }));
vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobFailed: h.ContainerJobFailed,
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
    upsertGenerationSucceeded: h.upsertGenerationSucceeded,
  },
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(async () => ({ keyFromUrl: () => "video/out.mp4" })),
  getRawEnvVar: vi.fn(),
  getUnderstandConfig: vi.fn(() => ({})),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: h.info, warn: h.warn, error: h.error, debug: vi.fn() },
}));
vi.mock("@breatic/domain", async () => ({
  // The real judgement: the case below is about the ending it gives.
  failureOutcome: (await import("@domain/node-task/failure-outcome.js")).failureOutcome,
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
  creditLotService: { chargeForGeneration: h.chargeForGeneration },
  creditHoldService: { releaseHold: vi.fn(async () => undefined) },
  // A dollar is a credit here, so each case's cost is the figure to round.
  creditsForUsd: (usd: number) => usd,
  toChargeCredits: (await import("@domain/credit/credit-math.js")).toChargeCredits,
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationFailure: vi.fn(), recordGenerationSuccess: h.recordGenerationSuccess },
  settleTaskForNode: h.settleTaskForNode,
  understandMediaAt: h.understandMediaAt,
  readingLimitsUntil: (await import("@domain/understand/limits-until.js")).readingLimitsUntil,
  MediaUnavailable: class extends Error {},
  UnderstandRefused: class extends Error {},
  createUsageRecorder: () => ({ recordServiceCall: vi.fn(), settle: async () => h.readingCredits.value }),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));

import type { Job } from "bullmq";

import { toChargeMicro } from "@domain/credit/credit-math.js";
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

/** A lane that prices a run, and how to make its run cost a figure. */
type Lane = { name: string; job: () => Job; costs: (credits: number) => void };

const LANES: Lane[] = [
  {
    name: "a model generation",
    job: () => jobOf({}),
    costs: (credits) => h.runCatalogTask.mockResolvedValue({ outputs: [{ url: "https://cdn/out.png" }], cost: credits }),
  },
  {
    name: "a reading",
    job: () => jobOf({ taskType: "understand", model: undefined, params: { source_type: "image", source_url: "https://a/cat.png" } }),
    costs: (credits) => {
      h.understandMediaAt.mockResolvedValue({ text: "a cat", finishReason: "stop" });
      h.readingCredits.value = credits;
    },
  },
  {
    name: "a container mini-tool",
    job: () => jobOf({ taskType: "video", model: undefined, params: {}, source: "mini_tool", toolId: "video.cut", sourceKey: "v/src.mp4" }),
    costs: (credits) => h.runContainerJob.mockResolvedValue([{ outputs: [{ url: "https://cdn/out.mp4" }], cost: 0 }, credits]),
  },
];

/**
 * Run a lane's job that finishes having cost `credits`.
 * @param lane - The lane that prices the run.
 * @param credits - What the run reports it cost.
 * @returns The credits the task row was completed with, after checking the
 *   node's history and the activity feed recorded the same.
 */
async function billedFor(lane: Lane, credits: number): Promise<number> {
  lane.costs(credits);
  await runTask(lane.job(), "lock-token");
  const billed = h.markCompletedAndBill.mock.calls[0]![2] as number;
  const history = (h.recordGenerationSuccess.mock.calls[0]![0] as { metadata: { credits: number } }).metadata.credits;
  const activity = (h.upsertGenerationSucceeded.mock.calls[0]![0] as { payload: { credits: number } }).payload.credits;
  expect({ history, activity }).toEqual({ history: billed, activity: billed });
  return billed;
}

/**
 * What the charge was asked to take.
 * @returns The amount handed to the charge.
 */
function charged(): number {
  return (h.chargeForGeneration.mock.calls[0]![0] as { amount: number }).amount;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getByIdInternal.mockResolvedValue({ status: "running", startedAt: new Date(), billedAt: null, providerResultUrl: null, providerTaskId: null });
  h.markRunning.mockResolvedValue(new Date());
  h.taskDeadline.mockResolvedValue(DEADLINE);
  h.markCompletedAndBill.mockResolvedValue(true);
  // The real charge settles its amount before it writes anything.
  h.chargeForGeneration.mockImplementation(async (input: { amount: number }) => {
    toChargeMicro(input.amount);
    return { billed: true, charged: input.amount, shortfall: 0, studioId: "studio-1", lotIds: [] };
  });
});

describe.each(LANES)("the credits $name is billed with", (lane) => {
  it("rounds a part-cent cost up to the next cent, and charges that", async () => {
    expect(await billedFor(lane, 3.075)).toBe(3.08);
    expect(charged()).toBe(3.08);
  });

  it("does not round floating-point residue up a cent (inner#1637)", async () => {
    expect(await billedFor(lane, 7.000000000000001)).toBe(7);
    expect(charged()).toBe(7);
  });

  // The vendor has returned by now: a throw would rerun the task and pay it twice.
  it("passes a cost that is not a number through without throwing, and the charge refuses it", async () => {
    expect(await billedFor(lane, Number.NaN)).toBeNaN();
    await expect(h.chargeForGeneration.mock.results[0]!.value).rejects.toThrow(RangeError);
    expect(h.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("DEDUCT_FAILED_AFTER_COMPLETION"));
  });

  it("passes a negative cost through without throwing, and charges nothing", async () => {
    expect(await billedFor(lane, -1)).toBe(-1);
    expect(h.chargeForGeneration).not.toHaveBeenCalled();
  });
});
