// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The video adjust filter's output, pinned character for character, so that
 * moving its coefficients into a shared function changes nothing ffmpeg is
 * told except the hue rotation, which is passed in radians as `H`
 * (inner#1303 §6.1).
 */

import { describe, it, expect } from "vitest";

import { buildAdjustVideoFilter, defaultAdjustValue, type AdjustValue } from "@shared/adjust-value.js";

/**
 * The filter for these sliders, the rest at zero.
 * @param value - The sliders that move.
 * @returns The `-vf` chain.
 */
function filterOf(value: Partial<AdjustValue>): string {
  return buildAdjustVideoFilter({ ...defaultAdjustValue, ...value });
}

describe("buildAdjustVideoFilter", () => {
  it("leaves a neutral value at the identity eq", () => {
    expect(filterOf({})).toBe("eq=brightness=0.00000:contrast=1.00000:saturation=1.00000");
  });

  it("folds exposure, highlights and shadows into brightness", () => {
    expect(filterOf({ exposure: 60, highlights: -20, shadows: 30 })).toBe(
      "eq=brightness=0.43000:contrast=1.00000:saturation=1.00000",
    );
  });

  it("writes every stage when every channel moves", () => {
    expect(
      filterOf({
        exposure: 10,
        highlights: 20,
        shadows: -30,
        contrast: 40,
        saturation: -50,
        vibrance: 60,
        temperature: 70,
        tint: -80,
        hue: 90,
        sharpness: 55,
        noiseReduction: 45,
        clarity: 35,
        vignette: 25,
        grain: 15,
        fade: 5,
      }),
    ).toBe(
      "eq=brightness=0.21350:contrast=1.41012:saturation=0.83750,hue=H=-1.570796,gblur=sigma=1.3500," +
        "noise=alls=12:allf=t+u,unsharp=5:5:0.6325:5:5:0.0,unsharp=7:7:0.2625:7:7:0.0," +
        "colorchannelmixer=rr=1.21800:gg=0.88200:bb=0.88400,vignette=angle=0.451604",
    );
  });

  it("clamps at the ends of every range", () => {
    expect(
      filterOf({
        exposure: -100,
        contrast: -100,
        saturation: 100,
        hue: -100,
        temperature: -100,
        tint: 100,
        sharpness: 100,
        noiseReduction: 100,
        clarity: 100,
        vignette: 100,
        grain: 100,
        fade: 100,
      }),
    ).toBe(
      "eq=brightness=-0.63000:contrast=0.53250:saturation=1.70000,hue=H=1.745329,gblur=sigma=3.0000," +
        "noise=alls=54:allf=t+u,unsharp=5:5:1.1500:5:5:0.0,unsharp=7:7:0.7500:7:7:0.0," +
        "colorchannelmixer=rr=0.70000:gg=1.14000:bb=1.18000,vignette=angle=0.981748",
    );
  });
});
