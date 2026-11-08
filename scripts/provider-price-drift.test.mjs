// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { priceFactDrift, statedPrice, threeDSampleCheck } from "./provider-price-drift.mjs";

test("stores a price fact seen for the first time and reports nothing", () => {
  assert.deepEqual(priceFactDrift(undefined, "1 minutes", "m fal-ai/x on fal: unit"), { store: true, problem: undefined });
});

test("keeps an unchanged price fact as it is", () => {
  assert.deepEqual(priceFactDrift("1 minutes", "1 minutes", "m fal-ai/x on fal: unit"), { store: false, problem: undefined });
  assert.deepEqual(priceFactDrift({ a: [1, 2] }, { a: [1, 2] }, "m s/x on sandbase: price_formula"), { store: false, problem: undefined });
});

test("reports a changed price fact naming both values, and leaves the stored one for the reviewer", () => {
  const drift = priceFactDrift("1 minutes", "1 seconds", "m fal-ai/x on fal: unit");
  assert.equal(drift.store, false);
  assert.match(drift.problem, /^m fal-ai\/x on fal: unit changed/);
  assert.match(drift.problem, /"1 minutes" -> "1 seconds"/);
});

test("reports a fact that disappeared", () => {
  assert.match(priceFactDrift("0.1 * seconds", null, "m s/x on sandbase: price_formula").problem, /"0\.1 \* seconds" -> null/);
});

test("reads the price WaveSpeed charges from a /model/price answer", () => {
  assert.equal(statedPrice({ code: 200, data: { price: 0.3, discounted_price: 0.27, discount_rate: 90 } }), 0.27);
  assert.equal(statedPrice({ data: { discounted_price: "0.27" } }), 0.27);
});

test("answers why an answer states no price, so the sync lists it", () => {
  for (const data of [{}, { discounted_price: null }, { discounted_price: "" }, { discounted_price: "n/a" }, { price: 0.3 }]) {
    const read = statedPrice({ data });
    assert.equal(typeof read, "string", JSON.stringify(data));
    assert.match(read, /discounted_price/);
  }
  assert.equal(typeof statedPrice({ code: 4005, message: "Failed to retrieve model pricing." }), "string");
});

test("writes every 3D sample's charge in fixture order when WaveSpeed priced them all, reporting a mismatch", () => {
  const samples = [
    { id: "b/model", model: "b", inputs: { x: 1 }, usd: 0.5, local: 0.5 },
    { id: "a/model", model: "a", inputs: { y: 2 }, usd: 0.3, local: 0.2 },
    { id: "b/model", model: "b", inputs: { x: 2 }, usd: 0.6, local: 0.6 },
  ];
  const { charged, problems } = threeDSampleCheck(samples, ["a/model", "b/model", "c/model"]);
  assert.deepEqual(Object.keys(charged), ["a/model", "b/model"]);
  assert.deepEqual(charged["b/model"], [{ inputs: { x: 1 }, usd: 0.5 }, { inputs: { x: 2 }, usd: 0.6 }]);
  assert.deepEqual(problems, ['price mismatch: a {"y":2}: WaveSpeed 0.3, local 0.2']);
});

test("leaves the 3D fixture as it is when any sample went unpriced, naming each one", () => {
  const samples = [
    { id: "a/model", model: "a", inputs: { y: 1 }, usd: 0.2, local: 0.2 },
    { id: "a/model", model: "a", inputs: { y: 2 }, usd: "not priced (GET x answered 503)", local: 0.4 },
    { id: "b/model", model: "b", inputs: { x: 1 }, usd: "no discounted_price ({})", local: 0.5 },
  ];
  const { charged, problems } = threeDSampleCheck(samples, ["a/model", "b/model"]);
  assert.equal(charged, undefined);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /three-d-prices\.json not rewritten.*a \{"y":2\}.*answered 503/);
  assert.match(problems[1], /three-d-prices\.json not rewritten.*b \{"x":1\}/);
});
