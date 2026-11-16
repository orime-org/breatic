// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The languages a model's voice samples speak reach the panel with the model (#1521), so the voice list can offer
 * them from the moment it opens.
 */

import { describe, expect, it } from "vitest";

import { modelCatalogSchema } from "@shared/types/model-catalog.js";

/**
 * Parses one tts entry carrying the given sample languages.
 * @param sample_languages - What the entry carries.
 * @returns The parsed entry.
 */
const parse = (sample_languages: unknown): Record<string, unknown> => {
  const catalog = modelCatalogSchema.parse({
    tts: [
      {
        name: "m",
        display_name: "M",
        modality: "tts",
        mode: "tts",
        description: "",
        guide: "",
        tier: "optional",
        generation_time: 60,
        params: {},
        availability: { upstreams: [] },
        takes_prompt: true,
        sample_languages,
      },
    ],
  });
  return catalog.tts[0] as unknown as Record<string, unknown>;
};

describe("sample languages on the wire", () => {
  it("keeps the tags a model sends", () => {
    expect(parse(["en", "ja", "zh"]).sample_languages).toEqual(["en", "ja", "zh"]);
  });

  it("reads a malformed list as none, so the panel offers no picker", () => {
    expect(parse("en").sample_languages).toBeUndefined();
    expect(parse([1, 2]).sample_languages).toBeUndefined();
  });
});
