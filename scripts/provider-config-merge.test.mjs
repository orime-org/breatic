// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeLlm, mergeMediaModels, mergeUpstreams } from "./provider-config-merge.mjs";

const price = (usd) => ({ kind: "formula", base_price: usd, formula: "base_price", discount_rate: 100 });
const ws = (modelId, pricing) => ({ upstream: "wavespeed", weight: 1, model_id: modelId, ...(pricing === undefined ? {} : { pricing }) });
const fal = { upstream: "fal", weight: 2, model_id: "fal-ai/x", output_field: "images", pricing: price(2_000_000) };

test("replaces the WaveSpeed binding in place and keeps every other upstream's", () => {
  const existing = { "m": { upstreams: [ws("old/id", price(1)), fal] } };
  const generated = { "m": { upstreams: [ws("new/id", price(5))] } };
  assert.deepEqual(mergeMediaModels(existing, generated, {}), { "m": { upstreams: [ws("new/id", price(5)), fal] } });
});

test("adds a model the existing file lacks and keeps one the catalog no longer generates", () => {
  const existing = { "kept": { upstreams: [fal] } };
  const generated = { "added": { upstreams: [ws("a/id", price(3))] } };
  assert.deepEqual(mergeMediaModels(existing, generated, {}), { "kept": { upstreams: [fal] }, "added": { upstreams: [ws("a/id", price(3))] } });
});

test("adds a WaveSpeed binding ahead of the others when the model had none", () => {
  const existing = { "m": { upstreams: [fal] } };
  const generated = { "m": { upstreams: [ws("a/id", price(3))] } };
  assert.deepEqual(mergeMediaModels(existing, generated, {}).m.upstreams, [ws("a/id", price(3)), fal]);
});

test("keeps the price a model without a catalog price already has, and writes the placeholder only when it has none", () => {
  const real = price(450_000);
  const existing = { "three-d": { upstreams: [ws("old/3d", real)] } };
  const generated = { "three-d": { upstreams: [ws("new/3d")] }, "fresh-3d": { upstreams: [ws("f/3d")] } };
  const placeholders = { "three-d": price(1), "fresh-3d": price(7) };
  const merged = mergeMediaModels(existing, generated, placeholders);
  assert.deepEqual(merged["three-d"].upstreams, [ws("new/3d", real)]);
  assert.deepEqual(merged["fresh-3d"].upstreams, [ws("f/3d", price(7))]);
});

test("takes the catalog's price over the existing one when the catalog has one", () => {
  const existing = { "m": { upstreams: [ws("a/id", price(1))] } };
  const generated = { "m": { upstreams: [ws("a/id", price(9))] } };
  assert.deepEqual(mergeMediaModels(existing, generated, { "m": price(2) }).m.upstreams, [ws("a/id", price(9))]);
});

test("updates the upstreams it writes and keeps the others", () => {
  const existing = { wavespeed: { kind: "wavespeed", base_url: "old", key_env: "W" }, fal: { kind: "fal", base_url: "https://queue.fal.run", key_env: "FAL_KEY" } };
  const generated = { wavespeed: { kind: "wavespeed", base_url: "new", key_env: "W" } };
  assert.deepEqual(mergeUpstreams(existing, generated), { wavespeed: { kind: "wavespeed", base_url: "new", key_env: "W" }, fal: existing.fal });
});

test("updates the LLM routes and entries it writes by prefix and key, keeping the others", () => {
  const existing = {
    routes: [{ prefix: "a/", upstreams: [{ upstream: "x", weight: 0 }] }, { prefix: "b/", upstreams: [{ upstream: "y", weight: 0 }] }],
    prices: { "a/1": { input_cache_miss_per_mtok: 1, output_per_mtok: 1 }, "b/1": { input_cache_miss_per_mtok: 2, output_per_mtok: 2 } },
    gemini_file_poll_ms: 1,
  };
  const generated = {
    routes: [{ prefix: "a/", upstreams: [{ upstream: "z", weight: 0 }] }],
    prices: { "a/1": { input_cache_miss_per_mtok: 3, output_per_mtok: 3 } },
    gemini_file_poll_ms: 5,
  };
  assert.deepEqual(mergeLlm(existing, generated), {
    routes: [{ prefix: "a/", upstreams: [{ upstream: "z", weight: 0 }] }, { prefix: "b/", upstreams: [{ upstream: "y", weight: 0 }] }],
    prices: { "a/1": { input_cache_miss_per_mtok: 3, output_per_mtok: 3 }, "b/1": existing.prices["b/1"] },
    gemini_file_poll_ms: 5,
  });
});

test("writes the generated content as it is when nothing exists yet", () => {
  const generated = { "m": { upstreams: [ws("a/id", price(3))] } };
  assert.deepEqual(mergeMediaModels(undefined, generated, {}), generated);
  assert.deepEqual(mergeUpstreams(undefined, { w: { kind: "wavespeed", base_url: "u", key_env: "W" } }), { w: { kind: "wavespeed", base_url: "u", key_env: "W" } });
});

test("drops the WaveSpeed binding of a model the catalog no longer binds to WaveSpeed and keeps the others", () => {
  const existing = { "m": { upstreams: [ws("gone/id", price(1)), fal] } };
  const generated = { "m": { upstreams: [] } };
  assert.deepEqual(mergeMediaModels(existing, generated, {}), { "m": { upstreams: [fal] } });
});
