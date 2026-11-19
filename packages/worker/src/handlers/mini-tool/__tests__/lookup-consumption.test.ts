// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import type { MiniToolConsumptionRecord } from "@breatic/domain";
import type { MiniToolPlanJobRequest } from "@breatic/shared";

const { send, read, submit, costLookup, warn } = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn(), submit: vi.fn(), costLookup: vi.fn(), warn: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({
  ...await original<typeof sharedModule>(), httpRequest: send, readMiniToolPlanJob: read, submitMiniToolPlanJob: submit,
}));
vi.mock("@breatic/domain", async (original) => ({
  ...await original<typeof domainModule>(), provider: () => ({ cost: { lookup: costLookup } }),
}));
vi.mock("@breatic/core", async (original) => ({
  ...await original<typeof coreModule>(), logger: { ...(await original<typeof coreModule>()).logger, warn },
  env: { INGEST_BASE_URL: "https://ingest.test.invalid", INGEST_SHARED_SECRET: "test-secret" },
  // Only the poll interval is read live: it bounds the container's reporting window; prices are frozen with the consumption.
  getMiniToolsConfig: () => ({ poll_interval_ms: 5000,
    get prices(): never { throw new Error("Lookup must use frozen prices"); }, get classes(): never { throw new Error("Lookup must use frozen prices"); } }),
}));

import { containerCostUsd } from "@breatic/domain";
import { lookupMiniToolConsumption } from "../lookup-consumption.js";

const bound = { signal: new AbortController().signal, timeoutMs: 1234 };
const inputId = "20000000-0000-4000-8000-000000000001";
// §93 D5 (frames-split design §7.17 frame row 「不得把presentation ordinal当原解码n」, 「唯一写点：worker的配方构造」): a job frame recipe names a full-ledger entry and its PNG target, not a frameIndex.
const plan: MiniToolPlanJobRequest = {
  schemaVersion: 2, jobId: "task:T/chunk:1", containerClass: "MediaContainer", deadlineAt: 1792920000000,
  limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
  inputs: [{ inputId, storageKey: "source/video.mp4" }],
  outputs: [{ outputIndex: 8, storageKey: "result/frame-8.png", contentType: "image/png", recipe: { kind: "frame", inputId, entry: { kind: "source", decodeStart: { numerator: "42", denominator: "25" }, clipStart: { numerator: "42", denominator: "25" }, displayStart: { numerator: "42", denominator: "25" }, displayEnd: { numerator: "43", denominator: "25" }, rate: { numerator: "1", denominator: "1" } }, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }],
};
const LOOKUP_A = { upstream: "wavespeed", predictionId: "p-a" };
const LOOKUP_B = { upstream: "wavespeed", predictionId: "p-b" };
const provider: MiniToolConsumptionRecord = {
  schemaVersion: 1, consumptionKey: "1".repeat(64), identity: { kind: "provider", stepId: "30000000-0000-4000-8000-000000000001" },
  state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null, containerPricing: null,
  servedBy: "wavespeed", costs: [], waiting: [{ lookup: LOOKUP_A }, { lookup: LOOKUP_B }], known: 0, attempts: 1, windowEndsAt: 1792920000000, nextLookupAt: 1792910000000,
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
  // inner#1306 execution design §11.4: a model step's waiting costs are asked of provider, each once, in order.
  it("asks provider about each waiting cost once and answers them in order", async () => {
    costLookup.mockResolvedValueOnce({ state: "known", usd: 0.2, source: "billing" }).mockResolvedValueOnce({ state: "pending", lookup: LOOKUP_B });
    expect(await lookupMiniToolConsumption({ consumption: provider, lastAttempt: false }, bound)).toEqual({ state: "looked_up",
      costs: [{ state: "known", usd: 0.2, source: "billing" }, { state: "pending", lookup: LOOKUP_B }] });
    expect(costLookup.mock.calls).toEqual([[LOOKUP_A, { lastAttempt: false }], [LOOKUP_B, { lastAttempt: false }]]);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks with lastAttempt on the last lookup and logs a cost no upstream can name", async () => {
    costLookup.mockResolvedValue({ state: "missing", reason: "never billed" });
    await lookupMiniToolConsumption({ consumption: provider, lastAttempt: true }, bound);
    expect(costLookup).toHaveBeenCalledWith(LOOKUP_A, { lastAttempt: true });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "cost_unavailable");
  });

  it("does not ask again about a waiting cost an earlier lookup answered", async () => {
    costLookup.mockResolvedValue({ state: "known", usd: 0.1, source: "billing" });
    const answered = { ...provider, waiting: [{ lookup: LOOKUP_A, cost: { state: "known" as const, usd: 0.3, source: "billing" as const } }, { lookup: LOOKUP_B }] };
    expect(await lookupMiniToolConsumption({ consumption: answered }, bound)).toEqual({ state: "looked_up",
      costs: [{ state: "known", usd: 0.3, source: "billing" }, { state: "known", usd: 0.1, source: "billing" }] });
    expect(costLookup).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed lookup for the settlement's retry", async () => {
    const error = new Error("network down");
    costLookup.mockRejectedValue(error);
    await expect(lookupMiniToolConsumption({ consumption: provider }, bound)).rejects.toBe(error);
  });

  it.each(["known", "recorded"] as const)("does not query an already %s fact", async (state) => {
    const consumption = { ...container, state, costUsd: 0.25, costSource: "computed" as const, raw: { original: true }, credits: state === "recorded" ? 50 : null };
    expect(await lookupMiniToolConsumption({ consumption, plan }, bound)).toEqual({ state: "known", costUsd: 0.25, costSource: "computed", raw: { original: true } });
    expect(send).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(costLookup).not.toHaveBeenCalled();
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
    const policy = container.containerPricing!;
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
    await expect(lookupMiniToolConsumption({ consumption: container, plan: request }, bound)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });

});
