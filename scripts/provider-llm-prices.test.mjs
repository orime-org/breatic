// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { openRouterPrices } from "./provider-llm-prices.mjs";

/** One endpoint of OpenRouter's `/api/v1/models/{author}/{slug}/endpoints`: USD per token, as strings. */
const endpoint = (tag, prompt, completion, quantization = "fp8") => ({ tag, quantization, pricing: { prompt, completion, input_cache_read: "0.0000001" } });
const TAKEN = ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"];

test("writes the cheapest endpoint's per-token prices as USD per million tokens, by our model id", () => {
  const endpoints = new Map([["deepseek/deepseek-v4-pro", [endpoint("azure/us", "0.00000191", "0.00000383"), endpoint("deepinfra/fp8", "0.0000013", "0.0000026"), endpoint("nebius/fp8", "0.00000175", "0.0000035")]]]);
  const { prices, problems } = openRouterPrices(endpoints, new Map([["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"]]), TAKEN);
  assert.deepEqual(prices, { "deepseek/deepseek-v4-pro": { input_cache_miss_per_mtok: 1.3, output_per_mtok: 2.6 } });
  assert.deepEqual(problems, []);
});

test("breaks a tie on the input price by the output price", () => {
  const endpoints = new Map([["m", [endpoint("a", "0.000001", "0.000004"), endpoint("b", "0.000001", "0.000003")]]]);
  assert.deepEqual(openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN).prices, { m: { input_cache_miss_per_mtok: 1, output_per_mtok: 3 } });
});

test("reads a model OpenRouter lists under another id by that id", () => {
  const { prices } = openRouterPrices(new Map([["vendor/other-name", [endpoint("x", "0.000001", "0.000002")]]]), new Map([["ours/model", "vendor/other-name"]]), TAKEN);
  assert.deepEqual(prices, { "ours/model": { input_cache_miss_per_mtok: 1, output_per_mtok: 2 } });
});

test("names a model OpenRouter does not list, and writes no price for it", () => {
  for (const listed of [new Map(), new Map([["ours/model", []]])]) {
    const { prices, problems } = openRouterPrices(listed, new Map([["ours/model", "ours/model"]]), TAKEN);
    assert.deepEqual(prices, {});
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ours\/model/);
  }
});

test("skips an endpoint without a fixed price, and names a model none of whose endpoints has one", () => {
  for (const bad of ["-1", "abc", "", undefined]) {
    const mixed = openRouterPrices(new Map([["m", [endpoint("free", bad, "0.000002"), endpoint("paid", "0.000003", "0.000004")]]]), new Map([["m", "m"]]), TAKEN);
    assert.deepEqual(mixed.prices, { m: { input_cache_miss_per_mtok: 3, output_per_mtok: 4 } }, String(bad));
    const none = openRouterPrices(new Map([["m", [endpoint("free", bad, "0.000002")]]]), new Map([["m", "m"]]), TAKEN);
    assert.deepEqual(none.prices, {}, String(bad));
    assert.equal(none.problems.length, 1, String(bad));
  }
});

test("leaves out an endpoint of a quantization a cheapest call does not take, reading a missing one as unknown", () => {
  const endpoints = new Map([["m", [endpoint("relace/fp4", "0.000000006", "0.0000005", "fp4"), { tag: "official", pricing: { prompt: "0.00000015", completion: "0.0000006" } }, endpoint("deepinfra/fp8", "0.0000001", "0.0000003")]]]);
  assert.deepEqual(openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN).prices, { m: { input_cache_miss_per_mtok: 0.1, output_per_mtok: 0.3 } });
  assert.deepEqual(openRouterPrices(endpoints, new Map([["m", "m"]]), ["unknown"]).prices, { m: { input_cache_miss_per_mtok: 0.15, output_per_mtok: 0.6 } });
});
