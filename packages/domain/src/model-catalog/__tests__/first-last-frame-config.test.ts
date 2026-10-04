// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { missingSources } from "@breatic/shared";

import { getFullModelConfig } from "../model-catalog.js";


const MODES_YAML = resolve(
  import.meta.dirname,
  "../../../../../config/models/modes.yaml",
);

/** The image-to-video models that also take an end frame (config/models/video/*.yaml). */
const FIRST_LAST_MODELS = [
  "gemini-omni-1.1-flash-image-to-video",
  "minimax-h3-image-to-video",
  "wan-3.0-image-to-video",
  "seedance-2.5-image-to-video",
];

beforeAll(() => {
  initCore(process.env);
});

describe("first-last frame config wiring (#1904)", () => {
  it.each(FIRST_LAST_MODELS)("%s asks for both frames in first_last and one in i2v", (name) => {
    const model = getFullModelConfig("video").models.find((m) => m.name === name);
    if (!model) throw new Error(`${name} missing from the video catalog`);
    const entry = { params: model.params ?? {}, source_groups: model.source_groups };
    expect(missingSources(entry, "first_last", {})).toEqual([["image"], ["end_image"]]);
    expect(missingSources(entry, "i2v", {})).toEqual([["image"]]);
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

  it("declares the mode on every model listed as running it", () => {
    const config = getFullModelConfig("video");
    for (const name of FIRST_LAST_MODELS) {
      const model = config.models.find((m) => m.name === name);
      expect(model, `${name} missing from the video catalog`).toBeTruthy();
      const modes = Array.isArray(model!.mode) ? model!.mode : [model!.mode];
      expect(modes, `${name} should still offer image-to-video`).toContain("i2v");
      expect(modes, `${name} should offer first-last frame`).toContain("first_last");
    }
  });

  it("keeps the end frame declared as a param on every one of them", () => {
    // The slot's URL travels as `end_image`; a model that stopped declaring it
    // would have it dropped by validateParams before the family ever saw it.
    const config = getFullModelConfig("video");
    for (const name of FIRST_LAST_MODELS) {
      const model = config.models.find((m) => m.name === name);
      expect(Object.keys(model!.params ?? {}), name).toContain("end_image");
    }
  });
});
