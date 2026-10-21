// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  EQ_BANDS_HZ,
  EQ_GAIN_RANGE,
  EQ_PRESETS,
  buildEqFilter,
  defaultEqValue,
  eqValueOfPreset,
} from "@shared/audio-eq.js";

const LIMITER = "alimiter=limit=0.89:level=disabled";

describe("audio EQ terms", () => {
  it("has ten octave bands from 31 Hz to 16 kHz", () => {
    expect(EQ_BANDS_HZ).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  });

  it("holds every band to plus or minus 12 dB in whole steps", () => {
    expect(EQ_GAIN_RANGE).toEqual({ min: -12, max: 12, step: 1 });
  });

  it("names seven presets with ten gains each, all within range", () => {
    expect(Object.keys(EQ_PRESETS)).toEqual([
      "flat",
      "bass_boost",
      "bass_cut",
      "treble_boost",
      "treble_cut",
      "voice",
      "telephone",
    ]);
    for (const [name, gains] of Object.entries(EQ_PRESETS)) {
      expect(gains, name).toHaveLength(10);
      for (const gain of gains) {
        expect(gain).toBeGreaterThanOrEqual(EQ_GAIN_RANGE.min);
        expect(gain).toBeLessThanOrEqual(EQ_GAIN_RANGE.max);
      }
    }
    expect(EQ_PRESETS.voice).toEqual([-6, -4, -2, 0, 0, 2, 3, 3, 1, 0]);
    expect(EQ_PRESETS.telephone).toEqual([-12, -12, -12, -6, 0, 3, 3, 0, -12, -12]);
  });

  it("starts flat", () => {
    expect(defaultEqValue).toEqual({ preset: "flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  });

  it("fills every gain from a preset, as a copy", () => {
    const value = eqValueOfPreset("bass_boost");
    expect(value).toEqual({ preset: "bass_boost", gains: [6, 6, 4, 2, 0, 0, 0, 0, 0, 0] });
    value.gains[0] = 0;
    expect(EQ_PRESETS.bass_boost[0]).toBe(6);
  });
});

describe("buildEqFilter", () => {
  it("writes one peaking band per non-zero gain and ends with a peak-only limiter", () => {
    expect(buildEqFilter([6, 0, 0, 0, 0, 0, 0, 0, 0, -3], 48000)).toBe(
      `equalizer=f=31:t=o:w=1:g=6,equalizer=f=16000:t=o:w=1:g=-3,${LIMITER}`,
    );
  });

  it("leaves a flat curve to the limiter alone", () => {
    expect(buildEqFilter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 44100)).toBe(LIMITER);
  });

  it("skips a band at or above the source's Nyquist frequency", () => {
    expect(buildEqFilter([0, 0, 0, 0, 0, 0, 0, 0, 4, 4], 16000)).toBe(LIMITER);
    expect(buildEqFilter([0, 0, 0, 0, 0, 0, 0, 4, 0, 0], 16000)).toBe(
      `equalizer=f=4000:t=o:w=1:g=4,${LIMITER}`,
    );
  });

  it("reads an unknown sample rate as 48 kHz", () => {
    expect(buildEqFilter([0, 0, 0, 0, 0, 0, 0, 0, 0, 5], null)).toBe(
      `equalizer=f=16000:t=o:w=1:g=5,${LIMITER}`,
    );
  });
});
