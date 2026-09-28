// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Estimating what one generation costs, in credits, from a model's declared
 * params, its pricing contract and the upstream calls it adds. Formulas are
 * the ones WaveSpeed publishes for the endpoints named in each fixture.
 */
import { describe, expect, it } from "vitest";
import { estimateCredits, type PricedModel } from "@shared/pricing";

const WAN_T2V: PricedModel = {
  takes_prompt: true,
  params: {
    resolution: { default: "720p", fill: "panel" },
    duration: { default: 5, fill: "panel" },
  },
  pricing: {
    base_price: 500_000,
    formula:
      '{"total_price": base_price * (resolution = "1080p" ? 2 : (resolution = "480p" ? 0.5 : 1)) * $min([$max([$ceil(duration), 2]), 30]) / 5}',
    discount_rate: 95,
  },
};

const MIDJOURNEY: PricedModel = {
  takes_prompt: true,
  params: { hd: { default: true, fill: "none" } },
  pricing: { base_price: 100_000, formula: '{"total_price": base_price * (hd ? 1.5 : 1)}', discount_rate: 100 },
};

const DRIVEN_BY_REFS: PricedModel = {
  takes_prompt: false,
  params: {
    refs: { upstream: "reference_videos", fill: "pool", type: "list", default: null, optional: true },
  },
  pricing: {
    base_price: 50_000,
    formula: '{"total_price": $ceil(get_duration(reference_videos)) * base_price}',
    discount_rate: 100,
  },
};

const REQUIRED_CLIP: PricedModel = {
  takes_prompt: false,
  params: { video: { fill: "canvas", default: null } },
  pricing: {
    base_price: 50_000,
    formula: '{"total_price": $ceil(get_duration(video)) * base_price}',
    discount_rate: 100,
  },
};

const SPEECH_PRICING = {
  base_price: 100_000,
  formula: '{"total_price":base_price * $length(text) / 1000}',
  discount_rate: 100,
};

const SPEECH: PricedModel = {
  takes_prompt: true,
  prompt_upstream: "text",
  params: {},
  pricing: SPEECH_PRICING,
};

const MUREKA_SONG: PricedModel = {
  takes_prompt: true,
  params: {
    song: { upstream: "reference_id", fill: "canvas", default: null },
    vocal: { upstream: "vocal_id", fill: "canvas", default: null },
  },
  pricing: { base_price: 225_000, formula: "", discount_rate: 100 },
  extra_steps: [
    {
      endpoint: "mureka-ai/create-upload-id",
      for_param: "song",
      pricing: { base_price: 10_000, formula: "", discount_rate: 100 },
    },
    {
      endpoint: "mureka-ai/vocal-clone",
      for_param: "vocal",
      reused: true,
      pricing: { base_price: 7_500_000, formula: "", discount_rate: 100 },
    },
  ],
};

const O3_I2V: PricedModel = {
  takes_prompt: true,
  params: {
    duration: { default: 5, fill: "panel" },
    elements: { upstream: "element_list", fill: "pool", type: "list", default: null },
  },
  pricing: { base_price: 2_100_000, formula: '{"total_price": duration / 5 * base_price }', discount_rate: 100 },
  extra_steps: [
    {
      endpoint: "kwaivgi/kling-elements",
      for_param: "elements",
      per_item: true,
      reused: true,
      pricing: { base_price: 10_000, formula: "", discount_rate: 100 },
    },
  ],
};

const VOICE_CLONE: PricedModel = {
  takes_prompt: true,
  prompt_upstream: "text",
  params: { audio: { fill: "canvas", default: null } },
  pricing: { base_price: 1_600_000, formula: "", discount_rate: 100 },
  reused_by: "audio",
  extra_steps: [{ endpoint: "minimax/speech-2.8-hd", pricing: SPEECH_PRICING }],
};

describe("estimateCredits", () => {
  it("prices the params the reader set, in credits after the discount", async () => {
    const estimate = await estimateCredits(WAN_T2V, { params: { resolution: "1080p", duration: 10 } }, 1);
    expect(estimate.bound).toBe("exact");
    expect(estimate.credits).toBeCloseTo(190, 6);
  });

  it("fills what the reader left unset from the declared defaults", async () => {
    const estimate = await estimateCredits(WAN_T2V, { params: {} }, 1);
    expect(estimate.credits).toBeCloseTo(47.5, 6);
  });

  it("reads a pinned default the panel never shows", async () => {
    const estimate = await estimateCredits(MIDJOURNEY, { params: {} }, 1);
    expect(estimate.credits).toBeCloseTo(15, 6);
  });

  it("applies the credit multiplier", async () => {
    const estimate = await estimateCredits(MIDJOURNEY, { params: {} }, 2);
    expect(estimate.credits).toBeCloseTo(30, 6);
  });

  it("sends each param under its upstream name, clip lengths included", async () => {
    const estimate = await estimateCredits(
      DRIVEN_BY_REFS,
      { params: { refs: ["a"] }, durations: { refs: [10] } },
      1,
    );
    expect(estimate).toEqual({ credits: 50, bound: "exact" });
  });

  it("answers a lower bound while a source's length is unknown", async () => {
    const estimate = await estimateCredits(DRIVEN_BY_REFS, { params: { refs: ["a"] } }, 1);
    expect(estimate).toEqual({ credits: 0, bound: "at_least" });
  });

  it("answers a lower bound while a required source priced by its length is still empty", async () => {
    const estimate = await estimateCredits(REQUIRED_CLIP, { params: {} }, 1);
    expect(estimate).toEqual({ credits: 0, bound: "at_least" });
  });

  it("prices an optional source left empty at nothing, exactly", async () => {
    const estimate = await estimateCredits(DRIVEN_BY_REFS, { params: {} }, 1);
    expect(estimate).toEqual({ credits: 0, bound: "exact" });
  });

  it("prices a thousand characters while a per-character model has no text", async () => {
    const estimate = await estimateCredits(SPEECH, { params: {} }, 1);
    expect(estimate.bound).toBe("per_thousand_chars");
    expect(estimate.credits).toBeCloseTo(10, 6);
  });

  it("prices the text it is given", async () => {
    const estimate = await estimateCredits(SPEECH, { params: {}, prompt: "x".repeat(500) }, 1);
    expect(estimate).toEqual({ credits: 5, bound: "exact" });
  });

  it("adds an upload step for a filled slot and leaves an empty one out", async () => {
    const estimate = await estimateCredits(MUREKA_SONG, { params: { song: "s" } }, 1);
    expect(estimate.bound).toBe("exact");
    expect(estimate.credits).toBeCloseTo(23.5, 6);
  });

  it("adds a clone step and says it is an upper bound, since a reused clone costs nothing", async () => {
    const estimate = await estimateCredits(MUREKA_SONG, { params: { vocal: "v" } }, 1);
    expect(estimate.bound).toBe("at_most");
    expect(estimate.credits).toBeCloseTo(772.5, 6);
  });

  it("adds one step per item for a per-item step", async () => {
    const estimate = await estimateCredits(O3_I2V, { params: { elements: ["a", "b"] } }, 1);
    expect(estimate.bound).toBe("at_most");
    expect(estimate.credits).toBeCloseTo(212, 6);
  });

  it("counts a model's own call as reused when its source is, and adds what follows it", async () => {
    const estimate = await estimateCredits(
      VOICE_CLONE,
      { params: { audio: "a" }, prompt: "x".repeat(1000) },
      1,
    );
    expect(estimate.bound).toBe("at_most");
    expect(estimate.credits).toBeCloseTo(170, 6);
  });
});
