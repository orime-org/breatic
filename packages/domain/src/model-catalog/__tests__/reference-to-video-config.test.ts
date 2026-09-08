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
import {
  computeSourcesByMode,
  violatesSourceRequirement,
} from "../source-requirement.js";


/** The model that runs reference-to-video (config/models/video/kling.yaml). */
const REF_MODEL = "kling-o3-pro-ref";

/** What the upstream `kwaivgi/kling-video-o3-pro/reference-to-video` accepts. */
const UPSTREAM_MAX_IMAGES = 7;
/** What the same endpoint allows once a reference video rides along (#1928). */
const UPSTREAM_MAX_IMAGES_WITH_VIDEO = 4;

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
    // The model's own declarations, because that is the second question the
    // gate asks (#1960): a carrier field this model does not declare reaches
    // the upstream as nothing, so it cannot satisfy the requirement. Handing
    // it every field in the vocabulary would answer that question yes for all
    // of them and check only the first half of the rule.
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    const declared = new Set(Object.keys(model!.params ?? {}));
    expect(declared.has("images"), `${REF_MODEL} declares images`).toBe(true);
    expect(violatesSourceRequirement(sources, { prompt: "x" }, declared)).toBe(true);
    expect(
      violatesSourceRequirement(sources, { prompt: "x", images: ["https://cdn/a.png"] }, declared),
    ).toBe(false);
  });

  it("caps the reference images where the upstream does", () => {
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    expect(model!.params?.["images"]?.max_items).toBe(UPSTREAM_MAX_IMAGES);
  });

  it("says both numbers in the prose the agent reads", () => {
    // `max_items` and `max_items_when_present` are both dropped by the catalog
    // projection, so these two sentences are the whole of what an agent knows
    // about either cap — and it now needs both, because it also sees the
    // `video` param and will reach for it.
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    for (const prose of [model!.guide, model!.params?.["images"]?.description]) {
      expect(typeof prose).toBe("string");
      expect(prose).toContain(`1-${UPSTREAM_MAX_IMAGES}`);
      expect(prose).toContain(`1-${UPSTREAM_MAX_IMAGES_WITH_VIDEO}`);
    }
  });

  it("takes one optional reference video for motion guidance (#1928)", () => {
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    // A string upstream, so one clip: the panel offers it through a slot, and
    // a declared default is what keeps the worker from dropping the key.
    expect(model!.params).toHaveProperty("video");
    expect(model!.params?.["video"]?.type).toBeUndefined();
  });

  it("drops the image cap to four while that video rides along (#1928)", () => {
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    expect(model!.params?.["images"]?.max_items_when_present).toEqual({
      video: UPSTREAM_MAX_IMAGES_WITH_VIDEO,
    });
  });

  it("lets the user keep or drop that video's own sound (#1928)", () => {
    // Upstream defaults it ON, so a run without the switch would carry the
    // reference clip's audio into the result with no way to say otherwise.
    const model = getFullModelConfig("video").models.find((m) => m.name === REF_MODEL);
    expect(model!.params?.["keep_original_sound"]?.default).toBe(true);
    expect(model!.params?.["keep_original_sound"]?.values).toEqual([true, false]);
  });

  it("leaves no copy of the old figure anywhere in the file", () => {
    // Three places said 1-9. Two of them are prose, which no schema checks, so
    // the only guard against one being missed is looking at the whole file.
    expect(readFileSync(KLING_YAML, "utf8")).not.toContain("1-9");
  });
});
