// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many pieces of material a run asks its reader for (#269, #2156).
 *
 * Read off the model alone: each slot or pool it does not mark optional is one
 * piece, and each "one of these" group it declares for the mode is one more.
 */

import { describe, it, expect } from "vitest";

import { materialCount } from "../material-count.js";

describe("the count of material a mode asks for", () => {
  it("asks for one piece where the model takes any one of a group", () => {
    const model = {
      params: {
        song: { fill: "canvas", optional: true },
        voice: { fill: "canvas", optional: true },
        melody: { fill: "canvas", optional: true },
      },
      source_groups: [{ mode: "a2m", any_of: ["song", "voice", "melody"] }],
    };

    expect(materialCount(model, "a2m")).toBe(1);
    expect(materialCount(model, "t2m")).toBe(0);
  });

  it("counts each required slot and skips one the reader may leave empty", () => {
    const model = {
      params: {
        image: { fill: "canvas" },
        audio: { fill: "canvas" },
        video: { fill: "canvas", optional: true },
      },
    };

    expect(materialCount(model, "talking_head")).toBe(2);
  });
});
