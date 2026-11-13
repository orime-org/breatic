// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { costSchema } from "../cost.js";

describe("costSchema: a Cost that crossed a process boundary as JSON", () => {
  it.each([
    { state: "known", usd: 0.0012, source: "reported" },
    { state: "known", usd: 0, source: "price_table", tokens: { input: 10, cachedInput: 2, output: 3, reasoning: 1 } },
    { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1" } },
    { state: "missing", reason: "no usage" },
    { state: "missing", reason: "no price", tokens: { input: 1, cachedInput: 0, output: 1, reasoning: 0 } },
  ])("reads %o back as it was written", (cost) => {
    expect(costSchema.parse(JSON.parse(JSON.stringify(cost)))).toEqual(cost);
  });

  it.each([
    ["an unknown state", { state: "guessed", usd: 1 }],
    ["a negative amount", { state: "known", usd: -1, source: "reported" }],
    ["an amount that is not finite", { state: "known", usd: null, source: "reported" }],
    ["an unknown source", { state: "known", usd: 1, source: "invoice" }],
    ["a lookup that names no upstream", { state: "pending", lookup: { generationId: "gen-1" } }],
    ["a missing cost without its reason", { state: "missing" }],
    ["a token count that is not a count", { state: "missing", reason: "x", tokens: { input: -1, cachedInput: 0, output: 0, reasoning: 0 } }],
  ])("refuses %s", (_name, value) => {
    expect(costSchema.safeParse(value).success).toBe(false);
  });
});
