// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a finished run does with its credits (inner#1611, inner#1617).
 *
 * The run was admitted by holding its estimate under the task id. The attempt
 * that marked the task completed also wrote a pending charge request in that
 * same commit; this step settles that request, which charges what the run
 * actually cost and releases the hold in the settle's own commit. A run with
 * no request (it cost nothing, or another attempt completed the task) only
 * releases the hold. A settle that fails leaves the request pending for the
 * sweep (the credit engine counts the failure on the row), keeps the hold,
 * and never throws: the result is already delivered. Every log line carries
 * the run's context and the request id.
 */

import type * as SharedModule from "@breatic/shared";

import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pendingChargeRequestId: vi.fn(),
  settleCharge: vi.fn(),
  recordSettleFailure: vi.fn(),
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
  creditLotService: {
    pendingChargeRequestId: h.pendingChargeRequestId,
    settleCharge: h.settleCharge,
    recordSettleFailure: h.recordSettleFailure,
  },
  creditHoldService: { releaseHold: h.releaseHold },
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: {},
  settleTaskForNode: vi.fn(),
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...await importOriginal<typeof SharedModule>(),
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

const REQUEST = "req-1";

/** What every log line for a first, paid run carries. */
const CONTEXT = { taskId: "task-1", userId: "user-1", projectId: "proj-1", creditsUsed: 7, wasFirst: true, requestId: REQUEST };

beforeEach(() => {
  vi.clearAllMocks();
  h.pendingChargeRequestId.mockResolvedValue(REQUEST);
  h.settleCharge.mockResolvedValue({ billed: true, charged: "7.000000", shortfall: "0.000000", studioId: "s", lotIds: [] });
  h.releaseHold.mockResolvedValue(undefined);
});

describe("settleRunCharge", () => {
  it("settles the task's pending request, which releases the hold in its own commit", async () => {
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.pendingChargeRequestId).toHaveBeenCalledWith("task", "user-1", "task-1");
    expect(h.settleCharge).toHaveBeenCalledExactlyOnceWith(REQUEST);
    expect(h.releaseHold).not.toHaveBeenCalled();
    expect(h.recordSettleFailure).not.toHaveBeenCalled();
  });

  it("releases the hold of a run that cost nothing", async () => {
    h.pendingChargeRequestId.mockResolvedValue(null);
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 0 });
    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.releaseHold).toHaveBeenCalledExactlyOnceWith("task-1");
  });

  it("releases the hold when another attempt already completed the task", async () => {
    h.pendingChargeRequestId.mockResolvedValue(null);
    await settleRunCharge({ ...RUN, wasFirst: false, creditsUsed: 7 });
    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.releaseHold).toHaveBeenCalledExactlyOnceWith("task-1");
  });

  it("logs a charge that could not be covered", async () => {
    h.settleCharge.mockResolvedValue({ billed: true, charged: "2.000000", shortfall: "5.000000", studioId: "s", lotIds: [] });
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledExactlyOnceWith(
      { ...CONTEXT, studioId: "s", charged: "2.000000", shortfall: "5.000000" },
      "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
    );
  });

  it("logs a charge whose readers could not be told", async () => {
    const redis = new Error("redis down");
    h.settleCharge.mockResolvedValue({ billed: true, charged: "7.000000", shortfall: "0.000000", studioId: "s", lotIds: [], signalFailure: redis });
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ ...CONTEXT, err: redis }, "credits_signal_failed");
    expect(h.recordSettleFailure).not.toHaveBeenCalled();
  });

  it("does nothing more when the request was already settled by the sweep", async () => {
    h.settleCharge.mockResolvedValue(null);
    await expect(settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 })).resolves.toBeUndefined();
    expect(h.error).not.toHaveBeenCalled();
    expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("logs a settle that failed with the run and the request, leaves the counting to the engine, keeps the hold and does not throw", async () => {
    const down = new Error("db down");
    h.settleCharge.mockRejectedValue(down);
    await expect(settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 })).resolves.toBeUndefined();
    expect(h.recordSettleFailure).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ ...CONTEXT, err: down }, "credit_charge_settle_failed");
    expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("does not throw when the settle and its failure record both failed", async () => {
    const both = new AggregateError([new Error("db down"), new Error("still down")], "charge settlement and its failure record both failed");
    h.settleCharge.mockRejectedValue(both);
    await expect(settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 })).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ ...CONTEXT, err: both }, "credit_charge_settle_failed");
    expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("does not throw when looking the request up fails, and keeps the hold for the sweep's settle or its expiry", async () => {
    h.pendingChargeRequestId.mockRejectedValue(new Error("db down"));
    await expect(settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 })).resolves.toBeUndefined();
    expect(h.settleCharge).not.toHaveBeenCalled();
    expect(h.releaseHold).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }), expect.any(String));
  });

  it("logs a release that failed without throwing", async () => {
    h.pendingChargeRequestId.mockResolvedValue(null);
    h.releaseHold.mockRejectedValue(new Error("db down"));
    await expect(settleRunCharge({ ...RUN, wasFirst: false, creditsUsed: 0 })).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }), "credit_hold_release_failed");
  });
});

describe("decimal charge outcomes", () => {
  it("M20 keeps a zero decimal shortfall silent", async () => {
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledTimes(0);
    expect(h.settleCharge).toHaveBeenCalledTimes(1);
    expect(h.releaseHold).toHaveBeenCalledTimes(0);
  });

  it("M20 logs an exact one-micro-credit shortfall", async () => {
    h.settleCharge.mockResolvedValue({ billed: true, charged: "6.999999", shortfall: "0.000001", studioId: "s", lotIds: [] });
    await settleRunCharge({ ...RUN, wasFirst: true, creditsUsed: 7 });
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith(
      { ...CONTEXT, studioId: "s", charged: "6.999999", shortfall: "0.000001" },
      "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
    );
    expect(h.releaseHold).toHaveBeenCalledTimes(0);
  });
});
