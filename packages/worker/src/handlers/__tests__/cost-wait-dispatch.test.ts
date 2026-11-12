// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A generation that finishes before its upstream billed it (inner#1743): the result is delivered with the known
 * part of the cost marked as still billing, the credits stay held, and the task's own job comes back to look the
 * cost up and bill it once. Each pickup below is one cell of the settlement table: completed with a pending cost,
 * a lookup that finds nothing yet, a lookup that finds everything, the last lookup, a crash before delivery, and a
 * billed task delivered again.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { StoredAsset } from "@breatic/domain";

const h = vi.hoisted(() => ({
  runModelTask: vi.fn(),
  getByIdInternal: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markCompletedAndBill: vi.fn(),
  markBilledAndCharge: vi.fn(),
  markFailed: vi.fn(),
  recordProviderResult: vi.fn(),
  updateCostWait: vi.fn(),
  clearSending: vi.fn(),
  extendHold: vi.fn(),
  releaseHold: vi.fn(),
  pendingChargeRequestId: vi.fn(),
  settleCharge: vi.fn(),
  recordGenerationSuccess: vi.fn(async (_entry: unknown) => ({ id: "history-1" })),
  updateGenerationCredits: vi.fn(),
  upsertGenerationSucceeded: vi.fn(),
  settleTaskForNode: vi.fn(),
  lookup: vi.fn(),
  createUsageRecorder: vi.fn(),
  recordLookedUpCall: vi.fn(),
  moveToDelayed: vi.fn(),
  resolveRegisteredProjectMedia: vi.fn<(_projectId: string, url: string) => Promise<StoredAsset>>(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: async () => DEADLINE }));
vi.mock("@worker/handlers/model-task.js", () => ({ runModelTask: h.runModelTask, abandonedCosts: async () => [] }));
vi.mock("@worker/services/project-media.service.js", () => ({ resolveRegisteredProjectMedia: h.resolveRegisteredProjectMedia }));
vi.mock("@breatic/core", () => ({
  runWithConsent: (_consent: unknown, fn: () => unknown) => fn(),
  reportCollaboratorFirstAction: vi.fn(async () => undefined),
  serverAnalyticsWanted: vi.fn(() => false),
  trackServerEvent: vi.fn(),
  projectsRepo: { findOwnerStudioId: vi.fn(async () => undefined) },
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({ lock_duration_ms: 30_000 })),
  getAgentConfig: vi.fn(() => ({})),
  getNodeTaskConfig: () => ({ cost_wait_delay_ms: 1_000, cost_wait_attempts: 3 }),
  projectActivitiesRepo: { insertGenerationFailedIfAbsent: vi.fn(), upsertGenerationSucceeded: h.upsertGenerationSucceeded },
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(async () => ({ keyFromUrl: () => "image/out.png" })),
  getUnderstandConfig: vi.fn(() => ({})),
  env: { CREDIT_MULTIPLIER: 1 },
  NotFoundError: class extends Error {},
  logger: { info: h.info, warn: h.warn, error: h.error, debug: vi.fn() },
}));
vi.mock("@breatic/domain", async () => ({
  failureOutcome: (await import("@domain/node-task/failure-outcome.js")).failureOutcome,
  taskService: {
    getByIdInternal: h.getByIdInternal,
    markRunning: h.markRunning,
    markCompleted: h.markCompleted,
    markCompletedAndBill: h.markCompletedAndBill,
    markBilledAndCharge: h.markBilledAndCharge,
    markFailed: h.markFailed,
    recordProviderResult: h.recordProviderResult,
  },
  taskRepo: { updateCostWait: h.updateCostWait, clearSending: h.clearSending },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: { resolveOwnerStudioId: vi.fn(async () => "studio-1") },
  creditLotService: { settleCharge: h.settleCharge, pendingChargeRequestId: h.pendingChargeRequestId },
  creditHoldService: { extendHold: h.extendHold, releaseHold: h.releaseHold },
  creditsForUsd: (await import("@domain/credit/usage-cost.js")).creditsForUsd,
  toChargeCredits: (await import("@domain/credit/credit-math.js")).toChargeCredits,
  provider: () => ({ cost: { lookup: h.lookup } }),
  modelCatalog: { getModelCatalog: () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) },
  nodeHistoryService: {
    recordGenerationFailure: vi.fn(),
    recordGenerationSuccess: h.recordGenerationSuccess,
    updateGenerationCredits: h.updateGenerationCredits,
  },
  settleTaskForNode: h.settleTaskForNode,
  sceneTaskService: {},
  createUsageRecorder: h.createUsageRecorder,
  UNDERSTAND_PINS: {},
}));

import { DelayedError, type Job } from "bullmq";

import { runTask } from "@worker/handlers/dispatch.js";

const DEADLINE = 1_800_000_000_000;
const NOW = 1_700_000_000_000;
const URL = "https://cdn/out.png";
const LOOKUP = { upstream: "fal", predictionId: "p-1" };

/**
 * A canvas image generation as the queue hands it over.
 * @param attemptsMade - Attempts already spent.
 * @returns The job.
 */
function jobOf(attemptsMade = 0): Job {
  return {
    id: "job-1",
    attemptsMade,
    stalledCounter: 0,
    opts: { attempts: 3 },
    moveToDelayed: h.moveToDelayed,
    updateData: vi.fn(),
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
    },
  } as unknown as Job;
}

/**
 * The task row of a generation waiting on its cost.
 * @param wait - What differs in its wait.
 * @param pendingCosts - The costs it waits on.
 * @returns The row.
 */
function waitingRow(wait: Record<string, unknown> = {}, pendingCosts: unknown[] = [{ lookup: LOOKUP }]): Record<string, unknown> {
  return {
    status: "completed",
    billedAt: null,
    durationMs: 4_000,
    providerResultUrl: URL,
    result: {
      model: "nano-banana-2",
      outputs: [{ url: URL }],
      costWait: { credits: 12.5, attempts: 0, servedBy: "fal", windowEndsAt: NOW + 7_000, delivered: true, ...wait },
      pendingCosts,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  h.markRunning.mockResolvedValue(new Date(NOW - 4_000));
  h.markCompleted.mockResolvedValue(true);
  h.markBilledAndCharge.mockResolvedValue(true);
  h.markFailed.mockResolvedValue(true);
  h.releaseHold.mockResolvedValue(undefined);
  h.pendingChargeRequestId.mockResolvedValue("req-1");
  h.settleCharge.mockResolvedValue({ billed: true, charged: "18", shortfall: "0", studioId: "studio-1", lotIds: [] });
  h.upsertGenerationSucceeded.mockResolvedValue("activity-1");
  h.createUsageRecorder.mockReturnValue({ recordLookedUpCall: h.recordLookedUpCall, settle: async () => 0 });
  h.resolveRegisteredProjectMedia.mockImplementation(async (_projectId, fileUrl) => ({
    assetId: "asset-1", fileUrl, kind: "image", coverUrl: null, width: null, height: null, durationSeconds: null, mimeType: "image/png", sizeBytes: 10,
  }));
});

describe("a generation that finishes before its upstream billed it", () => {
  beforeEach(() => {
    h.getByIdInternal.mockResolvedValue({ status: "running", billedAt: null, providerResultUrl: null, result: null });
    h.runModelTask.mockResolvedValue({
      outputs: [{ kind: "url", url: URL }],
      costs: [{ state: "known", usd: 0.125, source: "reported" }, { state: "pending", lookup: LOOKUP }],
      servedBy: "fal",
    });
  });

  it("completes the task unbilled, the known part and the lookups written on its result", async () => {
    await expect(runTask(jobOf(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.markCompletedAndBill).not.toHaveBeenCalled();
    const [, result] = h.markCompleted.mock.calls[0]! as [string, Record<string, unknown>];
    expect(result).toMatchObject({
      outputs: [expect.objectContaining({ url: URL })],
      costWait: { credits: 12.5, attempts: 0, servedBy: "fal", windowEndsAt: NOW + 7_000 },
      pendingCosts: [{ lookup: LOOKUP }],
    });
    expect(h.settleCharge).not.toHaveBeenCalled();
  });

  it("keeps the credits held past the wait, and comes back for the first lookup", async () => {
    await expect(runTask(jobOf(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.extendHold).toHaveBeenCalledWith("task-1", new Date(NOW + 7_000 + 4_000));
    expect(h.releaseHold).not.toHaveBeenCalled();
    expect(h.moveToDelayed).toHaveBeenCalledWith(NOW + 1_000, "lock-token");
  });

  it("delivers the result with the known part marked as still billing", async () => {
    await expect(runTask(jobOf(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.recordGenerationSuccess).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ credits: 12.5, billing: "pending" }) }));
    expect(h.settleTaskForNode).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ outcome: "done" }));
    expect(h.upsertGenerationSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ credits: 12.5, billing: "pending" }) }),
      { whilePending: true },
    );
    // The wait now says the result was delivered, so a later pickup does not deliver it again.
    expect(h.updateCostWait).toHaveBeenCalledWith("task-1", expect.objectContaining({ costWait: expect.objectContaining({ delivered: true }) }));
  });
});

describe("a pickup of a task waiting on its cost", () => {
  it("comes back later when the lookup finds nothing yet, delivering and billing nothing", async () => {
    h.getByIdInternal.mockResolvedValue(waitingRow());
    h.lookup.mockResolvedValue({ state: "pending", lookup: LOOKUP });

    await expect(runTask(jobOf(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.lookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: false });
    expect(h.updateCostWait).toHaveBeenCalledWith("task-1", expect.objectContaining({ costWait: expect.objectContaining({ attempts: 1 }) }));
    expect(h.moveToDelayed).toHaveBeenCalledWith(NOW + 2_000, "lock-token");
    expect(h.extendHold).toHaveBeenCalledWith("task-1", new Date(NOW + 7_000 + 4_000));
    expect(h.runModelTask).not.toHaveBeenCalled();
    expect(h.markRunning).not.toHaveBeenCalled();
    expect(h.recordGenerationSuccess).not.toHaveBeenCalled();
    expect(h.markBilledAndCharge).not.toHaveBeenCalled();
  });

  it("bills what was known and what the lookup found, on the upstream that served it, and writes the final amount", async () => {
    h.getByIdInternal.mockResolvedValue(waitingRow());
    h.lookup.mockResolvedValue({ state: "known", usd: 0.055, source: "billing" });

    const result = await runTask(jobOf(), "lock-token");

    expect(h.markBilledAndCharge).toHaveBeenCalledExactlyOnceWith("task-1", 18, expect.objectContaining({
      actorUserId: "user-1",
      projectId: "proj-1",
      amount: 18,
      provider: "fal",
      model: "nano-banana-2",
      releaseHold: "task-1",
    }));
    expect(h.settleCharge).toHaveBeenCalledExactlyOnceWith("req-1");
    expect(h.updateGenerationCredits).toHaveBeenCalledWith("task-1", 18);
    expect(h.upsertGenerationSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.not.objectContaining({ billing: "pending" }) }),
      { whilePending: false },
    );
    expect((h.upsertGenerationSucceeded.mock.calls[0]![0] as { payload: { credits: number } }).payload.credits).toBe(18);
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ provider: "fal", credits: 18 }), "generation_usage");
    expect(h.moveToDelayed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pendingCosts: [{ lookup: LOOKUP, cost: { state: "known", usd: 0.055 } }] });
  });

  it("bills on what is known once the last lookup still finds nothing, saying so", async () => {
    h.getByIdInternal.mockResolvedValue(waitingRow({ attempts: 2 }));
    h.lookup.mockResolvedValue({ state: "missing", reason: "no billing record" });

    await runTask(jobOf(), "lock-token");

    expect(h.lookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: true });
    expect(h.markBilledAndCharge).toHaveBeenCalledWith("task-1", 12.5, expect.objectContaining({ amount: 12.5 }));
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", upstream: "fal" }), "cost_unavailable");
  });

  it("delivers first a result its run never delivered, still marked as billing", async () => {
    h.getByIdInternal.mockResolvedValue(waitingRow({ delivered: false }));
    h.lookup.mockResolvedValue({ state: "pending", lookup: LOOKUP });

    await expect(runTask(jobOf(), "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(h.recordGenerationSuccess).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ billing: "pending" }) }));
    expect(h.upsertGenerationSucceeded).toHaveBeenCalledWith(expect.anything(), { whilePending: true });
    expect(h.updateCostWait).toHaveBeenCalledWith("task-1", expect.objectContaining({ costWait: expect.objectContaining({ delivered: true, attempts: 1 }) }));
  });

  it("bills nothing when another pickup billed it first", async () => {
    h.getByIdInternal.mockResolvedValue(waitingRow());
    h.lookup.mockResolvedValue({ state: "known", usd: 0.055, source: "billing" });
    h.markBilledAndCharge.mockResolvedValue(false);
    h.pendingChargeRequestId.mockResolvedValue(null);

    await runTask(jobOf(), "lock-token");

    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.releaseHold).toHaveBeenCalledWith("task-1");
    expect(h.info).not.toHaveBeenCalledWith(expect.anything(), "generation_usage");
  });
});

describe("a reading billed after waiting on its cost", () => {
  it("writes its call's usage row with what the lookup found, once, by the pickup that billed it", async () => {
    const found = { state: "known", usd: 0.01, source: "billing" };
    const recordAs = { feature: "canvas_understand", model: "google/gemini-3.8-flash" };
    h.getByIdInternal.mockResolvedValue(waitingRow({}, [{ lookup: { upstream: "openrouter", generationId: "gen-1" }, recordAs }]));
    h.lookup.mockResolvedValue(found);

    await runTask(jobOf(), "lock-token");

    expect(h.createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: "task:task-1", feature: "canvas_understand", actorUserId: "user-1" }));
    expect(h.recordLookedUpCall).toHaveBeenCalledExactlyOnceWith({ source: "model", model: "google/gemini-3.8-flash", upstream: "openrouter", cost: found });
  });

  it("writes no usage row when another pickup billed it", async () => {
    h.getByIdInternal.mockResolvedValue(waitingRow({}, [{ lookup: { upstream: "openrouter", generationId: "gen-1" }, recordAs: { feature: "canvas_understand", model: "m" } }]));
    h.lookup.mockResolvedValue({ state: "known", usd: 0.01, source: "billing" });
    h.markBilledAndCharge.mockResolvedValue(false);

    await runTask(jobOf(), "lock-token");

    expect(h.recordLookedUpCall).not.toHaveBeenCalled();
  });
});

describe("a task billed after waiting on its cost, delivered again", () => {
  it("writes the billed amount on the rows written while it waited", async () => {
    const row = waitingRow();
    h.getByIdInternal.mockResolvedValue({ ...row, billedAt: new Date(NOW), billedCredits: 18 });

    await runTask(jobOf(), "lock-token");

    expect(h.updateGenerationCredits).toHaveBeenCalledWith("task-1", 18);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.markBilledAndCharge).not.toHaveBeenCalled();
  });
});
