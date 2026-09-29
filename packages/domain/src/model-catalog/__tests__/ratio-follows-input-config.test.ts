// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The output shape of a model that works from an input image (#2156).
 *
 * Sent no aspect ratio, each of these upstreams answers in the shape of the
 * image it was given: the edit and image-to-video schemas say so for two of
 * them, and a real run on 2026-09-29 showed it for the other three (a 3:4
 * input came back 3:4, two 9:16 frames came back 9:16). A fixed ratio as the
 * default would reshape the reader's picture, so each one starts on "auto" and
 * sends nothing for it.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig } from "../model-catalog.js";

const FOLLOWS_INPUT = [
  { category: "image", name: "gpt-image-2.5-sunburst-edit" },
  { category: "image", name: "muse-image-edit" },
  { category: "image", name: "nano-banana-pro-edit-ultra" },
  { category: "video", name: "wan-3.0-image-to-video" },
  { category: "video", name: "flux-3-start-end-to-video" },
] as const;

beforeAll(() => {
  initCore(process.env);
});

describe("a model whose upstream follows the input image's shape", () => {
  it.each(FOLLOWS_INPUT)("$name starts on auto and sends no ratio for it", ({ category, name }) => {
    const model = getFullModelConfig(category).models.find((m) => m.name === name);
    if (!model) throw new Error(`${name} missing from the ${category} catalog`);
    const ratio = model.params?.aspect_ratio;
    expect(ratio?.values?.[0]).toBe("auto");
    expect(ratio?.default).toBe("auto");
    expect(ratio?.absent_value).toBe("auto");
  });
});
