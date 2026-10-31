// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { DENOISE_NOISE_FLOOR_DB, denoiseReductionDb } from "@shared/audio-denoise.js";

// inner#1305: the denoise slider is how far the noise comes down, 0.4 dB a
// step; the panel reads it and the container's filter is built from it.
describe("denoiseReductionDb", () => {
  it.each([
    [1, 0.4],
    [50, 20],
    [73, 29.2],
    [100, 40],
  ])("reads strength %d as %d dB", (intensity, db) => {
    expect(denoiseReductionDb(intensity)).toBe(db);
  });

  it("holds the noise floor where common noise sits and speech does not", () => {
    expect(DENOISE_NOISE_FLOOR_DB).toBe(-40);
  });
});
