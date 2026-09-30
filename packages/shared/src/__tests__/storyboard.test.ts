// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which storyboard tier a run actually uses: the stored one only while the
 * current model takes a storyboard, otherwise off (#2218).
 */

import { describe, it, expect } from "vitest";
import { effectiveStoryboardKind, storyboardParams, storyboardSpec } from "@shared/storyboard.js";
import type { ParamDescriptor } from "@shared/types/model-catalog.js";

const kling: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, values: [3, 4, 5], fill: "panel" },
  multi_prompt: {
    description: "",
    default: null,
    type: "items",
    max_items: 6,
    fill: "storyboard",
    fields: { prompt: { type: "text", max_chars: 512 }, duration: { values: [1, 2, 3] } },
  },
  shot_type: { description: "", default: null, values: ["intelligence", "customize"], fill: "storyboard" },
};
const other: Record<string, ParamDescriptor> = {
  duration: { description: "", default: 5, values: [5, 10], fill: "panel" },
};

describe("the effective storyboard tier", () => {
  it("is the stored tier on a model that takes a storyboard", () => {
    expect(effectiveStoryboardKind(kling, "custom")).toBe("custom");
    expect(effectiveStoryboardKind(kling, "auto")).toBe("auto");
    expect(effectiveStoryboardKind(kling, "off")).toBe("off");
  });

  it("is off on a model that takes none, whatever was stored", () => {
    expect(effectiveStoryboardKind(other, "custom")).toBe("off");
    expect(effectiveStoryboardKind(other, "auto")).toBe("off");
  });

  it("is off when nothing was stored", () => {
    expect(effectiveStoryboardKind(kling, undefined)).toBe("off");
  });
});

describe("what a model says about its storyboard", () => {
  it("reads the shot cap, the per-shot character cap and both param names", () => {
    expect(storyboardSpec(kling)).toEqual({
      shotsParam: "multi_prompt",
      tierParam: "shot_type",
      secondsField: "duration",
      totalParam: "duration",
      maxShots: 6,
      maxChars: 512,
    });
  });

  it("is absent for a model with no storyboard", () => {
    expect(storyboardSpec(other)).toBeUndefined();
  });
});

describe("the params a storyboard sends", () => {
  const spec = storyboardSpec(kling)!;
  const shots = [
    { prompt: "a paper boat", duration: 2 },
    { prompt: "the pond at dusk", duration: 3 },
  ];

  it("sends nothing when off", () => {
    expect(storyboardParams(spec, "off", shots)).toEqual({});
  });

  it("names the automatic tier and sends no shots", () => {
    expect(storyboardParams(spec, "auto", shots)).toEqual({ shot_type: "intelligence" });
  });

  it("sends each shot's words and seconds under the per-shot tier", () => {
    expect(storyboardParams(spec, "custom", shots)).toEqual({
      shot_type: "customize",
      multi_prompt: [
        { prompt: "a paper boat", duration: 2 },
        { prompt: "the pond at dusk", duration: 3 },
      ],
    });
  });
});
