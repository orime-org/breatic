// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reference pool, one place per kind a model takes (#2156, design §13).
 */

import { describe, expect, it } from "vitest";

import { referencePool } from "@shared/reference-pool";
import type { ParamDescriptor } from "@shared/types/model-catalog";

/**
 * A model declaring the given params.
 * @param params - What it declares.
 * @returns Just the part the pool reads.
 */
function model(params: Record<string, ParamDescriptor>): { params: Record<string, ParamDescriptor> } {
  return { params };
}

const pool = (accepts: ParamDescriptor["accepts"], extra: Partial<ParamDescriptor> = {}): ParamDescriptor => ({
  description: "",
  default: null,
  fill: "pool",
  accepts,
  ...extra,
});

describe("referencePool", () => {
  it("names the param and cap of each kind the model takes", () => {
    const seedance = model({
      images: pool("image", { max_items: 30 }),
      videos: pool("video", { max_items: 10 }),
      audios: pool("audio", { max_items: 10 }),
    });
    expect(referencePool(seedance, "t2v")).toEqual({
      image: { param: "images", cap: 30 },
      video: { param: "videos", cap: 10 },
      audio: { param: "audios", cap: 10 },
    });
  });

  it("follows the model's own name for its image pool", () => {
    // Kling O3 builds its elements out of the pool's pictures.
    expect(referencePool(model({ elements: pool("image", { max_items: 3 }) }), "i2v")).toEqual({
      image: { param: "elements", cap: 3 },
    });
  });

  it("carries how the model writes a chip of each kind", () => {
    const m = model({
      images: pool("image", { mention: "<Picture {n}>" }),
      videos: pool("video"),
    });
    expect(referencePool(m, "r2v")).toEqual({
      image: { param: "images", cap: undefined, mention: "<Picture {n}>" },
      video: { param: "videos", cap: undefined, mention: undefined },
    });
  });

  it("leaves out a pool the mode does not use, and anything filled another way", () => {
    const m = model({
      images: pool("image", { modes: ["i2i"] }),
      image: { description: "", default: null, fill: "canvas", accepts: "image" },
    });
    expect(referencePool(m, "t2i")).toEqual({});
    expect(referencePool(m, "i2i")).toEqual({ image: { param: "images", cap: undefined } });
    expect(referencePool(undefined, "i2i")).toEqual({});
  });
});
