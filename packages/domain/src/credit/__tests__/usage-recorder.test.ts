// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

const USAGE = {
  inputTokens: 1_000_000,
  inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0 },
  outputTokens: 0,
  outputTokenDetails: { reasoningTokens: 0 },
};

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
  it("writes one row per model call, with its tokens, dollars and credits", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      usage: USAGE,
      providerMetadata: undefined,
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

  it("takes the dollars a service reported", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordServiceCall({
      source: "tool:judge_likelihood",
      service: "typesafe/jev-1.13",
      provider: "openrouter",
      requests: 1,
      costUsd: 0.0004,
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "provider", provider: "openrouter" });
    expect(rows[0]!.costUsd).toBe(0.0004);
  });

  it("records an OpenRouter service call with no reported cost as missing, and says so", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordServiceCall({
      source: "tool:understand_media",
      service: "google/gemini-3.8-flash",
      provider: "openrouter",
      requests: 1,
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "missing", costUsd: 0, credits: 0 });
    expect(missing).toEqual([rows[0]]);
  });

  it("says so when an OpenRouter model call reported no cost", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "google/gemini-2.5-flash",
      provider: "openrouter",
      usage: USAGE,
      providerMetadata: undefined,
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "missing" });
    expect(missing).toEqual([rows[0]]);
  });

  it("keeps an OpenRouter model call with no cost for the lookup, and writes no row", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "google/gemini-2.5-flash",
      provider: "openrouter",
      usage: USAGE,
      providerMetadata: undefined,
      generationId: "gen-1",
    });
    expect(await recorder.settle()).toBe(0);
    expect(rows).toEqual([]);
    expect(missing).toEqual([]);
    expect(recorder.awaitingLookup()).toEqual(["gen-1"]);
  });

  it("records an OpenRouter model call that reported its cost, and keeps nothing for the lookup", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "google/gemini-2.5-flash",
      provider: "openrouter",
      usage: USAGE,
      providerMetadata: { openrouter: { usage: { cost: 0.01 } } },
      generationId: "gen-1",
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "provider" });
    expect(recorder.awaitingLookup()).toEqual([]);
  });

  it("records a direct model call by the table whatever id it carries", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      usage: USAGE,
      providerMetadata: undefined,
      generationId: "gen-1",
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "price_table" });
    expect(recorder.awaitingLookup()).toEqual([]);
  });

  it("does not call a priced row missing", async () => {
    const { recorder, missing } = recorderWithRows();
    recorder.recordServiceCall({ source: "tool:web_search", service: "brave_web_search", provider: "brave", requests: 1 });
    await recorder.settle();
    expect(missing).toEqual([]);
  });

  it("records a looked-up generation at the cost OpenRouter answered", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordLookedUpCall({ source: "model", model: "google/gemini-2.5-flash", costUsd: 0.01 });
    await recorder.settle();
    expect(rows[0]).toMatchObject({
      source: "model",
      provider: "openrouter",
      requestCount: 1,
      costUsd: 0.01,
      costSource: "generation_lookup",
      inputTokens: null,
    });
    expect(rows[0]!.credits).toBeCloseTo(2, 10);
    expect(missing).toEqual([]);
  });

  it("records the token buckets OpenRouter answered with the generation", async () => {
    const { recorder, rows } = recorderWithRows();
    recorder.recordLookedUpCall({
      source: "model",
      model: "google/gemini-2.5-flash",
      costUsd: 0.01,
      tokens: { input: 100, cachedInput: 40, output: 20, reasoning: 5 },
    });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 });
  });

  it("records a lookup that never found the generation as missing", async () => {
    const { recorder, rows, missing } = recorderWithRows();
    recorder.recordLookedUpCall({ source: "model", model: "google/gemini-2.5-flash", costUsd: undefined });
    await recorder.settle();
    expect(rows[0]).toMatchObject({ costSource: "missing", costUsd: 0, credits: 0 });
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
