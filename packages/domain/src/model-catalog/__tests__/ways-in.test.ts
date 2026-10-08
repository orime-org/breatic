// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a node wired into a model goes and what mark the reader is asked
 * for there (inner#977, design 5.7 table A), over every model the catalog
 * serves.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { canConnect, GENERATION_NODE_MODES, PANEL_EDITOR_PARAM, type GenerationNodeType } from "@breatic/shared";

import { modelsForMode, waysIn, type ModelInfo } from "../mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeEach(useFullCatalog);
afterAll(restoreProcessEnv);

/**
 * Every model the catalog serves, once per mode it serves.
 * @returns The models.
 */
function everyModel(): ModelInfo[] {
  return (Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]).flatMap((nodeType) =>
    GENERATION_NODE_MODES[nodeType].flatMap((mode) => {
      const answer = modelsForMode(nodeType, mode);
      return answer.available ? answer.models : [];
    }),
  );
}

/**
 * One model of one mode.
 * @param nodeType - The node type.
 * @param mode - The mode.
 * @param name - The model name.
 * @returns The model.
 * @throws {Error} When the catalog does not serve it.
 */
function model(nodeType: GenerationNodeType, mode: string, name: string): ModelInfo {
  const answer = modelsForMode(nodeType, mode);
  const found = answer.available ? answer.models.find((m) => m.name === name) : undefined;
  if (!found) throw new Error(`the catalog does not serve ${name} in ${mode}`);
  return found;
}

describe("the ways a model takes each kind of node", () => {
  it("asks for an asset mark on the pool and a note on every slot and the lyrics box", () => {
    for (const chosen of everyModel()) {
      for (const [, ways] of waysIn(chosen)) {
        for (const way of ways) {
          const expected = way.into === "pool" ? "asset" : "note";
          expect({ model: chosen.name, into: way.into, mark: way.mark }).toEqual({ model: chosen.name, into: way.into, mark: expected });
        }
      }
    }
  });

  it("gives words the prompt where the model draws a box, and the lyrics box where it has one", () => {
    for (const chosen of everyModel()) {
      const text = (waysIn(chosen).get("text") ?? []).map((way) => way.into);
      const expected = [
        ...(chosen.takesPrompt ? ["pool"] : []),
        ...(chosen.params[PANEL_EDITOR_PARAM] !== undefined ? [PANEL_EDITOR_PARAM] : []),
      ];
      expect({ model: chosen.name, text }).toEqual({ model: chosen.name, text: expected });
    }
  });

  it("gives no pool to a kind the canvas will not let feed the node", () => {
    for (const chosen of everyModel()) {
      for (const [kind, ways] of waysIn(chosen)) {
        if (canConnect(kind, chosen.nodeType)) continue;
        expect({ model: chosen.name, kind, pool: ways.some((way) => way.into === "pool") }).toEqual({ model: chosen.name, kind, pool: false });
      }
    }
  });

  it("gives no pool to a model drawing no prompt box", () => {
    for (const chosen of everyModel().filter((m) => !m.takesPrompt)) {
      for (const [, ways] of waysIn(chosen)) {
        expect(ways.filter((way) => way.into === "pool")).toEqual([]);
      }
    }
  });

  it("reads the rows of the table off real models", () => {
    expect(waysIn(model("image", "i2i", "nano-banana-pro-edit-ultra")).get("image")).toEqual([
      { into: "pool", room: 11, mark: "asset" },
      { into: "style_images", room: 3, mark: "note" },
    ]);
    expect(waysIn(model("audio", "t2m", "mureka-v9.5-generate-song")).get("text")).toEqual([
      { into: "pool", room: Number.POSITIVE_INFINITY, mark: "asset" },
      { into: "lyrics", room: Number.POSITIVE_INFINITY, mark: "note" },
    ]);
    expect(waysIn(model("video", "i2v", "seedance-2.5-image-to-video")).get("image")).toEqual([
      { into: "image", room: 1, mark: "note" },
    ]);
    expect(waysIn(model("audio", "sfx", "hunyuan-video-foley")).get("video")).toEqual([
      { into: "video", room: 1, mark: "note" },
    ]);
    expect(waysIn(model("video", "talking_head", "omnihuman-1.5")).get("text")).toBeUndefined();
  });
});
