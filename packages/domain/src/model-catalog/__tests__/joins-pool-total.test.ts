// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A model whose style slot joins its image pool keeps three of the upstream's
 * images for style (inner#826). The pool's cap is what the reader can @, so
 * the cap plus the style slot's has to equal what the upstream takes, or a
 * full pool plus full style slot is refused upstream.
 */

import { joinSlotFiles, missingSources } from "@breatic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";
import { modelsForMode } from "../mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/** What each upstream takes in its image list, from its WaveSpeed contract. */
const UPSTREAM_TOTAL: Readonly<Record<string, number>> = {
  "gpt-image-2.5-sunburst-edit": 16,
  "nano-banana-pro-edit-ultra": 14,
  "muse-image-edit": 10,
};

describe("a style slot joining an image pool", () => {
  const joining = getFullModelConfig("image").models.filter(
    (m) => typeof m.params?.style_images?.joins === "string",
  );

  it("is declared on exactly the models whose upstream total is known", () => {
    expect(joining.map((m) => m.name).sort()).toEqual(Object.keys(UPSTREAM_TOTAL).sort());
  });

  it.each(Object.entries(UPSTREAM_TOTAL))("leaves %s's upstream total exactly filled", (name, total) => {
    const model = joining.find((m) => m.name === name);
    const pool = model?.params?.images?.max_items ?? 0;
    const style = model?.params?.style_images?.max_items ?? 0;
    expect(pool + style).toBe(total);
  });
});

// The Agent judges a proposal by what the mode table says each model takes,
// so the table has to carry the reserved split, not the upstream total.
describe("what the Agent reads for a joining model", () => {
  beforeAll(() => {
    useFullCatalog();
  });
  afterAll(() => {
    restoreProcessEnv();
  });

  it.each(Object.entries(UPSTREAM_TOTAL))("gives %s's pool the total minus three, and three style places", (name, total) => {
    const answer = modelsForMode("image", "i2i");
    if (!answer.available) throw new Error("i2i is not served");
    const model = answer.models.find((m) => m.name === name);
    expect(model?.params.images?.maxItems).toBe(total - 3);
    expect(model?.params.style_images?.maxItems).toBe(3);
  });
});

/**
 * The video models whose style slot joins their image pool (inner#828): what
 * each upstream takes in that list, the mode the panel offers it under, and
 * how the second file in the list is named in the prompt.
 */
const VIDEO_JOINING: Readonly<Record<string, { total: number; mode: string; second: string }>> = {
  "seedance-2.5-text-to-video": { total: 30, mode: "t2v", second: "@image2" },
  "wan-3.0-reference-to-video": { total: 10, mode: "ref", second: "Image 2" },
  "minimax-h3-reference-to-video": { total: 9, mode: "ref", second: "<Picture 2>" },
  "gemini-omni-1.1-flash-reference-to-video": { total: 10, mode: "ref", second: "<IMAGE_REF_1>" },
  "happyhorse-1.1-reference-to-video": { total: 9, mode: "ref", second: "[Image 2]" },
};

describe("a video style slot joining an image pool", () => {
  const joining = getFullModelConfig("video").models.filter(
    (m) => typeof m.params?.style_images?.joins === "string",
  );

  it("is declared on exactly the models whose upstream total is known", () => {
    expect(joining.map((m) => m.name).sort()).toEqual(Object.keys(VIDEO_JOINING).sort());
  });

  it.each(Object.entries(VIDEO_JOINING))("leaves %s's upstream total exactly filled", (name, { total }) => {
    const model = joining.find((m) => m.name === name);
    const pool = model?.params?.images?.max_items ?? 0;
    const style = model?.params?.style_images?.max_items ?? 0;
    expect(style).toBe(3);
    expect(pool + style).toBe(total);
  });

  it.each(Object.entries(VIDEO_JOINING))("names %s's style file after the one mentioned picture", (name, { second }) => {
    const model = joining.find((m) => m.name === name);
    const run = joinSlotFiles(model?.params ?? {}, { images: ["a"], style_images: ["s"] }, "Go.");
    expect(run.params).toEqual({ images: ["a", "s"] });
    expect(run.prompt).toBe(`Go. Style references: ${second}. Apply their style to the result.`);
  });
});

describe("style images alone on a video model", () => {
  /**
   * The declarations the source rule reads, for one model.
   * @param name - The model's name.
   * @returns Its params and source groups.
   */
  const entry = (name: string) => {
    const model = getFullModelConfig("video").models.find((m) => m.name === name);
    if (!model) throw new Error(`${name} missing from the video catalog`);
    return { params: model.params ?? {}, source_groups: model.source_groups };
  };
  const styleOnly = { style_images: ["s1"] };

  it.each(["wan-3.0-reference-to-video", "minimax-h3-reference-to-video", "gemini-omni-1.1-flash-reference-to-video", "happyhorse-1.1-reference-to-video"])(
    "leave %s short of a reference",
    (name) => {
      expect(missingSources(entry(name), "ref", styleOnly)).not.toEqual([]);
    },
  );

  it("make a full text-to-video run on Seedance 2.5", () => {
    expect(missingSources(entry("seedance-2.5-text-to-video"), "t2v", styleOnly)).toEqual([]);
  });
});

describe("what the Agent reads for a joining video model", () => {
  beforeAll(() => {
    useFullCatalog();
  });
  afterAll(() => {
    restoreProcessEnv();
  });

  it.each(Object.entries(VIDEO_JOINING))("gives %s's pool the total minus three, and three style places", (name, { total, mode }) => {
    const answer = modelsForMode("video", mode);
    if (!answer.available) throw new Error(`${mode} is not served`);
    const model = answer.models.find((m) => m.name === name);
    expect(model?.params.images?.maxItems).toBe(total - 3);
    expect(model?.params.style_images?.maxItems).toBe(3);
  });
});
