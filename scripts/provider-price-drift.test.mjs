// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { priceFactDrift } from "./provider-price-drift.mjs";

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
