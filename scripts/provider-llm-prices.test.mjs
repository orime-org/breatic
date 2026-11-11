// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "yaml";

import { offPeakHolidayProblems, openRouterPrices, syncedLlmYaml } from "./provider-llm-prices.mjs";

/** One endpoint of OpenRouter's `/api/v1/models/{author}/{slug}/endpoints`: USD per token, as strings. */
const endpoint = (tag, prompt, completion, quantization = "fp8") => ({ tag, quantization, pricing: { prompt, completion, input_cache_read: "0.0000001" } });
const TAKEN = ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"];
/** The rule `openRouterLevels` in packages/provider/src/llm/upstreams/openrouter.ts holds, which provider-prices.ts passes in. */
const levels = (quantizations, statesQuantization) => (statesQuantization ? quantizations.filter((q) => q !== "unknown") : quantizations);

test("writes the cheapest endpoint's per-token prices as USD per million tokens, by our model id", () => {
  const endpoints = new Map([["deepseek/deepseek-v4-pro", [endpoint("azure/us", "0.00000191", "0.00000383"), endpoint("deepinfra/fp8", "0.0000013", "0.0000026"), endpoint("nebius/fp8", "0.00000175", "0.0000035")]]]);
  const { prices, problems } = openRouterPrices(endpoints, new Map([["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"]]), TAKEN, levels);
  assert.deepEqual(prices, { "deepseek/deepseek-v4-pro": { input_cache_miss_per_mtok: 1.3, output_per_mtok: 2.6 } });
  assert.deepEqual(problems, []);
});

test("breaks a tie on the input price by the output price", () => {
  const endpoints = new Map([["m", [endpoint("a", "0.000001", "0.000004"), endpoint("b", "0.000001", "0.000003")]]]);
  assert.deepEqual(openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels).prices, { m: { input_cache_miss_per_mtok: 1, output_per_mtok: 3 } });
});

test("reads a model OpenRouter lists under another id by that id", () => {
  const { prices } = openRouterPrices(new Map([["vendor/other-name", [endpoint("x", "0.000001", "0.000002")]]]), new Map([["ours/model", "vendor/other-name"]]), TAKEN, levels);
  assert.deepEqual(prices, { "ours/model": { input_cache_miss_per_mtok: 1, output_per_mtok: 2 } });
});

test("names a model OpenRouter does not list, and writes no price for it", () => {
  for (const listed of [new Map(), new Map([["ours/model", []]])]) {
    const { prices, problems } = openRouterPrices(listed, new Map([["ours/model", "ours/model"]]), TAKEN, levels);
    assert.deepEqual(prices, {});
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ours\/model/);
  }
});

test("skips an endpoint without a fixed price, and names a model none of whose endpoints has one", () => {
  for (const bad of ["-1", "abc", "", undefined]) {
    const mixed = openRouterPrices(new Map([["m", [endpoint("free", bad, "0.000002"), endpoint("paid", "0.000003", "0.000004")]]]), new Map([["m", "m"]]), TAKEN, levels);
    assert.deepEqual(mixed.prices, { m: { input_cache_miss_per_mtok: 3, output_per_mtok: 4 } }, String(bad));
    const none = openRouterPrices(new Map([["m", [endpoint("free", bad, "0.000002")]]]), new Map([["m", "m"]]), TAKEN, levels);
    assert.deepEqual(none.prices, {}, String(bad));
    assert.equal(none.problems.length, 1, String(bad));
  }
});

test("leaves out an endpoint of a quantization a cheapest call does not take, reading a missing one as unknown", () => {
  const stated = new Map([["m", [endpoint("relace/fp4", "0.000000006", "0.0000005", "fp4"), endpoint("deepinfra/fp8", "0.0000001", "0.0000003")]]]);
  assert.deepEqual(openRouterPrices(stated, new Map([["m", "m"]]), TAKEN, levels).prices, { m: { input_cache_miss_per_mtok: 0.1, output_per_mtok: 0.3 } });
  const unstated = new Map([["m", [endpoint("other", "0.0000002", "0.0000007", "unknown"), { tag: "official", pricing: { prompt: "0.00000015", completion: "0.0000006" } }]]]);
  assert.deepEqual(openRouterPrices(unstated, new Map([["m", "m"]]), TAKEN, levels).prices, { m: { input_cache_miss_per_mtok: 0.15, output_per_mtok: 0.6 } });
  assert.deepEqual(openRouterPrices(unstated, new Map([["m", "m"]]), ["fp8"], levels).prices, {});
});

test("drops unknown for a model one of whose endpoints states a level, and marks the model apart from its price", () => {
  const endpoints = new Map([["m", [endpoint("particle-ai/us", "0.00000005", "0.0000005", "unknown"), endpoint("morph/fp8", "0.0000001", "0.0000004"), { tag: "official", pricing: { prompt: "0.00000001", completion: "0.0000001" } }]]]);
  const { prices, statesQuantization } = openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels);
  assert.deepEqual(prices, { m: { input_cache_miss_per_mtok: 0.1, output_per_mtok: 0.4 } });
  assert.deepEqual(statesQuantization, ["m"]);
});

test("marks a model whose stated endpoints are all outside its levels, though it gets no price", () => {
  const endpoints = new Map([["m", [endpoint("relace/fp4", "0.000000006", "0.0000005", "fp4"), endpoint("venice", "0.0000001", "0.0000003", "unknown")]]]);
  const { prices, statesQuantization, problems } = openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels);
  assert.deepEqual(prices, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^m: /);
  assert.deepEqual(statesQuantization, ["m"]);
});

test("prices an fp8 endpoint over a cheaper unknown one, and marks the model", () => {
  const endpoints = new Map([["m", [endpoint("venice", "0.0000001", "0.0000002", "unknown"), endpoint("deepinfra/fp8", "0.0000003", "0.0000006")]]]);
  const { prices, statesQuantization } = openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels);
  assert.deepEqual(prices, { m: { input_cache_miss_per_mtok: 0.3, output_per_mtok: 0.6 } });
  assert.deepEqual(statesQuantization, ["m"]);
});

test("takes unknown for a model none of whose endpoints states a level, and leaves it unmarked", () => {
  const endpoints = new Map([["m", [endpoint("anthropic", "0.000005", "0.000025", "unknown"), endpoint("amazon-bedrock", "0.000004", "0.00002", "unknown"), { tag: "google-vertex", pricing: { prompt: "0.0000045", completion: "0.00002" } }]]]);
  const { prices, statesQuantization } = openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels);
  assert.deepEqual(prices, { m: { input_cache_miss_per_mtok: 4, output_per_mtok: 20 } });
  assert.deepEqual(statesQuantization, []);
});

test("leaves out a service-tier endpoint, which a price-sorted call never reaches, however cheap", () => {
  const flex = { ...endpoint("google-ai-studio/flex", "0.00000015", "0.00000125"), service_tier: "flex" };
  const standard = { ...endpoint("google-ai-studio", "0.0000003", "0.0000025"), service_tier: null };
  const endpoints = new Map([["m", [flex, standard, endpoint("google-vertex", "0.0000004", "0.000003")]]]);
  assert.deepEqual(openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels).prices, { m: { input_cache_miss_per_mtok: 0.3, output_per_mtok: 2.5 } });
});

test("ranks a pinned model only over the endpoints of the providers it is pinned to, the pin read as llm.yaml writes it", () => {
  const endpoints = new Map([["m", [endpoint("google-ai-studio", "0.0000001", "0.000001"), endpoint("google-vertex-x", "0.0000002", "0.000002"), endpoint("google-vertex/us", "0.0000004", "0.000004"), endpoint("google-vertex", "0.0000003", "0.000003")]]]);
  const { prices, problems } = openRouterPrices(endpoints, new Map([["m", "m"]]), TAKEN, levels, { m: { only: ["google-vertex"], allow_fallbacks: false } });
  assert.deepEqual(prices, { m: { input_cache_miss_per_mtok: 0.3, output_per_mtok: 3 } });
  assert.deepEqual(problems, []);
});

test("rewrites openrouter_prices from the values the schema reads, its defaults filled, and keeps the file's comments", async () => {
  const text = "# Where LLM calls go.\nprices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\nvendor_ids:\n  m:\n    openrouter: vendor/m\n";
  const asked = [];
  // Fills what the schema fills when the file leaves them out; this file leaves out openrouter_quantizations.
  const parse = (raw) => ({ openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw });
  const synced = await syncedLlmYaml(text, parse, levels, async (id) => {
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

test("writes the models that state a level, in the order of prices, priced or not, at the end of a file that lacks the key", async () => {
  const text = "prices:\n  b:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\n  plain:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\n  a:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\nopenrouter_prices: {}\nopenrouter_prices_at: 2026-01-01T00:00:00.000Z\n";
  const listed = { b: [endpoint("relace/fp4", "0.0000001", "0.0000002", "fp4")], plain: [endpoint("venice", "0.000001", "0.000002", "unknown")], a: [endpoint("kept/fp8", "0.000001", "0.000002")] };
  const synced = await syncedLlmYaml(text, (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: TAKEN, ...raw }), levels, async (id) => listed[id]);
  assert.equal(synced.priced, 2);
  assert.match(synced.text, /\nopenrouter_states_quantization:\n  - b\n  - a\n$/);
});

test("replaces an openrouter_states_quantization the file already holds where it stands, written once", async () => {
  const text = "prices:\n  b:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\nopenrouter_prices: {}\nopenrouter_states_quantization:\n  - stale\nopenrouter_prices_at: 2026-01-01T00:00:00.000Z\n";
  const synced = await syncedLlmYaml(text, (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: TAKEN, ...raw }), levels, async () => [endpoint("relace/fp4", "0.0000001", "0.0000002", "fp4")]);
  assert.equal(synced.text.match(/^openrouter_states_quantization:/gm)?.length, 1);
  assert.doesNotMatch(synced.text, /stale/);
  assert.match(synced.text, /\nopenrouter_states_quantization:\n  - b\nopenrouter_prices_at:/);
  assert.ok(synced.text.indexOf("openrouter_prices:") < synced.text.indexOf("openrouter_states_quantization:"));
  assert.doesNotThrow(() => parse(synced.text));
});

test("writes the moment OpenRouter's prices were read beside them", async () => {
  const text = "prices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\nopenrouter_prices_at: 2026-01-01T00:00:00.000Z\n";
  const synced = await syncedLlmYaml(text, (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw }), levels, async () => [endpoint("kept/fp8", "0.000001", "0.000002")], Date.parse("2026-11-08T05:12:33.456Z"));
  assert.match(synced.text, /\nopenrouter_prices_at: 2026-11-08T05:12:33\.456Z\n/);
  assert.equal(synced.text.match(/openrouter_prices_at/g)?.length, 1);
});

test("notes a rerun after each model's next direct price change, one line per model, without failing the sync", async () => {
  const text = [
    "prices:",
    "  changing:",
    "    - input_cache_miss_per_mtok: 1",
    "      output_per_mtok: 2",
    "    - from: 2027-01-01T00:00:00Z",
    "      input_cache_miss_per_mtok: 2",
    "      output_per_mtok: 4",
    "    - from: 2027-06-01T00:00:00Z",
    "      input_cache_miss_per_mtok: 3",
    "      output_per_mtok: 6",
    "  changed:",
    "    - input_cache_miss_per_mtok: 1",
    "      output_per_mtok: 2",
    "    - from: 2026-10-01T00:00:00Z",
    "      input_cache_miss_per_mtok: 2",
    "      output_per_mtok: 4",
    "  plain:",
    "    - input_cache_miss_per_mtok: 1",
    "      output_per_mtok: 2",
    "",
  ].join("\n");
  const synced = await syncedLlmYaml(text, (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw }), levels, async () => [endpoint("kept/fp8", "0.000001", "0.000002")], Date.parse("2026-11-08T00:00:00Z"));
  assert.deepEqual(synced.notices, ["changing: its direct price changes at 2027-01-01T00:00:00Z; rerun pnpm provider:prices after then so OpenRouter's price is read at the same time"]);
  assert.deepEqual(synced.problems, []);
});

test("names a model OpenRouter answers 404 for", async () => {
  const synced = await syncedLlmYaml("prices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\n", (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw }), levels, async () => undefined);
  assert.equal(synced.priced, 0);
  assert.deepEqual(synced.problems, ["m: OpenRouter lists no endpoint of m"]);
});

test("asks for the current year's off-peak holidays, and from 1 December for the next year's instead, naming where they go", () => {
  const offPeak = (holidays) => ({ factor: 0.5, peak_utc: [{ days: [1], from: "01:00", to: "04:00" }], holidays });
  const prices = {
    listed: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak(["2027-01-01"]) }],
    plain: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2 }],
  };
  const where = "(add them to the holidays of deepseekOffPeak in scripts/provider-config-migration.ts and rerun it)";
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2027-06-01T00:00:00Z")), []);
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2027-11-30T23:59:59Z")), []);
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2027-12-01T00:00:00Z")), [`listed: off-peak holidays list no date in 2028 ${where}`]);
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2028-01-10T00:00:00Z")), [`listed: off-peak holidays list no date in 2028 ${where}`]);
});

test("asks a December run with a stale list once per model, for the next year only", () => {
  const offPeak = (holidays) => ({ factor: 0.5, peak_utc: [{ days: [1], from: "01:00", to: "04:00" }], holidays });
  const prices = {
    empty: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak([]) }],
    old: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak(["2025-10-01"]) }],
  };
  const where = "(add them to the holidays of deepseekOffPeak in scripts/provider-config-migration.ts and rerun it)";
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2026-12-05T00:00:00Z")), [
    `empty: off-peak holidays list no date in 2027 ${where}`,
    `old: off-peak holidays list no date in 2027 ${where}`,
  ]);
});

test("reads only the prices in effect now or later for off-peak holidays", () => {
  const offPeak = (holidays) => ({ factor: 0.5, peak_utc: [{ days: [1], from: "01:00", to: "04:00" }], holidays });
  const prices = {
    superseded: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak(["2026-10-01"]) }, { from: "2027-01-01T00:00:00Z", input_cache_miss_per_mtok: 1, output_per_mtok: 2 }],
    coming: [{ input_cache_miss_per_mtok: 1, output_per_mtok: 2 }, { from: "2028-01-01T00:00:00Z", input_cache_miss_per_mtok: 1, output_per_mtok: 2, off_peak: offPeak([]) }],
  };
  assert.deepEqual(offPeakHolidayProblems(prices, Date.parse("2027-06-01T00:00:00Z")), ["coming: off-peak holidays list no date in 2027 (add them to the holidays of deepseekOffPeak in scripts/provider-config-migration.ts and rerun it)"]);
});

test("reports the off-peak holidays among the sync's problems", async () => {
  const text = "prices:\n  m:\n    - input_cache_miss_per_mtok: 1\n      output_per_mtok: 2\n      off_peak:\n        factor: 0.5\n        peak_utc:\n          - days: [1]\n            from: \"01:00\"\n            to: \"04:00\"\n        holidays: []\n";
  const synced = await syncedLlmYaml(text, (raw) => ({ vendor_ids: {}, openrouter_backends: {}, openrouter_quantizations: ["fp8"], ...raw }), levels, async () => [endpoint("kept/fp8", "0.000001", "0.000002")], Date.parse("2026-11-08T00:00:00Z"));
  assert.deepEqual(synced.problems, ["m: off-peak holidays list no date in 2026 (add them to the holidays of deepseekOffPeak in scripts/provider-config-migration.ts and rerun it)"]);
});
