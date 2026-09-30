// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which storyboard tier a run actually uses: the stored one only while the
 * current model takes a storyboard, otherwise off (#2218).
 */

import { describe, it, expect } from "vitest";
import { effectiveStoryboardKind, storyboardSpec } from "@shared/storyboard.js";
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
      totalParam: "duration",
      maxShots: 6,
      maxChars: 512,
    });
  });

  it("is absent for a model with no storyboard", () => {
    expect(storyboardSpec(other)).toBeUndefined();
  });
});
