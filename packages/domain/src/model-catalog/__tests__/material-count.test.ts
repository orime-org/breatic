// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many pieces of material a run asks its reader for (#269).
 *
 * Both layers answer: the model says which of its parameters are slots and
 * which of those may be left empty, and the mode says whether every slot has
 * to hold something or any one of them is enough. Neither alone is the count
 * -- a2m offers three slots and takes one, which no per-parameter field says.
 */

import { GENERATION_NODE_BUCKETS, MODE_MATERIAL_COUNT } from "@breatic/shared";
import type { GenerationNodeType } from "@breatic/shared";
import { describe, it, expect } from "vitest";

import { materialCount } from "../material-count.js";
import { getFullModelConfig } from "../model-catalog.js";
import { getModeConfig } from "../mode-config.js";

describe("the count of material a mode asks for", () => {
  it("matches what the panels ask for today, a2m included", () => {
    const config = getModeConfig();
    const disagreeing: string[] = [];
    for (const [node, buckets] of Object.entries(GENERATION_NODE_BUCKETS)) {
      const expected = MODE_MATERIAL_COUNT[node as GenerationNodeType];
      for (const bucket of buckets) {
        for (const model of getFullModelConfig(bucket).models) {
          const modes = Array.isArray(model.mode) ? model.mode : [model.mode];
          for (const mode of modes) {
            if (!mode || !(mode in expected)) continue;
            const got = materialCount(model, mode, config[bucket]?.[mode]);
            if (got !== expected[mode]) {
              disagreeing.push(`${model.name}.${mode}: ${String(got)} ≠ ${String(expected[mode])}`);
            }
          }
        }
      }
    }

    expect(disagreeing).toEqual([]);
  });

  it("asks for one piece where the mode takes any one of its slots", () => {
    const anyOf = { label: "x", description: "", sources: ["audio"] as const, sourceRule: "any_of" as const };
    const model = {
      name: "three-slots",
      mode: "a2m",
      params: {
        song: { fill: "canvas", accepts: "audio" },
        voice: { fill: "canvas", accepts: "audio" },
        instrumental: { fill: "canvas", accepts: "audio" },
      },
    };

    expect(materialCount(model, "a2m", anyOf)).toBe(1);
    expect(materialCount(model, "a2m", { ...anyOf, sourceRule: "all_of" })).toBe(3);
  });

  it("skips a slot the reader may leave empty", () => {
    const rule = { label: "x", description: "", sources: ["image"] as const, sourceRule: "all_of" as const };
    const model = {
      name: "one-optional",
      mode: "ref",
      params: {
        images: { fill: "pool", accepts: "image" },
        video: { fill: "canvas", accepts: "video", optional: true },
      },
    };

    expect(materialCount(model, "ref", rule)).toBe(1);
  });
});
