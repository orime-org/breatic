// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type { MiniToolConsumptionRecord } from "@breatic/domain";
import type { MiniToolPlanJobRequest } from "@breatic/shared";

const { send, read, submit } = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn(), submit: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({
  ...await original<typeof sharedModule>(), httpRequest: send, readMiniToolPlanJob: read, submitMiniToolPlanJob: submit,
}));
vi.mock("@breatic/core", async (original) => ({
  ...await original<typeof coreModule>(),
  env: { INGEST_BASE_URL: "https://ingest.test.invalid", INGEST_SHARED_SECRET: "test-secret" },
  // Only the poll interval is read live: it bounds the container's reporting window; prices are frozen with the consumption.
  getMiniToolsConfig: () => ({ poll_interval_ms: 5000,
    get prices(): never { throw new Error("Lookup must use frozen prices"); }, get classes(): never { throw new Error("Lookup must use frozen prices"); } }),
}));

import { containerCostUsd } from "@breatic/domain";
import { lookupMiniToolConsumption } from "../lookup-consumption.js";

const bound = { signal: new AbortController().signal, timeoutMs: 1234 };
const inputId = "20000000-0000-4000-8000-000000000001";
// §93 D5 (frames-split design §7.17 frame row 「不得把presentation ordinal当原解码n」, 「唯一写点：worker的配方构造」): a job frame recipe names a grid frame of its tool source and its PNG target (§7.16).
const plan: MiniToolPlanJobRequest = {
  schemaVersion: 2, jobId: "task:T/chunk:1", containerClass: "MediaContainer", deadlineAt: 1792920000000,
  limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
  inputs: [{ inputId, storageKey: "source/video.mp4" }],
  outputs: [{ outputIndex: 8, storageKey: "result/frame-8.png", contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false } }, frameIndex: 42, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }],
};
const container: MiniToolConsumptionRecord = {
  schemaVersion: 1, consumptionKey: "1".repeat(64), identity: { kind: "container", containerClass: plan.containerClass, jobId: plan.jobId, chunkIndex: 1 },
  state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null,
  containerPricing: { configVersion: "first-policy", size: { vcpu: 8, memory_gib: 2, disk_gb: 4 },
    prices: { vcpu_second_usd: 0.001, memory_gib_second_usd: 0.002, disk_gb_second_usd: 0.003 } },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("original mini-tool expense lookup", () => {
  it.each(["known", "recorded"] as const)("does not query an already %s fact", async (state) => {
    const consumption = { ...container, state, costUsd: 0.25, costSource: "computed" as const, raw: { original: true }, credits: state === "recorded" ? 50 : null };
    expect(await lookupMiniToolConsumption({ consumption, plan }, bound)).toEqual({ state: "known", costUsd: 0.25, costSource: "computed", raw: { original: true } });
    expect(send).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it.each([null, { schemaVersion: 2, state: "starting" }, { schemaVersion: 2, state: "running" },
  ])("keeps an unfinished original container report pending: %j", async (report) => {
    // The last instant of the job's reporting window (its deadline plus two poll intervals).
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(plan.deadlineAt + 2 * 5000 - 1);
    try {
      read.mockResolvedValue(report);
      expect(await lookupMiniToolConsumption({ consumption: container, plan }, bound)).toMatchObject({ state: "pending", reason: expect.any(String) });
      expect(read).toHaveBeenCalledExactlyOnceWith("https://ingest.test.invalid", "test-secret", plan, bound);
      expect(send).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("settles a job ingest never received at zero once its reporting window has closed: the attempt never ran", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(plan.deadlineAt + 2 * 5000);
    try {
      read.mockResolvedValue(null);
      expect(await lookupMiniToolConsumption({ consumption: container, plan }, bound)).toEqual({ state: "known", costUsd: 0, costSource: "computed", raw: null });
      expect(submit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([{ schemaVersion: 2, state: "starting" }, { schemaVersion: 2, state: "running" }])("keeps a report still %j after the reporting window pending", async (report) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(plan.deadlineAt + 2 * 5000);
    try {
      read.mockResolvedValue(report);
      expect(await lookupMiniToolConsumption({ consumption: container, plan }, bound)).toMatchObject({ state: "pending" });
    } finally { vi.useRealTimers(); }
  });

  it("settles an ended attempt whose usage is unknown at zero: its container never started or vanished unmeasured", async () => {
    const report = { schemaVersion: 2, state: "failed", outputs: [], reason: "internal", usage: null };
    read.mockResolvedValue(report);
    expect(await lookupMiniToolConsumption({ consumption: container, plan }, bound)).toEqual({ state: "known", costUsd: 0, costSource: "computed", raw: report });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["done", "failed"])("charges an ended %s attempt without CPU time at its provisioned vCPU over its wall time", async (state) => {
    const usage = { wallMs: 1000, cpuUsec: null };
    read.mockResolvedValue({ schemaVersion: 2, state, outputs: [], ...(state === "failed" ? { reason: "internal" } : {}), usage });
    const policy = container.containerPricing;
    expect(await lookupMiniToolConsumption({ consumption: container, plan }, bound)).toMatchObject({
      state: "known", costUsd: containerCostUsd(usage, policy.size, policy.prices), costSource: "computed",
    });
  });

  it.each(["done", "failed"])("uses frozen pricing for measured %s usage after the old task deadline", async (state) => {
    read.mockResolvedValue({ schemaVersion: 2, state, outputs: [], ...(state === "failed" ? { reason: "internal" } : {}), usage: { wallMs: 2000, cpuUsec: 500000 } });
    expect(await lookupMiniToolConsumption({ consumption: container, plan }, bound)).toMatchObject({ state: "known", costUsd: 0.0325, costSource: "computed" });
    expect(read).toHaveBeenCalledExactlyOnceWith("https://ingest.test.invalid", "test-secret", plan, bound);
    expect(submit).not.toHaveBeenCalled(); expect(plan.deadlineAt).toBe(1792920000000);
  });

  it.each([undefined, { ...plan, jobId: "another-job" }, { ...plan, containerClass: "AnotherContainer" }])("rejects missing or mismatched container authority before IO", async (request) => {
    await expect(lookupMiniToolConsumption({ consumption: container, plan: request as MiniToolPlanJobRequest }, bound)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });

});
