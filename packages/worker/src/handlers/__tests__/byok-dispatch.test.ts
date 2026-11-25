// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A canvas task on an account's own keys, end to end through the dispatcher (inner#1953). The task row holds the ids
 * of the key rows it was submitted on (`keyId` for the media, `llmKeyId` for a language-model step or a reading);
 * every pickup hands those ids on, never a key. What an account's key paid for is recorded as usage with 0 credits
 * under the canvas generation feature and is not charged; what our keys paid for in the same run is. A failure of an
 * account's key settles the task at once with the key's own code: no retry, no move to our key.
 *
 * No real Redis / DB: everything is mocked, as in `settled-credits.test.ts`.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { StoredAsset } from "@breatic/domain";
import { readTaskFailure } from "@breatic/shared";

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
    readingLookups: { value: [] as { lookup: { upstream: string }; source: string; model: string }[] },
    markCompleted: vi.fn(async () => true),
    extendHold: vi.fn(),
    updateCostWait: vi.fn(),
    recordGenerationSuccess: vi.fn(async (_entry: unknown) => ({ id: "history-1" })),
    keysById: vi.fn(),
    keyOwnerOf: vi.fn(async (id: string | null) => (id === null ? undefined : "payer-account")),
    recordModelCall: vi.fn(),
    createUsageRecorder: vi.fn(),
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
  createUsageRecorder: h.createUsageRecorder,
  keysById: h.keysById,
  keyOwnerOf: h.keyOwnerOf,
  handOffLookups: vi.fn(async () => undefined),
  UNDERSTAND_PINS: { model: "google/gemini-3.8-flash" },
  extractPromptText: vi.fn(),
}));

import type { Job } from "bullmq";

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


const MEDIA_KEY_ID = "55555555-5555-4555-8555-555555555555";
const LLM_KEY_ID = "66666666-6666-4666-8666-666666666666";
const LLM_KEYS = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "sk-or-acct" : undefined) };

/** What the completion was asked to charge, or null. */
const chargeArg = (): { amount: number } | null => h.markCompletedAndBill.mock.calls[0]![4] as { amount: number } | null;

beforeEach(() => {
  vi.clearAllMocks();
  h.readingLookups.value = [];
  h.markFailed.mockResolvedValue(true);
  h.getByIdInternal.mockResolvedValue({ status: "running", startedAt: new Date(), billedAt: null, providerResultUrl: null, providerTaskId: null, keyId: MEDIA_KEY_ID, llmKeyId: LLM_KEY_ID });
  h.markRunning.mockResolvedValue(new Date());
  h.taskDeadline.mockResolvedValue(DEADLINE);
  h.request.id = null;
  h.markCompletedAndBill.mockImplementation(async (_taskId: string, _result: unknown, _credits: number, _ms: number, charge: { amount: number } | null) => {
    if (charge !== null && charge.amount > 0) h.request.id = "req-1";
    return true;
  });
  h.pendingChargeRequestId.mockImplementation(async () => h.request.id);
  h.resolveRegisteredProjectMedia.mockImplementation(async (_projectId, fileUrl) => ({
    assetId: "asset-image", fileUrl, kind: "image", coverUrl: null, width: null, height: null, durationSeconds: null, mimeType: "image/png", sizeBytes: 10,
  }));
  h.settleCharge.mockResolvedValue({ billed: true, charged: "0", shortfall: "0.000000", studioId: "studio-1", lotIds: [] });
  h.keysById.mockImplementation(async (id: string | null) => (id === LLM_KEY_ID ? { keys: LLM_KEYS } : id === null ? null : { keys: { owner: "account", keyOf: () => "acct-fal" } }));
  h.createUsageRecorder.mockImplementation((options: Record<string, unknown>) => ({
    operation: { operationKey: options.operationKey, feature: options.feature, actorUserId: options.actorUserId, projectId: options.projectId },
    recordServiceCall: vi.fn(),
    recordModelCall: h.recordModelCall,
    recordLookedUpCall: vi.fn(),
    awaitingLookup: () => h.readingLookups.value,
    settle: async () => h.readingCredits.value,
    settleForCharge: async () => ({ credits: h.readingCredits.value, writeFailures: [] }),
  }));
});

const ACCOUNT_COST = { state: "known", usd: 3, source: "billing", payer: "account" };
const OUR_COST = { state: "known", usd: 0.5, source: "reported", payer: "deployment" };

describe("a model generation on an account's key", () => {
  it("hands the run the key row ids the task holds, and no key", async () => {
    h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: "https://cdn/out.png" }], costs: [ACCOUNT_COST], servedBy: "fal", passedOverCosts: [] });
    await runTask(jobOf({}), "lock-token");

    expect(h.runModelTask).toHaveBeenCalledWith(expect.objectContaining({ keyId: MEDIA_KEY_ID, llmKeyId: LLM_KEY_ID }));
  });

  it("charges nothing for what the account's key paid, and records it as usage with 0 credits", async () => {
    h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: "https://cdn/out.png" }], costs: [ACCOUNT_COST], servedBy: "fal", passedOverCosts: [] });
    await runTask(jobOf({}), "lock-token");

    expect(h.markCompletedAndBill.mock.calls[0]![2]).toBe(0);
    expect(chargeArg()?.amount ?? 0).toBe(0);
    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: "task:task-1", feature: "canvas_generation", keyId: MEDIA_KEY_ID }));
    expect(h.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ upstream: "fal", cost: ACCOUNT_COST }));
  });

  it("charges only what our key paid in the same run", async () => {
    h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: "https://cdn/out.png" }], costs: [ACCOUNT_COST, OUR_COST], servedBy: "wavespeed", passedOverCosts: [] });
    await runTask(jobOf({}), "lock-token");

    expect(chargeArg()?.amount).toBe(0.5);
  });

  it("records each account-paid cost under its own key row: an OpenRouter description under the LLM row, the media under the media row", async () => {
    const rows: Record<string, unknown[]> = {};
    h.createUsageRecorder.mockImplementation((options: Record<string, unknown>) => ({
      operation: { operationKey: options.operationKey, feature: options.feature, actorUserId: options.actorUserId, projectId: options.projectId },
      recordServiceCall: vi.fn(),
      recordModelCall: (call: unknown) => void (rows[String(options.keyId)] ??= []).push(call),
      recordLookedUpCall: vi.fn(),
      awaitingLookup: () => [],
      settle: async () => 0,
      settleForCharge: async () => ({ credits: 0, writeFailures: [] }),
    }));
    const DESCRIPTION = { state: "known", usd: 0.01, source: "reported", payer: "account", upstream: "openrouter" };
    h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: "https://cdn/out.png" }], costs: [ACCOUNT_COST, DESCRIPTION], servedBy: "fal", passedOverCosts: [] });

    await runTask(jobOf({}), "lock-token");

    expect(rows[MEDIA_KEY_ID]).toEqual([expect.objectContaining({ upstream: "fal", cost: ACCOUNT_COST })]);
    expect(rows[LLM_KEY_ID]).toEqual([expect.objectContaining({ upstream: "openrouter", cost: DESCRIPTION })]);
  });

  it.each([
    ["account_key_failed", { reason: "no_balance", upstream: "fal" }],
    ["account_key_missing", {}],
  ])("settles a %s at once on a first attempt, with the key's own code, and runs no retry", async (kind, extra) => {
    h.runModelTask.mockRejectedValue(new Error("the run failed", { cause: Object.assign(new Error(kind), { kind, ...extra }) }));

    await expect(runTask(jobOf({}, 0), "lock-token")).resolves.toMatchObject({ failed: true });

    expect(h.runModelTask).toHaveBeenCalledTimes(1);
    expect(h.moveToDelayed).not.toHaveBeenCalled();
    const stored = h.markFailed.mock.calls.at(-1)![1] as string;
    expect(stored).toContain(kind);
    expect(readTaskFailure(stored).keyOwner).toBe("payer-account");
    expect(h.markCompletedAndBill).not.toHaveBeenCalled();
  });
});

describe("a reading on an account's OpenRouter key", () => {
  it("reads with the keys of the task's LLM key row and records its usage under that row", async () => {
    h.understandMediaAt.mockResolvedValue({ text: "a cat", finishReason: "stop" });
    await runTask(jobOf({ taskType: "understand", model: undefined, params: { source_type: "image", source_url: "https://a/cat.png" } }), "lock-token");

    expect(h.keysById).toHaveBeenCalledWith(LLM_KEY_ID);
    expect(h.understandMediaAt).toHaveBeenCalledWith(expect.objectContaining({ keys: LLM_KEYS }));
    expect(h.createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ feature: "canvas_understand", keyId: LLM_KEY_ID }));
  });
});
