// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  DYNAMICS_PRESETS,
  DYNAMICS_RANGES,
  buildCompressorFilter,
  defaultDynamicsValue,
  dynamicsValueOfPreset,
} from "@shared/audio-dynamics.js";

describe("audio compressor terms", () => {
  it("offers light, medium and heavy", () => {
    expect(DYNAMICS_PRESETS).toEqual({
      light: { threshold: -18, ratio: 2, attack: 20, release: 250, makeup: 2 },
      medium: { threshold: -24, ratio: 3, attack: 10, release: 200, makeup: 4 },
      heavy: { threshold: -30, ratio: 6, attack: 5, release: 150, makeup: 6 },
    });
  });

  it("bounds the five sliders", () => {
    expect(DYNAMICS_RANGES).toEqual({
      threshold: { min: -60, max: 0, step: 1 },
      ratio: { min: 1, max: 20, step: 0.5 },
      attack: { min: 0.1, max: 200, step: 0.1 },
      release: { min: 10, max: 2000, step: 10 },
      makeup: { min: 0, max: 24, step: 0.5 },
    });
    for (const [name, preset] of Object.entries(DYNAMICS_PRESETS)) {
      for (const [field, value] of Object.entries(preset)) {
        const range = DYNAMICS_RANGES[field as keyof typeof DYNAMICS_RANGES];
        expect(value, `${name}.${field}`).toBeGreaterThanOrEqual(range.min);
        expect(value, `${name}.${field}`).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it("starts on medium", () => {
    expect(defaultDynamicsValue).toEqual({ preset: "medium", ...DYNAMICS_PRESETS.medium });
    expect(dynamicsValueOfPreset("heavy")).toEqual({ preset: "heavy", ...DYNAMICS_PRESETS.heavy });
  });
});

describe("buildCompressorFilter", () => {
  it("turns the decibel threshold and make-up gain into the linear values acompressor takes", () => {
    expect(buildCompressorFilter({ preset: "custom", threshold: -20, ratio: 4, attack: 15, release: 300, makeup: 6 })).toBe(
      "acompressor=threshold=0.100000:ratio=4:attack=15:release=300:makeup=1.995262:knee=2.8",
    );
  });

  it("sends no make-up gain as a factor of one", () => {
    expect(buildCompressorFilter({ preset: "custom", threshold: 0, ratio: 1, attack: 0.1, release: 10, makeup: 0 })).toBe(
      "acompressor=threshold=1.000000:ratio=1:attack=0.1:release=10:makeup=1.000000:knee=2.8",
    );
  });
});
