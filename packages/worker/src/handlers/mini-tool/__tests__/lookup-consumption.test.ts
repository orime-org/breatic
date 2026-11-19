// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import type { MiniToolConsumptionRecord } from "@breatic/domain";
import type { MiniToolPlanJobRequest } from "@breatic/shared";

const { send, read, submit, config } = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn(), submit: vi.fn(), config: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({
  ...await original<typeof sharedModule>(), httpRequest: send, readMiniToolPlanJob: read, submitMiniToolPlanJob: submit,
}));
vi.mock("@breatic/domain", async (original) => ({
  ...await original<typeof domainModule>(), getFullModelConfig: config,
}));
vi.mock("@breatic/core", async (original) => ({
  ...await original<typeof coreModule>(), getRawEnvVar: (name: string) => name === "WAVESPEED_API_KEY" ? "test-key" : undefined,
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
const provider: MiniToolConsumptionRecord = {
  schemaVersion: 1, consumptionKey: "1".repeat(64), identity: { kind: "provider", provider: "wavespeed", predictionId: "original-prediction" },
  state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null, containerPricing: null,
};
const container: MiniToolConsumptionRecord = {
  ...provider, identity: { kind: "container", containerClass: plan.containerClass, jobId: plan.jobId, chunkIndex: 1 },
  containerPricing: { configVersion: "first-policy", size: { vcpu: 8, memory_gib: 2, disk_gb: 4 },
    prices: { vcpu_second_usd: 0.001, memory_gib_second_usd: 0.002, disk_gb_second_usd: 0.003 } },
};

/**
 * Construct the previously observed WaveSpeed billing shape without an implementation oracle.
 * @param items - Independently priced deduction/refund lines.
 * @param hasMore - Whether this answer is incomplete.
 * @returns The read-only HTTP answer.
 */
function bill(items: unknown[], hasMore = false): Response {
  return Response.json({ code: 200, data: { page: 1, has_more: hasMore, items } });
}

beforeEach(() => {
  vi.clearAllMocks();
  config.mockReturnValue({ models: [], providers: { wavespeed: { base_url: "https://wavespeed.test.invalid/v3", api_key_env: "WAVESPEED_API_KEY" } } });
});

describe("original mini-tool expense lookup", () => {
  it.each([0, 0.0026])("retains an explicit deduction price %s", async (price) => {
    send.mockResolvedValue(bill([{ billing_type: "deduct", order: { price } }]));
    const answer = await lookupMiniToolConsumption({ consumption: provider }, bound);
    expect(answer).toMatchObject({ state: "known", costUsd: price, costSource: "generation_lookup" });
    expect(send).toHaveBeenCalledExactlyOnceWith("https://wavespeed.test.invalid/v3/billings/search", {
      method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ prediction_uuids: ["original-prediction"] }),
    }, { replaySafe: true, ...bound });
    expect(submit).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it("retains a complete refund as confirmed zero", async () => {
    send.mockResolvedValue(bill([{ billing_type: "deduct", order: { price: 0.0026 } }, { billing_type: "refund", order: { price: 0.0026 } }]));
    expect(await lookupMiniToolConsumption({ consumption: provider }, bound)).toMatchObject({ state: "known", costUsd: 0, costSource: "generation_lookup" });
  });

  it.each([
    { name: "empty", response: () => bill([]) },
    { name: "missing price", response: () => bill([{ billing_type: "deduct", order: {} }]) },
    { name: "missing refund price", response: () => bill([{ billing_type: "deduct", order: { price: 1 } }, { billing_type: "refund", order: {} }]) },
    { name: "invalid price", response: () => bill([{ billing_type: "deduct", order: { price: "1" } }]) },
    { name: "negative price", response: () => bill([{ billing_type: "deduct", order: { price: -1 } }]) },
    { name: "refund only", response: () => bill([{ billing_type: "refund", order: { price: 1 } }]) },
    { name: "negative total", response: () => bill([{ billing_type: "deduct", order: { price: 1 } }, { billing_type: "refund", order: { price: 2 } }]) },
    { name: "additional pages", response: () => bill([{ billing_type: "deduct", order: { price: 1 } }], true) },
    { name: "untyped answer", response: () => Response.json({ data: { items: [] } }) },
  ])("keeps $name unresolved instead of confirming a free call", async ({ response }) => {
    send.mockResolvedValue(response());
    expect(await lookupMiniToolConsumption({ consumption: provider }, bound)).toMatchObject({ state: "pending", reason: expect.any(String) });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])("keeps HTTP%s as a lookup failure without a confirmed amount", async (status) => {
    send.mockResolvedValue(new Response("refused", { status }));
    await expect(lookupMiniToolConsumption({ consumption: provider }, bound)).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it("retains network and cancellation failures for the application retry path", async () => {
    const error = new Error("read interrupted"); send.mockRejectedValue(error);
    await expect(lookupMiniToolConsumption({ consumption: provider }, bound)).rejects.toBe(error);
  });

  it.each(["known", "recorded"] as const)("does not query an already %s fact", async (state) => {
    const consumption = { ...provider, state, costUsd: 0.25, costSource: "generation_lookup" as const, raw: { original: true }, credits: state === "recorded" ? 50 : null };
    expect(await lookupMiniToolConsumption({ consumption }, bound)).toEqual({ state: "known", costUsd: 0.25, costSource: "generation_lookup", raw: { original: true } });
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

  it("retains generated complete billing sums and zero refunds without calling a model", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100000 }), async (deduction, extra) => {
      send.mockResolvedValue(bill([{ billing_type: "deduct", order: { price: (deduction + extra) / 1000000 } }, { billing_type: "refund", order: { price: deduction / 1000000 } }]));
      const answer = await lookupMiniToolConsumption({ consumption: provider }, bound);
      expect(answer.state).toBe("known");
      if (answer.state === "known") expect(answer.costUsd).toBeCloseTo(extra / 1000000, 12);
      expect(submit).not.toHaveBeenCalled();
    }), { numRuns: 40 });
  });
});
