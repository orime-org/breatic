// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evaluationMessage, holds, priceUsd, type PriceContract } from "../evaluate.js";

interface PriceFixture {
  contracts: Record<string, PriceContract>;
  cases: { model: string; contract: string; fields: Record<string, unknown>; durations: Record<string, number[]>; usd: number | null }[];
}

/** What today's code answered for every catalog contract (scripts/provider-fixtures.ts). */
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../../test/fixtures/upstream-price.json"), "utf8"),
) as PriceFixture;

describe("priceUsd — equal to today's evaluator on every catalog contract", () => {
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

  it("one formula priced at once on many runs reads each run's own clips", async () => {
    const formula = "{\"total_price\": get_duration(video) * 1000}";
    await fc.assert(fc.asyncProperty(fc.array(fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 4 }), { minLength: 2, maxLength: 8 }), async (runs) => {
      const prices = await Promise.all(runs.map((clips) => priceUsd({ basePrice: 0, formula, discountRate: 100 }, { video: clips.map(() => "u") }, { video: clips })));
      expect(prices).toEqual(runs.map((clips) => clips.reduce((sum, clip) => sum + clip, 0) * 1000 / 1_000_000));
    }));
  });

  it("a condition held at once on many runs reads each run's own clips", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 2, maxLength: 8 }), async (lengths) => {
      const verdicts = await Promise.all(lengths.map((length) => holds("get_duration(video) > 15", { video: ["u"] }, { video: [length] })));
      expect(verdicts).toEqual(lengths.map((length) => length > 15));
    }));
  });

  it("a formula without a finite total_price is refused", async () => {
    await expect(priceUsd({ basePrice: 1, formula: "{\"other\": 1}", discountRate: 100 }, {}, {})).rejects.toThrow("total_price");
  });
});

describe("the words of what an evaluation threw", () => {
  it("are its message, or the value as text when it carries none", () => {
    expect(evaluationMessage({ message: "bad token", code: "S0201" })).toBe("bad token");
    expect(evaluationMessage({ code: "S0201" })).toBe("[object Object]");
    expect(evaluationMessage(undefined)).toBe("undefined");
  });
});

/** WaveSpeed's published formulas, verbatim, the examples moved from shared's evaluator tests. */
const WAN_R2V =
  '{"total_price": base_price * (resolution = "1080p" ? 2 : (resolution = "480p" ? 0.5 : 1)) * ($min([duration, 30]) + $ceil($min([get_duration(reference_videos, min=1, max=15, total=15), 15]))) / 5}';
const H3_R2V =
  '{"total_price": base_price * (($min([duration, 15]) + $ceil($min([get_duration(reference_videos, min=2, max=15, total=15), 15]))) / 5 * (resolution = "768p" ? 5 / 7 : 1)) + ($count(reference_images) > 5 ? 50000 * ($count(reference_images) - 5) : 0)}';
const DREAMACTOR = '{"total_price": $min([$ceil(get_duration(video)), 30]) * base_price}';
const ELEVEN_V3 = '{"total_price": $ceil(base_price * $length(text) / 1000)}';
const NANO_BANANA_2 =
  '{"total_price": ((resolution = "0.5k" ? 45000 : base_price * (resolution = "2k" ? 1.5 : (resolution = "4k" ? 2 : 1))) + (enable_web_search ? 14000 : 0) + (enable_image_search ? 14000 : 0)) }';

describe("priceUsd — worked examples", () => {
  it("charges base_price when the formula is empty", async () => {
    expect(await priceUsd({ basePrice: 1_600_000, formula: "", discountRate: 100 }, {}, {})).toBeCloseTo(1.6, 10);
  });

  it("applies discount_rate to the formula result", async () => {
    const usd = await priceUsd({ basePrice: 70_000, formula: NANO_BANANA_2, discountRate: 90 }, { resolution: "1k", enable_web_search: false, enable_image_search: false }, {});
    expect(usd).toBeCloseTo(0.063, 10);
  });

  it("clamps each clip to [min, max] and the sum to total for get_duration(x, min, max, total)", async () => {
    const usd = await priceUsd({ basePrice: 500_000, formula: WAN_R2V, discountRate: 100 }, { resolution: "720p", duration: 5, reference_videos: ["a", "b"] }, { reference_videos: [20, 20] });
    expect(usd).toBeCloseTo(2.0, 10);
  });

  it("raises a short clip to the min of get_duration", async () => {
    const usd = await priceUsd({ basePrice: 700_000, formula: H3_R2V, discountRate: 100 }, { resolution: "768p", duration: 5, reference_videos: ["a"], reference_images: [] }, { reference_videos: [1] });
    expect(usd).toBeCloseTo(0.7, 10);
  });

  it("reads a single-clip field through bare get_duration(x)", async () => {
    expect(await priceUsd({ basePrice: 50_000, formula: DREAMACTOR, discountRate: 100 }, { video: "v" }, { video: [10.4] })).toBeCloseTo(0.55, 10);
  });

  it("counts a field with no known durations as zero seconds", async () => {
    expect(await priceUsd({ basePrice: 50_000, formula: DREAMACTOR, discountRate: 100 }, { video: "v" }, {})).toBe(0);
  });

  it("prices per character through $length(text)", async () => {
    expect(await priceUsd({ basePrice: 200_000, formula: ELEVEN_V3, discountRate: 100 }, { text: "x".repeat(1000) }, {})).toBeCloseTo(0.2, 10);
  });

  it("throws when the formula does not produce a finite total_price", async () => {
    await expect(priceUsd({ basePrice: 200_000, formula: ELEVEN_V3, discountRate: 100 }, {}, {})).rejects.toThrow(/total_price/);
  });
});
