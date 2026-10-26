// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a finished run does with its credits (inner#1611).
 *
 * The run was admitted by holding its estimate under the task id. The run
 * that marked the task completed charges what it actually cost and releases
 * that hold in the same commit; any other ending of this step releases the
 * hold on its own, so the credits are not held for a run that is over.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  chargeForGeneration: vi.fn(),
  releaseHold: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({})),
  getAgentConfig: vi.fn(() => ({})),
  projectActivitiesRepo: {},
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(),
  getRawEnvVar: vi.fn(),
  getUnderstandConfig: vi.fn(() => ({})),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: h.error, debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: {},
  upstreamStepRepo: {},
  assetService: {},
  creditLotService: { chargeForGeneration: h.chargeForGeneration },
  creditHoldService: { releaseHold: h.releaseHold },
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: {},
  settleTaskForNode: vi.fn(),
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
  extractPromptText: vi.fn(),
}));

import { settleRunCharge } from "@worker/handlers/dispatch.js";

const RUN = {
  taskId: "task-1",
  taskType: "image",
  userId: "user-1",
  projectId: "proj-1",
  model: "m",
  provider: "p",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.chargeForGeneration.mockResolvedValue({ billed: true, charged: 7, shortfall: 0, studioId: "s", lotIds: [] });
  h.releaseHold.mockResolvedValue(undefined);
});

describe("settleRunCharge", () => {
  it("charges the actual cost and releases the run's hold in the same charge", async () => {
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.chargeForGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7, referenceId: "task-1", releaseHold: "task-1", projectId: "proj-1" }),
    );
    expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("releases the hold of a run that cost nothing", async () => {
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 0 });
    expect(h.chargeForGeneration).not.toHaveBeenCalled();
    expect(h.releaseHold).toHaveBeenCalledWith("task-1");
  });

  it("releases the hold when another attempt already completed the task", async () => {
    await settleRunCharge({ ...RUN, wasFirst: false, creditsUsed: 7 });
    expect(h.chargeForGeneration).not.toHaveBeenCalled();
    expect(h.releaseHold).toHaveBeenCalledWith("task-1");
  });

  it("logs a charge that could not be covered", async () => {
    h.chargeForGeneration.mockResolvedValue({ billed: true, charged: 2, shortfall: 5, studioId: "s", lotIds: [] });
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", shortfall: 5 }),
      expect.stringContaining("CREDIT_SHORTFALL_AFTER_COMPLETION"),
    );
  });

  it("logs a charge whose readers could not be told", async () => {
    h.chargeForGeneration.mockResolvedValue({ billed: true, charged: 7, shortfall: 0, studioId: "s", lotIds: [], signalFailure: new Error("redis down") });
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", projectId: "proj-1" }),
      "credits_signal_failed",
    );
  });

  it("logs a charge that failed and leaves the hold to its expiry", async () => {
    h.chargeForGeneration.mockRejectedValue(new Error("db down"));
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
      expect.stringContaining("DEDUCT_FAILED_AFTER_COMPLETION"),
    );
    expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("logs a release that failed without throwing", async () => {
    h.releaseHold.mockRejectedValue(new Error("db down"));
    await expect(settleRunCharge({ ...RUN, wasFirst: false, creditsUsed: 0 })).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }), "credit_hold_release_failed");
  });
});
