// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { openRouterPrices } from "./provider-llm-prices.mjs";

/** OpenRouter's `/api/v1/models` entry for a model: USD per token, as strings. */
const listed = (id, prompt, completion) => ({ id, pricing: { prompt, completion, input_cache_read: "0.0000001" } });

test("writes OpenRouter's per-token prices as USD per million tokens, by our model id", () => {
  const { prices, problems } = openRouterPrices([listed("deepseek/deepseek-v4-pro", "0.0000013", "0.00000396")], new Map([["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"]]));
  assert.deepEqual(prices, { "deepseek/deepseek-v4-pro": { input_cache_miss_per_mtok: 1.3, output_per_mtok: 3.96 } });
  assert.deepEqual(problems, []);
});

test("reads a model OpenRouter lists under another id by that id", () => {
  const { prices } = openRouterPrices([listed("vendor/other-name", "0.000001", "0.000002")], new Map([["ours/model", "vendor/other-name"]]));
  assert.deepEqual(prices, { "ours/model": { input_cache_miss_per_mtok: 1, output_per_mtok: 2 } });
});

test("names a model OpenRouter does not list, and writes no price for it", () => {
  const { prices, problems } = openRouterPrices([], new Map([["ours/model", "ours/model"]]));
  assert.deepEqual(prices, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ours\/model/);
});

test("names a price OpenRouter states as no fixed figure, and writes no price for it", () => {
  for (const bad of ["-1", "abc", "", undefined]) {
    const { prices, problems } = openRouterPrices([listed("ours/model", bad, "0.000002")], new Map([["ours/model", "ours/model"]]));
    assert.deepEqual(prices, {}, String(bad));
    assert.equal(problems.length, 1, String(bad));
  }
});
