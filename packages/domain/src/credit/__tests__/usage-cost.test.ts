// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import fc from "fast-check";

import { assertModelsPriced, costOfModelCall, creditsForUsd, estimateModelCallCredits } from "@domain/credit/usage-cost.js";

const PRICING = {
  models: {
    "deepseek/deepseek-v4-pro": {
      input_cache_hit_per_mtok: 0.044,
      input_cache_miss_per_mtok: 1.32,
      output_per_mtok: 3.96,
    },
    "anthropic/claude-opus-5.5": {
      input_cache_hit_per_mtok: 0.2,
      input_cache_miss_per_mtok: 4,
      input_cache_write_5m_per_mtok: 5,
      input_cache_write_1h_per_mtok: 8,
      output_per_mtok: 20,
    },
  },
  services: {
    brave_web_search: { per_request: 0.005 },
    brave_image_search: { per_request: 0.005 },
  },
};

/**
 * An AI SDK usage object with the given buckets.
 * @param noCache - Input tokens not read from cache.
 * @param cacheRead - Input tokens read from cache.
 * @param output - Output tokens, reasoning included.
 * @param reasoning - The reasoning share of the output.
 * @param cacheWrite - Input tokens written to cache, counted in the input total as the AI SDK's Anthropic provider counts them.
 * @returns The usage shape `onLanguageModelCallEnd` hands over.
 */
function usage(noCache: number, cacheRead: number, output: number, reasoning = 0, cacheWrite = 0) {
  return {
    inputTokens: noCache + cacheRead + cacheWrite,
    inputTokenDetails: { noCacheTokens: noCache, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    outputTokens: output,
    outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
    totalTokens: noCache + cacheRead + cacheWrite + output,
  };
}

describe("the cost of one model call", () => {
  it("takes the cost OpenRouter reports", () => {
    const cost = costOfModelCall(
      {
        model: "deepseek/deepseek-v4-pro",
        provider: "openrouter",
        usage: usage(1000, 0, 500),
        providerMetadata: { openrouter: { usage: { cost: 0.0123 } } },
      },
      PRICING,
    );
    expect(cost.costUsd).toBe(0.0123);
    expect(cost.costSource).toBe("provider");
    expect(cost.tokens).toEqual({ input: 1000, cachedInput: 0, output: 500, reasoning: 0 });
  });

  it("prices a direct DeepSeek call from the table, cache hits at the cache price", () => {
    const cost = costOfModelCall(
      {
        model: "deepseek/deepseek-v4-pro",
        provider: "deepseek",
        usage: usage(1_000_000, 1_000_000, 1_000_000, 200_000),
        providerMetadata: undefined,
      },
      PRICING,
    );
    expect(cost.costUsd).toBeCloseTo(1.32 + 0.044 + 3.96, 10);
    expect(cost.costSource).toBe("price_table");
    expect(cost.tokens).toEqual({ input: 2_000_000, cachedInput: 1_000_000, output: 1_000_000, reasoning: 200_000 });
  });

  it("prices a direct Claude call's cache writes at the five-minute write price", () => {
    const cost = costOfModelCall(
      {
        model: "anthropic/claude-opus-5.5",
        provider: "anthropic",
        usage: usage(1_000_000, 1_000_000, 1_000_000, 0, 1_000_000),
        providerMetadata: undefined,
        cacheTtl: "5m",
      },
      PRICING,
    );
    expect(cost.costUsd).toBeCloseTo(4 + 0.2 + 5 + 20, 10);
    expect(cost.tokens).toEqual({ input: 3_000_000, cachedInput: 1_000_000, output: 1_000_000, reasoning: 0 });
  });

  it("prices cache writes at the one-hour write price when the call cached for an hour", () => {
    const cost = costOfModelCall(
      {
        model: "anthropic/claude-opus-5.5",
        provider: "anthropic",
        usage: usage(0, 0, 0, 0, 1_000_000),
        providerMetadata: undefined,
        cacheTtl: "1h",
      },
      PRICING,
    );
    expect(cost.costUsd).toBeCloseTo(8, 10);
  });

  it("prices cache writes at the five-minute price when the call names no duration", () => {
    const cost = costOfModelCall(
      {
        model: "anthropic/claude-opus-5.5",
        provider: "anthropic",
        usage: usage(0, 0, 0, 0, 1_000_000),
        providerMetadata: undefined,
      },
      PRICING,
    );
    expect(cost.costUsd).toBeCloseTo(5, 10);
  });

  it("prices cache writes at the miss price for a model the table gives no write price", () => {
    const cost = costOfModelCall(
      {
        model: "deepseek/deepseek-v4-pro",
        provider: "deepseek",
        usage: usage(0, 0, 0, 0, 1_000_000),
        providerMetadata: undefined,
      },
      PRICING,
    );
    expect(cost.costUsd).toBeCloseTo(1.32, 10);
  });

  it("refuses to price a direct model the table does not list", () => {
    expect(() =>
      costOfModelCall(
        { model: "anthropic/x", provider: "anthropic", usage: usage(1, 0, 1), providerMetadata: undefined },
        PRICING,
      ),
    ).toThrow(/anthropic\/x/);
  });

  it("marks an OpenRouter call that reported no cost as missing, at zero", () => {
    const cost = costOfModelCall(
      { model: "google/x", provider: "openrouter", usage: usage(10, 0, 10), providerMetadata: {} },
      PRICING,
    );
    expect(cost.costUsd).toBe(0);
    expect(cost.costSource).toBe("missing");
  });
});

describe("credits for a dollar amount", () => {
  it("is one credit per cent, times the multiplier", () => {
    expect(creditsForUsd(0.0123, 1)).toBeCloseTo(1.23, 10);
    expect(creditsForUsd(0.0123, 2.5)).toBeCloseTo(3.075, 10);
  });
});

describe("what one model call may cost at most, held before it is made (inner#1611)", () => {
  it("prices input at the dearer of a cache miss and a cache write of the call's lifetime", () => {
    // 100k input at the 1h write price (8) and 16384 output at 20, per million.
    const credits = estimateModelCallCredits(
      { model: "anthropic/claude-opus-5.5", inputTokens: 100_000, maxOutputTokens: 16_384, cacheTtl: "1h" },
      PRICING,
      1,
    );
    expect(credits).toBeCloseTo(creditsForUsd((100_000 * 8 + 16_384 * 20) / 1_000_000, 1), 6);
  });

  it("falls back to the miss price for a model with no write price or a call that does not cache", () => {
    expect(
      estimateModelCallCredits(
        { model: "deepseek/deepseek-v4-pro", inputTokens: 1_000_000, maxOutputTokens: 0, cacheTtl: "1h" },
        PRICING,
        1,
      ),
    ).toBeCloseTo(creditsForUsd(1.32, 1), 6);
    expect(
      estimateModelCallCredits(
        { model: "anthropic/claude-opus-5.5", inputTokens: 1_000_000, maxOutputTokens: 0, cacheTtl: null },
        PRICING,
        1,
      ),
    ).toBeCloseTo(creditsForUsd(4, 1), 6);
  });

  it("applies the multiplier", () => {
    const one = estimateModelCallCredits({ model: "deepseek/deepseek-v4-pro", inputTokens: 10, maxOutputTokens: 10, cacheTtl: null }, PRICING, 1);
    const three = estimateModelCallCredits({ model: "deepseek/deepseek-v4-pro", inputTokens: 10, maxOutputTokens: 10, cacheTtl: null }, PRICING, 3);
    expect(three).toBeCloseTo(one * 3, 9);
  });

  it("throws for a model with no price", () => {
    expect(() =>
      estimateModelCallCredits({ model: "nobody/unpriced", inputTokens: 1, maxOutputTokens: 1, cacheTtl: null }, PRICING, 1),
    ).toThrow(/No price for nobody\/unpriced/);
  });

  it("is never below what the call is then billed, however its input splits across the cache", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"),
        fc.constantFrom<"5m" | "1h">("5m", "1h"),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 16_384 }),
        (model, cacheTtl, noCache, cacheRead, cacheWrite, output) => {
          const inputTokens = noCache + cacheRead + cacheWrite;
          const held = estimateModelCallCredits({ model, inputTokens, maxOutputTokens: 16_384, cacheTtl }, PRICING, 1);
          const billed = creditsForUsd(
            costOfModelCall({ model, provider: "direct", usage: usage(noCache, cacheRead, output, 0, cacheWrite), providerMetadata: undefined, cacheTtl }, PRICING).costUsd,
            1,
          );
          return held + 1e-9 >= billed;
        },
      ),
    );
  });

  it("names every agent model that has no price", () => {
    expect(() => assertModelsPriced(["anthropic/claude-opus-5.5", "x/one", "x/two"], PRICING)).toThrow(/x\/one, x\/two/);
    expect(() => assertModelsPriced(["anthropic/claude-opus-5.5"], PRICING)).not.toThrow();
  });
});
