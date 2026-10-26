// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shipped } from "../config/__tests__/shipped.js";
import { estimateCost, type EstimateInput } from "../pricing/estimate.js";
import { createProvider } from "../provider.js";

interface EstimateFixture {
  cases: { model: string; input: EstimateInput; credits: number; usd: number; bound: string }[];
}

/** Today's estimate for each case (scripts/provider-fixtures.ts). */
const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../test/fixtures/upstream-estimate.json"), "utf8")) as EstimateFixture;

const provider = createProvider({ config: shipped(), keyOf: (name) => (name === "WAVESPEED_API_KEY" ? "k" : undefined), llmMaxRetries: 0, cleanText: (t) => t });

describe("estimate — equal to today's estimate on every case (design 7.2, 13.2)", () => {
  it("has cases of every bound", () => {
    expect(new Set(fixture.cases.map((c) => c.bound))).toEqual(new Set(["exact", "at_least", "at_most", "per_thousand_chars"]));
  });

  it.each(fixture.cases.map((c, i) => [`${i} ${c.model}`, c] as const))("%s", async (_label, c) => {
    const server = await provider.estimate(c.model, c.input, { mode: "default" });
    expect(server).not.toBeNull();
    expect(server!.costUsd).toBeCloseTo(c.usd, 9);
    expect(server!.bound).toBe(c.bound);
    expect(server!.upstream).toBe("wavespeed");
    const browser = await estimateCost(provider.pricingRules(c.model), provider.availability(c.model), c.input, { mode: "default" });
    expect(browser).toEqual(server);
  });
});
