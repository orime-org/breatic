// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How each pool writes its chips into the prompt, read off the real config
 * (#2156, design §13.2). The spellings come from each vendor's own prompt
 * guide where it publishes one; a pool left out of this table would send a
 * chip as nothing, which the model then cannot point at.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

/** Bucket, model, pool param, and the mention the design table fixes. */
const MENTIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["video", "seedance-2.5-text-to-video", "images", "@image{n}"],
  ["video", "seedance-2.5-text-to-video", "videos", "@video{n}"],
  ["video", "seedance-2.5-text-to-video", "audios", "@audio{n}"],
  ["video", "kling-video-o3-4k-image-to-video", "elements", "Element {n}"],
  ["video", "minimax-h3-reference-to-video", "images", "<Picture {n}>"],
  ["video", "minimax-h3-reference-to-video", "videos", "<Video {n}>"],
  ["video", "minimax-h3-reference-to-video", "audios", "<Audio {n}>"],
  ["video", "gemini-omni-1.1-flash-reference-to-video", "images", "<IMAGE_REF_{i}>"],
  ["video", "gemini-omni-1.1-flash-reference-to-video", "videos", "the reference video {n}"],
  ["video", "wan-3.0-reference-to-video", "images", "Image {n}"],
  ["video", "wan-3.0-reference-to-video", "videos", "Video {n}"],
  ["video", "wan-3.0-reference-to-video", "audios", "Audio {n}"],
  ["video", "happyhorse-1.1-reference-to-video", "images", "[Image {n}]"],
  ["image", "gpt-image-2.5-sunburst-edit", "images", "image {n}"],
  ["image", "muse-image-edit", "images", "image {n}"],
  ["image", "nano-banana-pro-edit-ultra", "images", "image {n}"],
  ["image", "qwen-image-edit-multiple-angles", "images", "image {n}"],
];

describe("pool mentions in the real catalog", () => {
  it.each(MENTIONS)("%s %s writes %s chips as %s", (bucket, model, param, mention) => {
    const entry = getFullModelConfig(bucket).models.find((m) => m.name === model);
    expect(entry?.params?.[param]?.mention).toBe(mention);
  });

  it("names every pool the catalog declares", () => {
    const listed = new Set(MENTIONS.map(([, model, param]) => `${model}.${param}`));
    const pools = ["image", "video"].flatMap((bucket) =>
      getFullModelConfig(bucket).models.flatMap((m) =>
        Object.entries(m.params ?? {})
          .filter(([, spec]) => spec.fill === "pool")
          .map(([param]) => `${m.name}.${param}`),
      ),
    );
    expect(pools.sort()).toEqual([...listed].sort());
  });
});
