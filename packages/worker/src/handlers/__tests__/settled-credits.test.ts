// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The credits a finished run records and charges are rounded up to whole
 * cents once, before the task row, the node's history, the activity feed and
 * the charge read them (inner#1666), whichever lane priced the run: a model
 * generation, a reading or a container mini-tool. The charge is the request
 * `markCompletedAndBill` writes in the completion's own commit (inner#1617),
 * then settled. The rounding sits after the vendor has returned, so a figure
 * it cannot round passes through untouched instead of throwing: a cost that
 * is not a number, or a negative one, writes no request and charges nothing.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { StoredAsset } from "@breatic/domain";

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
    runModelTask: vi.fn(),
    taskDeadline: vi.fn(),
    markFailed: vi.fn(),
    moveToDelayed: vi.fn(),
    getByIdInternal: vi.fn(),
    recordProviderResult: vi.fn(),
    resolveRegisteredProjectMedia: vi.fn<(_projectId: string, url: string) => Promise<StoredAsset>>(),
    markCompletedAndBill: vi.fn(),
    markRunning: vi.fn(),
    settleTaskForNode: vi.fn(),
    updateData: vi.fn(),
    info: vi.fn(),
    slotFull: { value: false },
    understandMediaAt: vi.fn(),
    upsertGenerationSucceeded: vi.fn(),
    settleCharge: vi.fn(),
    pendingChargeRequestId: vi.fn(),
    /** The request the stand-in completion wrote, or null when it wrote none. */
    request: { id: null as string | null },
    error: vi.fn(),
    readingCredits: { value: 0 },
    readingLookups: { value: [] as { upstream: string }[] },
    markCompleted: vi.fn(async () => true),
    extendHold: vi.fn(),
    updateCostWait: vi.fn(),
    recordGenerationSuccess: vi.fn(async (_entry: unknown) => ({ id: "history-1" })),
  };
});

vi.mock("@worker/handlers/still-running.js", () => ({
  StillRunning: h.StillRunning,
}));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.taskDeadline }));
vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobFailed: h.ContainerJobFailed,
  runContainerJob: h.runContainerJob,
}));
vi.mock("@worker/handlers/model-task.js", () => ({ runModelTask: h.runModelTask, abandonedCosts: async () => [] }));
vi.mock("@worker/services/project-media.service.js", () => ({
  resolveRegisteredProjectMedia: h.resolveRegisteredProjectMedia,
}));
vi.mock("@worker/handlers/understand-slots.js", () => ({
  withUnderstandSlot: async <T>(read: () => Promise<T>): Promise<T> => {
    if (h.slotFull.value) throw new h.StillRunning(DEADLINE - 60_000);
    return read();
  },
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
  getNodeTaskConfig: () => ({ cost_wait_delay_ms: 1_000, cost_wait_attempts: 3 }),
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
    recordProviderResult: h.recordProviderResult,
    markCompletedAndBill: h.markCompletedAndBill,
    markCompleted: h.markCompleted,
  },
  taskRepo: { clearSending: vi.fn(), updateCostWait: h.updateCostWait },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: { resolveOwnerStudioId: vi.fn(async () => "studio-1") },
  creditLotService: {
    settleCharge: h.settleCharge,
    pendingChargeRequestId: h.pendingChargeRequestId,
  },
  creditHoldService: { releaseHold: vi.fn(async () => undefined), extendHold: h.extendHold },
  // A dollar is a credit here, so each case's cost is the figure to round.
  creditsForUsd: (usd: number) => usd,
  toChargeCredits: (await import("@domain/credit/credit-math.js")).toChargeCredits,
  // No model declares an output type here, so the result keeps the stored one.
  modelCatalog: { getModelCatalog: () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) },
  nodeHistoryService: { recordGenerationFailure: vi.fn(), recordGenerationSuccess: h.recordGenerationSuccess },
  settleTaskForNode: h.settleTaskForNode,
  understandMediaAt: h.understandMediaAt,
  readingLimitsUntil: (await import("@domain/understand/limits-until.js")).readingLimitsUntil,
  MediaUnavailable: class extends Error {},
  UnderstandRefused: class extends Error {},
  createUsageRecorder: () => ({ recordServiceCall: vi.fn(), awaitingLookup: () => h.readingLookups.value, settle: async () => h.readingCredits.value }),
  UNDERSTAND_PINS: { model: "google/gemini-3.8-flash" },
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
    costs: (credits) =>
      h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: "https://cdn/out.png" }], costs: [{ state: "known", usd: credits, source: "billing" }], servedBy: "fal" }),
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

/** What the completion was asked to record as the charge. */
type ChargeArg = { amount: number; actorUserId: string; projectId: string | null; releaseHold?: string } | null;

/**
 * What the completion was asked to charge.
 * @returns The charge handed to `markCompletedAndBill`.
 */
function chargeArg(): ChargeArg {
  return h.markCompletedAndBill.mock.calls[0]![4] as ChargeArg;
}

/**
 * What the charge was asked to take.
 * @returns The amount handed to the completion's charge request.
 */
function charged(): number {
  return chargeArg()!.amount;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readingLookups.value = [];
  h.markFailed.mockResolvedValue(true);
  h.getByIdInternal.mockResolvedValue({ status: "running", startedAt: new Date(), billedAt: null, providerResultUrl: null, providerTaskId: null });
  h.markRunning.mockResolvedValue(new Date());
  h.taskDeadline.mockResolvedValue(DEADLINE);
  // The real completion writes a request only when it won the CAS and the
  // charge has an amount above zero; NaN and negatives are neither.
  h.request.id = null;
  h.markCompletedAndBill.mockImplementation(async (_taskId: string, _result: unknown, _credits: number, _ms: number, charge: ChargeArg) => {
    if (charge !== null && charge.amount > 0) h.request.id = "req-1";
    return true;
  });
  h.pendingChargeRequestId.mockImplementation(async () => h.request.id);
  h.recordProviderResult.mockReset();
  h.resolveRegisteredProjectMedia.mockReset();
  h.resolveRegisteredProjectMedia.mockImplementation(async (_projectId, fileUrl) => ({
    assetId: fileUrl.endsWith(".mp4") ? "asset-video" : "asset-image",
    fileUrl,
    kind: fileUrl.endsWith(".mp4") ? "video" : "image",
    coverUrl: null,
    width: null,
    height: null,
    durationSeconds: null,
    mimeType: fileUrl.endsWith(".mp4") ? "video/mp4" : "image/png",
    sizeBytes: 10,
  }));
  h.settleCharge.mockImplementation(async () => {
    // The real settle charges the request's stored amount.
    const amount = charged();
    toChargeMicro(amount);
    return { billed: true, charged: String(amount), shortfall: "0.000000", studioId: "studio-1", lotIds: [] };
  });
});

describe.each(LANES)("the credits $name is billed with", (lane) => {
  it("rounds a part-cent cost up to the next cent, and charges that", async () => {
    expect(await billedFor(lane, 3.075)).toBe(3.08);
    expect(charged()).toBe(3.08);
    expect(h.settleCharge).toHaveBeenCalledExactlyOnceWith("req-1");
  });

  it("does not round floating-point residue up a cent (inner#1637)", async () => {
    expect(await billedFor(lane, 7.000000000000001)).toBe(7);
    expect(charged()).toBe(7);
  });

  it("asks the completion to charge the run's actor and project and to release the run's hold", async () => {
    await billedFor(lane, 3.075);
    expect(chargeArg()).toEqual(expect.objectContaining({ actorUserId: "user-1", projectId: "proj-1", releaseHold: "task-1" }));
  });

  // The vendor has returned by now: a throw would rerun the task and pay it twice.
  it("passes a cost that is not a number through without throwing, and charges nothing", async () => {
    expect(await billedFor(lane, Number.NaN)).toBeNaN();
    expect(h.settleCharge).not.toHaveBeenCalled();
  });

  it("passes a negative cost through without throwing, and charges nothing", async () => {
    expect(await billedFor(lane, -1)).toBe(-1);
    expect(h.settleCharge).not.toHaveBeenCalled();
  });
});

describe("who a charge names", () => {
  it("names the upstream that served a model generation, and every cost it reported, known parts added", async () => {
    h.runModelTask.mockResolvedValue({
      outputs: [{ kind: "url", url: "https://cdn/out.png" }],
      costs: [{ state: "known", usd: 1, source: "billing" }, { state: "known", usd: 0.5, source: "reported" }, { state: "missing", reason: "no billing" }],
      servedBy: "sandbase",
    });

    await runTask(jobOf({}), "lock-token");

    expect(chargeArg()).toEqual(expect.objectContaining({ provider: "sandbase", amount: 1.5, model: "nano-banana-2" }));
    expect(h.warn).toHaveBeenCalledWith({ taskId: "task-1", reason: "no billing" }, "cost_unavailable");
  });

  it("names no upstream for a reading, which records each call's upstream itself", async () => {
    LANES[1]!.costs(2);
    await runTask(LANES[1]!.job(), "lock-token");
    expect(chargeArg()).toEqual(expect.objectContaining({ provider: "unknown" }));
  });
});

describe("a reading whose call's cost is still pending (inner#1743)", () => {
  it("is delivered and waits on the cost, its lookup kept with how its usage row is written", async () => {
    LANES[1]!.costs(2);
    h.readingLookups.value = [{ upstream: "openrouter", generationId: "gen-1" } as { upstream: string }];

    await expect(runTask(LANES[1]!.job(), "lock-token")).rejects.toThrow();

    expect(h.markCompletedAndBill).not.toHaveBeenCalled();
    expect((h.markCompleted.mock.calls[0] as unknown[])[1]).toMatchObject({
      costWait: { credits: 2 },
      pendingCosts: [{ lookup: { upstream: "openrouter", generationId: "gen-1" }, recordAs: { feature: "canvas_understand", model: "google/gemini-3.8-flash" } }],
    });
    expect(h.moveToDelayed).toHaveBeenCalled();
  });
});

describe("accepting registered media after the vendor has returned", () => {
  it("fails without billing or vendor replay when accepting the Project relationship fails", async () => {
    const fileUrl = "https://cdn/out.png";
    const providerFactsAtAcceptance: Array<string | null> = [];
    const row = {
      status: "running",
      startedAt: new Date(),
      billedAt: null,
      providerResultUrl: null as string | null,
      providerTaskId: null,
    };
    h.getByIdInternal.mockResolvedValue(row);
    h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: fileUrl }], costs: [{ state: "known", usd: 3.075, source: "billing" }], servedBy: "fal" });
    h.recordProviderResult.mockImplementation(async (_taskId: string, url: string) => {
      // The later boundary may run only after the provider fact's write resolves.
      await Promise.resolve();
      row.providerResultUrl = url;
    });
    h.resolveRegisteredProjectMedia.mockImplementation(async () => {
      providerFactsAtAcceptance.push(row.providerResultUrl);
      throw new Error("Project asset association SQL failed");
    });

    await expect(runTask(jobOf({}), "lock-token")).resolves.toEqual({ failed: true, reason: "persist_failed" });

    expect(h.recordProviderResult).toHaveBeenCalledExactlyOnceWith("task-1", fileUrl);
    expect(h.resolveRegisteredProjectMedia).toHaveBeenCalledExactlyOnceWith("proj-1", fileUrl);
    expect(providerFactsAtAcceptance).toEqual([fileUrl]);
    expect(h.markFailed).toHaveBeenCalledExactlyOnceWith("task-1", "internal");
    expect(h.runModelTask).toHaveBeenCalledTimes(1);
    expect(h.markCompletedAndBill).not.toHaveBeenCalled();
    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.recordGenerationSuccess).not.toHaveBeenCalled();
    expect(h.upsertGenerationSucceeded).not.toHaveBeenCalled();
    expect(row.providerResultUrl).toBe(fileUrl);

    // This is another real dispatcher call reading the same written fact.
    await expect(runTask(jobOf({}, 1), "lock-token")).resolves.toEqual({ failed: true, reason: "no_retry_after_provider" });

    expect(h.getByIdInternal).toHaveBeenCalledTimes(2);
    expect(h.getByIdInternal).toHaveBeenNthCalledWith(1, "task-1");
    expect(h.getByIdInternal).toHaveBeenNthCalledWith(2, "task-1");
    expect(h.runModelTask).toHaveBeenCalledTimes(1);
    expect(h.recordProviderResult).toHaveBeenCalledTimes(1);
    expect(h.resolveRegisteredProjectMedia).toHaveBeenCalledTimes(1);
    expect(h.markFailed).toHaveBeenCalledTimes(2);
    expect(h.markFailed).toHaveBeenNthCalledWith(2, "task-1", "internal");
    expect(h.markCompletedAndBill).not.toHaveBeenCalled();
    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.moveToDelayed).not.toHaveBeenCalled();
  });
});
