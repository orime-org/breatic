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

describe("the estimate fixture prices every extra step with its param present (DD 32)", () => {
  it("has a case with each priced step's param filled, and two or more items for a per-item step", () => {
    const unsampled: string[] = [];
    for (const [model, { upstreams }] of Object.entries(shipped().media.models)) {
      for (const step of upstreams.find((b) => b.upstream === "wavespeed")?.extra_steps ?? []) {
        if (step.for_param === undefined || step.pricing === undefined) continue;
        const name = step.for_param;
        const filled = fixture.cases.some((c) => {
          if (c.model !== model) return false;
          const value = c.input.params[name];
          if (step.per_item === true) return Array.isArray(value) && value.length >= 2;
          return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
        });
        if (!filled) unsampled.push(`${model}.${name}`);
      }
    }
    expect(unsampled).toEqual([]);
  });
});

describe("estimate — equal to today's estimate on every case (design 7.2, 13.2)", () => {
  it("has cases of every bound", () => {
    expect(new Set(fixture.cases.map((c) => c.bound))).toEqual(new Set(["exact", "at_least", "at_most", "per_thousand_chars"]));
  });

  it.each(fixture.cases.map((c, i) => [`${i} ${c.model}`, c] as const))("%s", async (_label, c) => {
    const server = await provider.estimate(c.model, c.input, { mode: "default" });
    expect(server).not.toBeNull();
    expect(server!.usd).toBeCloseTo(c.usd, 9);
    expect(server!.bound).toBe(c.bound);
    expect(server!.upstream).toBe("wavespeed");
    const browser = await estimateCost(provider.pricingRules(c.model), provider.availability(c.model), c.input, { mode: "default" });
    expect(browser).toEqual(server);
  });
});
