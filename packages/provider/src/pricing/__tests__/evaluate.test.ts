// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { priceUsd, type PriceContract } from "../evaluate.js";

interface PriceFixture {
  contracts: Record<string, PriceContract>;
  cases: { model: string; contract: string; fields: Record<string, unknown>; durations: Record<string, number[]>; usd: number | null }[];
}

/** What today's code answered for every catalog contract (scripts/provider-fixtures.ts). */
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../../test/fixtures/upstream-price.json"), "utf8"),
) as PriceFixture;

describe("priceUsd — equal to today's evaluator on every catalog contract (design 13.2)", () => {
  it("has cases to compare", () => {
    expect(fixture.cases.length).toBeGreaterThan(500);
  });

  it.each(fixture.cases.map((c, i) => [`${i} ${c.model} ${c.contract}`, c] as const))("%s", async (_label, c) => {
    const contract = fixture.contracts[c.contract]!;
    if (c.usd === null) {
      await expect(priceUsd(contract, c.fields, c.durations)).rejects.toThrow();
    } else {
      expect(await priceUsd(contract, c.fields, c.durations)).toBeCloseTo(c.usd, 12);
    }
  });
});

describe("priceUsd — properties", () => {
  it("a flat contract costs basePrice millionths of a dollar times the discount", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(10_000_000), fc.integer({ min: 0, max: 100 }), async (basePrice, discountRate) => {
      expect(await priceUsd({ basePrice, formula: "", discountRate }, {}, {})).toBeCloseTo((basePrice / 1_000_000) * (discountRate / 100), 12);
    }));
  });

  it("the discount scales the formula's price linearly", async () => {
    const formula = "{\"total_price\": duration * base_price}";
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 100 }), async (duration, discountRate) => {
      const full = await priceUsd({ basePrice: 50_000, formula, discountRate: 100 }, { duration }, {});
      const discounted = await priceUsd({ basePrice: 50_000, formula, discountRate }, { duration }, {});
      expect(discounted).toBeCloseTo(full * (discountRate / 100), 12);
    }));
  });

  it("get_duration bills each clip clamped to [min, max] and the sum capped at total", async () => {
    const formula = "{\"total_price\": get_duration(video, min=5, max=10, total=25) * 1000}";
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 5 }), async (clips) => {
      const billed = Math.min(25, clips.reduce((sum, clip) => sum + Math.min(10, Math.max(5, clip)), 0));
      expect(await priceUsd({ basePrice: 0, formula, discountRate: 100 }, { video: clips.map(() => "u") }, { video: clips })).toBeCloseTo(billed * 1000 / 1_000_000, 12);
    }));
  });

  it("a formula without a finite total_price is refused", async () => {
    await expect(priceUsd({ basePrice: 1, formula: "{\"other\": 1}", discountRate: 100 }, {}, {})).rejects.toThrow("total_price");
  });
});
