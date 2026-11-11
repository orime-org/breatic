// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from "vitest";

import { createUsageRecorder, type UsageRow } from "@domain/credit/usage-recorder.js";

const PRICING = {
  models: {
    "deepseek/deepseek-v4-pro": {
      input_cache_hit_per_mtok: 0.044,
      input_cache_miss_per_mtok: 1.32,
      output_per_mtok: 3.96,
    },
  },
  services: {
    brave_web_search: { per_request: 0.005 },
    brave_image_search: { per_request: 0.005 },
  },
};

const TOKENS = { input: 1_000_000, cachedInput: 0, output: 0, reasoning: 0 };

/**
 * A recorder whose writes land in an array.
 * @param write - Overrides the default in-memory writer.
 * @returns The recorder and the rows it wrote.
 */
function recorderWithRows(write?: (row: UsageRow) => Promise<void>) {
  const rows: UsageRow[] = [];
  const missing: UsageRow[] = [];
  const recorder = createUsageRecorder({
    operationKey: "turn:c1:3",
    feature: "chat_turn",
    actorUserId: "u1",
    projectId: "p1",
    pricing: PRICING,
    multiplier: 2,
    write: write ?? (async (row) => void rows.push(row)),
    onMissingCost: (row) => void missing.push(row),
  });
  return { recorder, rows, missing };
}

describe("the usage recorder", () => {
  it("writes one row per model call, with the tokens, dollars and credits of its cost", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4-pro",
      upstream: "deepseek",
      cost: { state: "known", usd: 1.32, source: "price_table", tokens: TOKENS },
    });
    await recorder.settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operationKey: "turn:c1:3",
      feature: "chat_turn",
      source: "model",
      actorUserId: "u1",
      projectId: "p1",
      model: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requestCount: null,
      costSource: "price_table",
    });
    expect(rows[0]!.costUsd).toBeCloseTo(1.32, 10);
    expect(rows[0]!.credits).toBeCloseTo(264, 10);
  });

  it("says which operation it records", () => {
    const { recorder } = recorderWithRows();
    expect(recorder.operation).toEqual({
      operationKey: "turn:c1:3",
      feature: "chat_turn",
      actorUserId: "u1",
      projectId: "p1",
    });
  });

  it("prices a Brave search per request", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordServiceCall({
      source: "tool:web_search",
      service: "brave_web_search",
      provider: "brave",
      requests: 1,
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({
      source: "tool:web_search",
      model: "brave_web_search",
      provider: "brave",
      requestCount: 1,
      costSource: "price_table",
      inputTokens: null,
    });
    expect(rows[0]!.costUsd).toBeCloseTo(0.005, 10);
  });

  it("takes the dollars an upstream reported, as the provider's, counting the requests the caller names", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordModelCall({
      source: "tool:judge_likelihood",
      model: "typesafe/jev-1.13",
      upstream: "openrouter",
      requests: 1,
      cost: { state: "known", usd: 0.0004, source: "reported" },
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "provider", provider: "openrouter", requestCount: 1, inputTokens: null });
    expect(rows[0]!.costUsd).toBe(0.0004);
  });

  it("records a missing cost at zero with the tokens it knows, and says so", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "google/gemini-2.5-flash",
      upstream: "openrouter",
      cost: { state: "missing", reason: "openrouter reported no cost and no generation id", tokens: TOKENS },
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "missing", costUsd: 0, credits: 0, inputTokens: 1_000_000 });
    expect(missing).toEqual([rows[0]]);
    expect(recorder.awaitingLookup()).toEqual([]);
  });

  it("keeps a pending cost for the lookup, and writes no row", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    const lookup = { upstream: "openrouter", generationId: "gen-1" };
    recorder.recordModelCall({ source: "model", model: "google/gemini-2.5-flash", upstream: "openrouter", cost: { state: "pending", lookup } });
    expect(await recorder.settle()).toBe(0);
    expect(rows).toEqual([]);
    expect(missing).toEqual([]);
    expect(recorder.awaitingLookup()).toEqual([lookup]);
  });

  it("keeps one lookup per generation, however often it is recorded", () => {
    const { recorder } = recorderWithRows();
    for (let i = 0; i < 2; i++) recorder.recordModelCall({ source: "model", model: "m", upstream: "openrouter", cost: { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1" } } });
    expect(recorder.awaitingLookup()).toHaveLength(1);
  });

  it("does not call a priced row missing", async () => {
    const { recorder, missing } = recorderWithRows();
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    await recorder.settle();
    expect(missing).toEqual([]);
  });

  it("records a looked-up call at the cost its upstream's billing answered, with its tokens", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordLookedUpCall({
      source: "model",
      model: "google/gemini-2.5-flash",
      upstream: "openrouter",
      cost: { state: "known", usd: 0.01, source: "billing", tokens: { input: 100, cachedInput: 40, output: 20, reasoning: 5 } },
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({
      source: "model",
      provider: "openrouter",
      requestCount: 1,
      costUsd: 0.01,
      costSource: "generation_lookup",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
    });
    expect(rows[0]!.credits).toBeCloseTo(2, 10);
    expect(missing).toEqual([]);
  });

  it("records a lookup that never found the cost as missing", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordLookedUpCall({ source: "model", model: "google/gemini-2.5-flash", upstream: "openrouter", cost: { state: "missing", reason: "not found" } });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "missing", costUsd: 0, credits: 0, inputTokens: null });
    expect(missing).toEqual([rows[0]]);
  });

  it("settles to the credits of its own rows, after every write has landed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const landed: UsageRow[] = [];
    const { recorder } = recorderWithRows(async (row) => {
      await gate;
      landed.push(row);
    });
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    recorder.recordServiceCall({ source: "tool:search_images", service: "brave_image_search", provider: "brave", requests: 2 });
    const settled = recorder.settle();
    release();
    await expect(settled).resolves.toBeCloseTo((0.005 + 0.01) * 100 * 2, 10);
    expect(landed).toHaveLength(2);
  });

  it("settles to the next whole cent while each row keeps its exact credits (inner#1666)", async () => {
    const { recorder, rows } = recorderWithRows();
    // 0.00041 dollars at a multiplier of 2 is 0.082 credits.
    recorder.recordServiceCall({ source: "tool:judge_likelihood", service: "x/a", provider: "openrouter", requests: 1, costUsd: 0.00041 });
    expect(await recorder.settle()).toBe(0.09);
    expect(rows[0]!.credits).toBeCloseTo(0.082, 10);
  });

  it("does not round floating-point residue in the total up a cent", async () => {
    const { recorder } = recorderWithRows();
    // Three calls of 0.0005 dollars at a multiplier of 2 sum to 0.30000000000000004.
    for (let i = 0; i < 3; i++) {
      recorder.recordServiceCall({ source: "tool:judge_likelihood", service: "x/a", provider: "openrouter", requests: 1, costUsd: 0.0005 });
    }
    expect(await recorder.settle()).toBe(0.3);
  });

  it("holds a write that failed before settle, and fails settle with it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { recorder } = recorderWithRows(async () => {
        throw new Error("db down");
      });
      recorder.recordServiceCall({
        source: "tool:web_search",
        service: "brave_web_search",
        provider: "brave",
        requests: 1,
      });
      // Let the rejection surface before anyone awaits it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      await expect(recorder.settle()).rejects.toThrow("db down");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails to settle when a write failed", async () => {
    const { recorder } = recorderWithRows(async () => {
      throw new Error("db down");
    });
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    await expect(recorder.settle()).rejects.toThrow("db down");
  });
});

describe("settleForCharge", () => {
  it("answers the same credits settle does when every write lands", async () => {
    const first = recorderWithRows();
    const second = recorderWithRows();
    for (const { recorder } of [first, second]) {
      recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
      recorder.recordServiceCall({ source: "tool:judge_likelihood", service: "x/a", provider: "openrouter", requests: 1, costUsd: 0.00041 });
    }
    const settled = await first.recorder.settle();
    expect(await second.recorder.settleForCharge()).toEqual({ credits: settled, writeFailures: [] });
    expect(settled).toBe(1.09);
  });

  it("still answers what to charge when a row could not be written, and hands back the failure", async () => {
    // The credits are counted before the row is written, so a lost row does
    // not lose the charge; the caller logs the row and charges anyway.
    const boom = new Error("db down");
    let calls = 0;
    const { recorder, rows } = recorderWithRows(async (row) => {
      calls += 1;
      if (calls === 1) throw boom;
      rows.push(row);
    });
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    recorder.recordServiceCall({ source: "tool:search_images", service: "brave_image_search", provider: "brave", requests: 2 });
    const outcome = await recorder.settleForCharge();
    expect(outcome.credits).toBe(3);
    expect(outcome.writeFailures).toEqual([boom]);
    expect(rows).toHaveLength(1);
  });

  it("waits for every write before answering", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const landed: UsageRow[] = [];
    const { recorder } = recorderWithRows(async (row) => {
      await gate;
      landed.push(row);
    });
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    recorder.recordServiceCall({ source: "tool:search_images", service: "brave_image_search", provider: "brave", requests: 2 });
    let answered = false;
    const settled = recorder.settleForCharge().then((outcome) => {
      answered = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toBe(false);
    release();
    expect(await settled).toEqual({ credits: 3, writeFailures: [] });
    expect(landed).toHaveLength(2);
  });

  it("leaves settle throwing on the same failure", async () => {
    const { recorder } = recorderWithRows(async () => {
      throw new Error("db down");
    });
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    await expect(recorder.settleForCharge()).resolves.toMatchObject({ credits: 1 });
    await expect(recorder.settle()).rejects.toThrow("db down");
  });
});
