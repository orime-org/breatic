// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Both worker readings of media take a place before they read (inner#1337
 * §3.3): a canvas reading, and the description a video element is created
 * with. When no place is free, neither reaches the media.
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
vi.mock("@breatic/domain", () => ({
  assetRepo: {},
  upstreamCloneRepo: {},
  upstreamStepRepo: {},
  taskService: {},
  creditLotService: {},
  creditsForUsd: vi.fn(),
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: {},
  settleTaskForNode: vi.fn(),
  understandMediaAt: h.understandMediaAt,
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));

const { stepDepsFor } = await import("@worker/handlers/step-deps.js");
const { runUnderstand } = await import("@worker/handlers/dispatch.js");

const usage = { recordServiceCall: vi.fn(), settle: vi.fn(async () => 0) };

beforeEach(() => {
  h.understandMediaAt.mockReset();
  h.understandMediaAt.mockResolvedValue({ text: "a cat", finishReason: "stop" });
  h.full.value = false;
});

describe("a worker reading of media", () => {
  it("describes an element image inside a place", async () => {
    await expect(stepDepsFor(null).describeImage("https://a/cat.png")).resolves.toMatchObject({ text: "a cat" });
  });

  it("does not describe an element image when no place is free", async () => {
    h.full.value = true;

    await expect(stepDepsFor(null).describeImage("https://a/cat.png")).rejects.toBeInstanceOf(h.StillRunning);
    expect(h.understandMediaAt).not.toHaveBeenCalled();
  });

  it("does not read a canvas node's media when no place is free", async () => {
    h.full.value = true;

    await expect(
      runUnderstand({ source_type: "image", source_url: "https://a/cat.png" }, usage as never),
    ).rejects.toBeInstanceOf(h.StillRunning);
    expect(h.understandMediaAt).not.toHaveBeenCalled();
  });
});
