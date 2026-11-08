// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { offPeakHolidayProblems, openRouterPrices, syncedLlmYaml } from "./provider-llm-prices.mjs";

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

test("leaves out a service-tier endpoint, which a price-sorted call never reaches, however cheap", () => {
  const flex = { ...endpoint("google-ai-studio/flex", "0.00000015", "0.00000125"), service_tier: "flex" };
  const standard = { ...endpoint("google-ai-studio", "0.0000003", "0.0000025"), service_tier: null };
  const endpoints = new Map([["m", [flex, standard, endpoint("google-vertex", "0.0000004", "0.000003")]]]);
  assert.deepEqual(openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN).prices, { m: { input_cache_miss_per_mtok: 0.3, output_per_mtok: 2.5 } });
});

test("ranks a pinned model only over the endpoints of the providers it is pinned to, the pin read as llm.yaml writes it", () => {
  const endpoints = new Map([["m", [endpoint("google-ai-studio", "0.0000001", "0.000001"), endpoint("google-vertex-x", "0.0000002", "0.000002"), endpoint("google-vertex/us", "0.0000004", "0.000004"), endpoint("google-vertex", "0.0000003", "0.000003")]]]);
  const { prices, problems } = openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, { m: { only: ["google-vertex"], allow_fallbacks: false } });
  assert.deepEqual(prices, { m: { input_cache_miss_per_mtok: 0.3, output_per_mtok: 3 } });
  assert.deepEqual(problems, []);
});

test("rewrites openrouter_prices from the values the schema reads, its defaults filled, and keeps the file's comments", async () => {
  const text = "# Where LLM calls go.\nprices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\nvendor_ids:\n  m:\n    openrouter: vendor/m\n";
  const asked = [];
  // Fills what the schema fills when the file leaves them out; this file leaves out openrouter_quantizations.
  const parse = (raw) => ({ openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw });
  const synced = await syncedLlmYaml(text, parse, async (id) => {
    asked.push(id);
    return [endpoint("cheap/fp4", "0.0000001", "0.0000002", "fp4"), endpoint("kept/fp8", "0.000001", "0.000002")];
  });
  assert.deepEqual(asked, ["vendor/m"]);
  assert.deepEqual(synced.problems, []);
  assert.equal(synced.asked, 1);
  assert.equal(synced.priced, 1);
  assert.match(synced.text, /^# Where LLM calls go\.\n/);
  assert.match(synced.text, /openrouter_prices:\n  m:\n    input_cache_miss_per_mtok: 1\n    output_per_mtok: 2\n/);
});

test("names a model OpenRouter answers 404 for", async () => {
  const synced = await syncedLlmYaml("prices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\n", (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw }), async () => undefined);
  assert.equal(synced.priced, 0);
  assert.deepEqual(synced.problems, ["m: OpenRouter lists no endpoint of m"]);
});

test("names each model with an off-peak discount whose holidays list no date in the calendar year after the run", () => {
  const offPeak = (holidays) => ({ factor: 0.5, peak_utc: [{ days: [1], from: "01:00", to: "04:00" }], holidays });
  const prices = {
    listed: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak(["2027-01-01"]) }],
    stale: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak(["2026-10-01"]) }],
    empty: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2 }, { from: "2027-01-01T00:00:00Z", input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak([]) }],
    plain: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2 }],
  };
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2026-12-31T23:59:59Z")), ["stale: off-peak holidays list no date in 2027", "empty: off-peak holidays list no date in 2027"]);
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2027-01-01T00:00:00Z")), ["listed: off-peak holidays list no date in 2028", "stale: off-peak holidays list no date in 2028", "empty: off-peak holidays list no date in 2028"]);
});

test("reports the off-peak holidays among the sync's problems", async () => {
  const text = "prices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\n      off_peak:\n        factor: 0.5\n        peak_utc:\n          - days: [1]\n            from: \"01:00\"\n            to: \"04:00\"\n        holidays: []\n";
  const synced = await syncedLlmYaml(text, (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw }), async () => [endpoint("kept/fp8", "0.000001", "0.000002")], Date.parse("2026-11-08T00:00:00Z"));
  assert.deepEqual(synced.problems, ["m: off-peak holidays list no date in 2027"]);
});
