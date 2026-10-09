// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upscale tool's sizes: each tier scales the source's long edge to its
 * own, the short edge keeping the source's proportion.
 */

import { describe, expect, it } from "vitest";

import { defaultSizeTier, miniToolById, sizeTierOptions, tieredParamKeys } from "@shared/mini-tools/derive.js";
import type { SizeTier } from "@shared/mini-tools/types.js";

/** The pinned model's declared range for the megapixel param. */
const LIMITS = { min: 1, max: 64 };

const TIERS: readonly SizeTier[] = [
  { label: "2K", longEdge: 2048 },
  { label: "4K", longEdge: 4096 },
  { label: "8K", longEdge: 8192 },
];

describe("sizeTierOptions", () => {
  it("scales the long edge to each tier and keeps the proportion", () => {
    const options = sizeTierOptions(TIERS, { width: 1024, height: 1536 }, LIMITS);
    expect(options.map((o) => [o.label, o.width, o.height, o.megapixels, o.usable])).toEqual([
      ["2K", 1365, 2048, 2.8, true],
      ["4K", 2731, 4096, 11.19, true],
      ["8K", 5461, 8192, 44.74, true],
    ]);
  });

  it("holds back a tier no longer than the source, which would not enlarge it", () => {
    const options = sizeTierOptions(TIERS, { width: 3000, height: 4000 }, LIMITS);
    expect(options.map((o) => o.usable)).toEqual([false, true, true]);
  });

  // The server refuses a value under the model's floor, so the panel must too.
  it("holds back a tier under the model's floor", () => {
    const options = sizeTierOptions(TIERS, { width: 1500, height: 300 }, LIMITS);
    expect(options.map((o) => o.usable)).toEqual([false, true, true]);
  });

  it("holds back a tier past the model's ceiling", () => {
    const options = sizeTierOptions(TIERS, { width: 4000, height: 4000 }, LIMITS);
    expect(options.map((o) => o.usable)).toEqual([false, true, false]);
  });
});

describe("defaultSizeTier", () => {
  it("picks 4K when it can be used", () => {
    expect(defaultSizeTier(sizeTierOptions(TIERS, { width: 1024, height: 1536 }, LIMITS))).toBe("4K");
  });

  it("falls back to the first usable tier", () => {
    expect(defaultSizeTier(sizeTierOptions(TIERS, { width: 5000, height: 4000 }, LIMITS))).toBe("8K");
  });

  it("answers nothing when no tier enlarges the source", () => {
    expect(defaultSizeTier(sizeTierOptions(TIERS, { width: 9000, height: 6000 }, LIMITS))).toBeUndefined();
  });
});

describe("tieredParamKeys", () => {
  it("names the params a tool measures as output sizes", () => {
    expect(tieredParamKeys(miniToolById("image.upscale")!)).toEqual(["target_megapixels"]);
    expect(tieredParamKeys(miniToolById("video.cut")!)).toEqual([]);
  });
});
