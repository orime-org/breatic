// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * First-last frame config wiring (#1904).
 *
 * The mode already existed on the frontend (`VIDEO_GENERATION_MODES`) while
 * three config-side pieces were missing: the mode definition, its source
 * requirement, and the two models that can actually run it. These tests pin
 * all three against the real config, because the pieces only work together —
 * declaring the mode on a model without adding its row to the source
 * requirement table takes that model's source gate down entirely, since the
 * table reads "absent means this mode needs nothing".
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { initCore } from "@breatic/core";
import { parse } from "yaml";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";
import {
  computeSourcesByMode,
  violatesSourceRequirement,
} from "../source-requirement.js";

const MODES_YAML = resolve(
  import.meta.dirname,
  "../../../../../config/models/modes.yaml",
);

/** The two models that carry an end frame (config/models/video/*.yaml). */
const FIRST_LAST_MODELS = ["kling-o3-pro-i2v", "seedance-1.5-pro-i2v"];

beforeAll(() => {
  initCore(process.env);
});

describe("first-last frame config wiring (#1904)", () => {
  it("requires an image for the mode", () => {
    expect(computeSourcesByMode("video", "first_last")).toEqual({
      first_last: ["image"],
    });
  });

  it("keeps the source gate up for a model that offers both modes", () => {
    // Without a row of its own, `first_last` would resolve to "needs
    // nothing", and one source-less mode lets the whole model through — the
    // image-to-video half would stop asking for a first frame too.
    const sources = computeSourcesByMode("video", ["i2v", "first_last"]);
    expect(violatesSourceRequirement(sources, { prompt: "x" })).toBe(true);
    expect(
      violatesSourceRequirement(sources, { prompt: "x", image: "https://cdn/a.png" }),
    ).toBe(false);
  });

  it("defines the mode in modes.yaml, where the agent reads its mode list", () => {
    const modes = parse(readFileSync(MODES_YAML, "utf8")) as Record<
      string,
      { modes?: Record<string, { label?: string; description?: string }> }
    >;
    const firstLast = modes.video?.modes?.first_last;
    expect(firstLast).toBeTruthy();
    expect(typeof firstLast!.label).toBe("string");
    expect(firstLast!.description?.trim().length).toBeGreaterThan(0);
  });

  it("declares the mode on both models that can run it", () => {
    const config = getFullModelConfig("video");
    for (const name of FIRST_LAST_MODELS) {
      const model = config.models.find((m) => m.name === name);
      expect(model, `${name} missing from the video catalog`).toBeTruthy();
      const modes = Array.isArray(model!.mode) ? model!.mode : [model!.mode];
      expect(modes, `${name} should still offer image-to-video`).toContain("i2v");
      expect(modes, `${name} should offer first-last frame`).toContain("first_last");
    }
  });

  it("keeps the end frame declared as a param on both models", () => {
    // The slot's URL travels as `end_image`; a model that stopped declaring it
    // would have it dropped by validateParams before the family ever saw it.
    const config = getFullModelConfig("video");
    for (const name of FIRST_LAST_MODELS) {
      const model = config.models.find((m) => m.name === name);
      expect(Object.keys(model!.params ?? {}), name).toContain("end_image");
    }
  });
});
