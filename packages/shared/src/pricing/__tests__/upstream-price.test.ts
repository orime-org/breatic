// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Evaluating a WaveSpeed pricing contract: `base_price` (1,000,000 = 1 USD),
 * the JSONata `formula` it publishes per endpoint, and its `discount_rate`.
 * The formulas are taken verbatim from the contract API; the cases below use
 * them as published.
 */
import { describe, expect, it } from "vitest";
import { upstreamPriceUsd } from "@shared/pricing/upstream-price";

const WAN_R2V =
  '{"total_price": base_price * (resolution = "1080p" ? 2 : (resolution = "480p" ? 0.5 : 1)) * ($min([duration, 30]) + $ceil($min([get_duration(reference_videos, min=1, max=15, total=15), 15]))) / 5}';
const H3_R2V =
  '{"total_price": base_price * (($min([duration, 15]) + $ceil($min([get_duration(reference_videos, min=2, max=15, total=15), 15]))) / 5 * (resolution = "768p" ? 5 / 7 : 1)) + ($count(reference_images) > 5 ? 50000 * ($count(reference_images) - 5) : 0)}';
const DREAMACTOR = '{"total_price": $min([$ceil(get_duration(video)), 30]) * base_price}';
const ELEVEN_V3 = '{"total_price": $ceil(base_price * $length(text) / 1000)}';
const NANO_BANANA_2 =
  '{"total_price": ((resolution = "0.5k" ? 45000 : base_price * (resolution = "2k" ? 1.5 : (resolution = "4k" ? 2 : 1))) + (enable_web_search ? 14000 : 0) + (enable_image_search ? 14000 : 0)) }';

describe("upstreamPriceUsd", () => {
  it("charges base_price when the formula is empty", async () => {
    const usd = await upstreamPriceUsd({ basePrice: 1_600_000, formula: "", discountRate: 100 }, {}, {});
    expect(usd).toBeCloseTo(1.6, 10);
  });

  it("applies discount_rate to the formula result", async () => {
    const usd = await upstreamPriceUsd(
      { basePrice: 70_000, formula: NANO_BANANA_2, discountRate: 90 },
      { resolution: "1k", enable_web_search: false, enable_image_search: false },
      {},
    );
    expect(usd).toBeCloseTo(0.063, 10);
  });

  it("clamps each clip to [min, max] and the sum to total for get_duration(x, min, max, total)", async () => {
    const usd = await upstreamPriceUsd(
      { basePrice: 500_000, formula: WAN_R2V, discountRate: 100 },
      { resolution: "720p", duration: 5, reference_videos: ["a", "b"] },
      { reference_videos: [20, 20] },
    );
    expect(usd).toBeCloseTo(2.0, 10);
  });

  it("caps the summed clips at the total of get_duration", async () => {
    const usd = await upstreamPriceUsd(
      {
        basePrice: 1_000_000,
        formula: '{"total_price": base_price * get_duration(clips, min=1, max=10, total=12)}',
        discountRate: 100,
      },
      { clips: ["a", "b"] },
      { clips: [10, 10] },
    );
    expect(usd).toBeCloseTo(12, 10);
  });

  it("raises a short clip to the min of get_duration", async () => {
    const usd = await upstreamPriceUsd(
      { basePrice: 700_000, formula: H3_R2V, discountRate: 100 },
      { resolution: "768p", duration: 5, reference_videos: ["a"], reference_images: [] },
      { reference_videos: [1] },
    );
    expect(usd).toBeCloseTo(0.7, 10);
  });

  it("reads a single-clip field through bare get_duration(x)", async () => {
    const usd = await upstreamPriceUsd(
      { basePrice: 50_000, formula: DREAMACTOR, discountRate: 100 },
      { video: "v" },
      { video: [10.4] },
    );
    expect(usd).toBeCloseTo(0.55, 10);
  });

  it("counts a field with no known durations as zero seconds", async () => {
    const usd = await upstreamPriceUsd(
      { basePrice: 50_000, formula: DREAMACTOR, discountRate: 100 },
      { video: "v" },
      {},
    );
    expect(usd).toBe(0);
  });

  it("prices per character through $length(text)", async () => {
    const usd = await upstreamPriceUsd(
      { basePrice: 200_000, formula: ELEVEN_V3, discountRate: 100 },
      { text: "x".repeat(1000) },
      {},
    );
    expect(usd).toBeCloseTo(0.2, 10);
  });

  it("throws when the formula does not produce a finite total_price", async () => {
    await expect(
      upstreamPriceUsd({ basePrice: 200_000, formula: ELEVEN_V3, discountRate: 100 }, {}, {}),
    ).rejects.toThrow(/total_price/);
  });
});
