// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { costOfModelCall, creditsForUsd } from "@domain/credit/usage-cost.js";

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

/**
 * An AI SDK usage object with the given buckets.
 * @param noCache - Input tokens not read from cache.
 * @param cacheRead - Input tokens read from cache.
 * @param output - Output tokens, reasoning included.
 * @param reasoning - The reasoning share of the output.
 * @returns The usage shape `onLanguageModelCallEnd` hands over.
 */
function usage(noCache: number, cacheRead: number, output: number, reasoning = 0) {
  return {
    inputTokens: noCache + cacheRead,
    inputTokenDetails: { noCacheTokens: noCache, cacheReadTokens: cacheRead, cacheWriteTokens: undefined },
    outputTokens: output,
    outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
    totalTokens: noCache + cacheRead + output,
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
