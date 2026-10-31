// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The numbers one adjust value comes to, read by the video filter and the
 * picture's filters alike (inner#1303 §6.1), and each slider's range.
 */

import { describe, it, expect } from "vitest";

import { ADJUST_RANGES, adjustTerms, defaultAdjustValue, type AdjustValue } from "@shared/adjust-value.js";

/**
 * The terms for these sliders, the rest at zero.
 * @param value - The sliders that move.
 * @returns The terms.
 */
function termsOf(value: Partial<AdjustValue>): ReturnType<typeof adjustTerms> {
  return adjustTerms({ ...defaultAdjustValue, ...value });
}

describe("adjustTerms", () => {
  it("comes to the identity at neutral", () => {
    expect(termsOf({})).toEqual({
      brightness: 0,
      contrast: 1,
      saturation: 1,
      hueRadians: 0,
      blur: 0,
      grain: 0,
      sharpen: 0,
      clarity: 0,
      channels: null,
      vignetteAngle: 0,
    });
  });

  it("folds exposure, highlights, shadows and fade into brightness", () => {
    expect(termsOf({ exposure: 60, highlights: -20, shadows: 30 }).brightness).toBeCloseTo(0.43, 10);
  });

  it("turns the hue slider the other way, in radians", () => {
    expect(termsOf({ hue: 90 }).hueRadians).toBeCloseTo(-Math.PI / 2, 10);
  });

  it("names a channel multiplier only when temperature or tint moves", () => {
    expect(termsOf({ temperature: 100 }).channels).toEqual({ r: 1.22, g: 1.06, b: 0.72 });
  });

  it("keeps sharpening, clarity and grain off below half a step", () => {
    expect(termsOf({ sharpness: 0.4, clarity: 0.4, grain: 0.4 })).toMatchObject({ sharpen: 0, clarity: 0, grain: 0 });
    expect(termsOf({ sharpness: 100, clarity: 100, grain: 100 })).toMatchObject({ sharpen: 1.15, clarity: 0.75, grain: 54 });
  });
});

describe("ADJUST_RANGES", () => {
  it("runs the one-sided channels from zero and the rest both ways", () => {
    const oneSided = ["noiseReduction", "sharpness", "vignette", "grain"];
    for (const key of Object.keys(defaultAdjustValue) as (keyof AdjustValue)[]) {
      expect(ADJUST_RANGES[key], key).toEqual(oneSided.includes(key) ? { min: 0, max: 100 } : { min: -100, max: 100 });
    }
  });
});
