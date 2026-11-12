// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A canvas reading of media takes a place before it reads (inner#1337 §3.3):
 * when no place is free, it does not reach the media. The description a video
 * element is created with takes one too, through the model run's reading place
 * (`model-task.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  /** Stand-in for the real class. */
  class StillRunning extends Error {
    constructor(readonly resumeAt: number) {
      super("still running");
    }
  }
  return { StillRunning, understandMediaAt: vi.fn(), full: { value: false } };
});

vi.mock("@worker/handlers/understand-slots.js", () => ({
  withUnderstandSlot: async <T>(read: () => Promise<T>): Promise<T> => {
    if (h.full.value) throw new h.StillRunning(1);
    return read();
  },
}));
vi.mock("@breatic/core", () => ({
  getRawEnvVar: vi.fn(),
  getStorageAdapter: vi.fn(),
  getUnderstandConfig: () => ({}),
  getStreamRedis: vi.fn(),
  getWorkerConfig: vi.fn(() => ({})),
  projectActivitiesRepo: {},
  publishActivityNew: vi.fn(),
  env: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", async () => ({
  assetRepo: {},
  upstreamCloneRepo: {},
  upstreamStepRepo: {},
  taskService: {},
  creditLotService: {},
  creditsForUsd: vi.fn(),
  nodeHistoryService: {},
  settleTaskForNode: vi.fn(),
  understandMediaAt: h.understandMediaAt,
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
  readingLimitsUntil: (await import("@domain/understand/limits-until.js")).readingLimitsUntil,
}));

const { runUnderstand } = await import("@worker/handlers/dispatch.js");

const usage = { recordServiceCall: vi.fn(), settle: vi.fn(async () => 0), awaitingLookup: () => [] };

beforeEach(() => {
  h.understandMediaAt.mockReset();
  h.understandMediaAt.mockResolvedValue({ text: "a cat", finishReason: "stop" });
  h.full.value = false;
});

describe("a worker reading of media", () => {
  it("does not read a canvas node's media when no place is free", async () => {
    h.full.value = true;

    await expect(
      runUnderstand({ source_type: "image", source_url: "https://a/cat.png" }, usage as never, Date.now() + 3_600_000),
    ).rejects.toBeInstanceOf(h.StillRunning);
    expect(h.understandMediaAt).not.toHaveBeenCalled();
  });
});
