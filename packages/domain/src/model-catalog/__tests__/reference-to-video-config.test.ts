// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reference-to-video config wiring (#1927).
 *
 * The one model that runs the mode, `kling-o3-pro-ref`, states its reference
 * cap in THREE places: the `max_items` the gates read, and two sentences of
 * English prose (`guide` and `description`). All three said 1-9 while the
 * upstream WaveSpeed endpoint takes at most 7.
 *
 * Fixing only `max_items` would leave the file contradicting itself in a way
 * that matters: `listAvailableModels` projects `type` / `values` / `default` /
 * `description` to the agent and drops `max_items` entirely, so for an agent
 * choosing how many images to send, that prose is the ONLY statement of the
 * cap it can see. It would keep sending 8 and keep being refused.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";
import { computeSourcesByMode, violatesSourceRequirement } from "../source-requirement.js";

/** The model that runs reference-to-video (config/models/video/kling.yaml). */
const REF_MODEL = "kling-o3-pro-ref";

/** What the upstream `kwaivgi/kling-video-o3-pro/reference-to-video` accepts. */
const UPSTREAM_MAX_IMAGES = 7;

const KLING_YAML = resolve(
  import.meta.dirname,
  "../../../../../config/models/video/kling.yaml",
);

beforeAll(() => {
  initCore(process.env);
});

describe("reference-to-video config wiring (#1927)", () => {
  it("declares the mode on the model that runs it", () => {
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    expect(model, `${REF_MODEL} missing from the video catalog`).toBeTruthy();
    const modes = Array.isArray(model!.mode) ? model!.mode : [model!.mode];
    expect(modes).toContain("ref");
  });

  it("requires an image for the mode", () => {
    // The panel refuses a submit with nothing @-mentioned; this is the second
    // half of that, checked server-side before anything is billed.
    expect(computeSourcesByMode("video", "ref")).toEqual({ ref: ["image"] });
  });

  it("refuses a reference task carrying no images", () => {
    const sources = computeSourcesByMode("video", "ref");
    expect(violatesSourceRequirement(sources, { prompt: "x" })).toBe(true);
    expect(
      violatesSourceRequirement(sources, { prompt: "x", images: ["https://cdn/a.png"] }),
    ).toBe(false);
  });

  it("caps the reference images where the upstream does", () => {
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    expect(model!.params?.["images"]?.max_items).toBe(UPSTREAM_MAX_IMAGES);
  });

  it("says the same number in the prose the agent reads", () => {
    // `max_items` is dropped by the catalog projection, so these two sentences
    // are the whole of what an agent knows about the cap.
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    for (const prose of [model!.guide, model!.params?.["images"]?.description]) {
      expect(typeof prose).toBe("string");
      expect(prose).toContain(`1-${UPSTREAM_MAX_IMAGES}`);
    }
  });

  it("leaves no copy of the old figure anywhere in the file", () => {
    // Three places said 1-9. Two of them are prose, which no schema checks, so
    // the only guard against one being missed is looking at the whole file.
    expect(readFileSync(KLING_YAML, "utf8")).not.toContain("1-9");
  });
});
