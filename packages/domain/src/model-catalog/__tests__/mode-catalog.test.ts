// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which modes a generation node can actually be set to (#261).
 *
 * Two conditions, and the point of the tests is that BOTH are load-bearing:
 * the panel has to offer the mode, and the catalog has to back it right now.
 * Dropping either one reports a mode the user cannot select -- a mini-tool
 * mode that no picker lists, or a mode whose models are all unreachable.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { GENERATION_NODE_MODES } from "@breatic/shared";
import type { GenerationNodeType, ModelEntry } from "@breatic/shared";

import { getModelCatalog } from "../model-catalog.js";

import {
  getCanvasCapabilities,
  modelsForMode,
  usableModes,
  type CanvasCapabilities,
} from "../mode-catalog.js";
import {
  allProviderKeyNames,
  restoreProcessEnv,
  useEnvWithKeys,
  useFullCatalog,
} from "./catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("usableModes", () => {
  it("reports a mode the panel offers and a model backs", () => {
    expect(usableModes(["t2i"], [{ mode: "t2i" }])).toEqual(["t2i"]);
  });

  it("drops a mode the panel offers that no model backs", () => {
    // The six image modes of #259 are exactly this shape: declared in
    // modes.yaml, zero models behind them.
    expect(usableModes(["t2i", "relight"], [{ mode: "t2i" }])).toEqual(["t2i"]);
  });

  it("drops a mode models back that the panel does not offer", () => {
    // `edit` / `upscale` / `remove_bg` have models and are mini-tool
    // operations: selecting one on a generation node is not something the
    // picker allows, and the backend source gate rejects the submit.
    expect(usableModes(["t2i"], [{ mode: "t2i" }, { mode: "upscale" }])).toEqual(["t2i"]);
  });

  it("counts every mode a multi-mode model declares", () => {
    expect(usableModes(["t2i", "i2i"], [{ mode: ["i2i", "edit"] }])).toEqual(["i2i"]);
  });

  it("keeps the panel's order rather than the catalog's", () => {
    expect(usableModes(["t2i", "i2i"], [{ mode: "i2i" }, { mode: "t2i" }])).toEqual([
      "t2i",
      "i2i",
    ]);
  });

  it("reports nothing when the catalog backs none of the panel's modes", () => {
    expect(usableModes(["t2i", "i2i"], [])).toEqual([]);
  });
});

describe("getCanvasCapabilities", () => {
  it("answers for the three generation nodes and no others", () => {
    // What "only modes the picker offers" rests on: the answer is built by
    // filtering each node's panel list, and the filter cannot invent a code.
    // What it cannot rest on is the set of nodes, which is written out here.
    expect(Object.keys(GENERATION_NODE_MODES)).toEqual(["image", "video", "audio"]);
    for (const node of withEveryProviderKey()) {
      expect(GENERATION_NODE_MODES, `${node.nodeType} is a generation node`).toHaveProperty(
        node.nodeType,
      );
    }
  });

  it("gives every reported mode a label and a one-line description", () => {
    const capabilities = withEveryProviderKey();
    for (const node of capabilities) {
      for (const mode of node.modes) {
        expect(mode.label.length, `${mode.mode} label`).toBeGreaterThan(0);
        expect(mode.what.length, `${mode.mode} description`).toBeGreaterThan(0);
        expect(mode.what, `${mode.mode} description is one line`).not.toContain("\n");
      }
    }
  });

  it("draws the audio node from both the tts and audio catalog buckets", () => {
    const reported = modesOfNode(withEveryProviderKey(), "audio");
    // `tts` is declared in config/models/tts, `t2m` in config/models/audio;
    // one picker offers both, so one bucket alone cannot answer for the node.
    expect(reported).toContain("tts");
    expect(reported).toContain("t2m");
  });

  it("follows the catalog: a node whose models are all unreachable disappears", () => {
    useEnvWithKeys([]);
    expect(getCanvasCapabilities()).toEqual([]);
  });

  it("follows the catalog: revoking one provider's key takes its models with it", () => {
    // A subset assertion against the full answer holds even for code that
    // ignores keys entirely -- measured: with only the first key configured
    // the answer is byte-identical to the all-keys one. So this subtracts a
    // key whose models nothing else backs, and names what has to disappear.
    const withoutFish = allProviderKeyNames().filter((name) => name !== "FISH_API_KEY");
    useEnvWithKeys(withoutFish);
    const answer = modelsForMode("audio", "tts");
    expect(answer.available, "other models still serve tts").toBe(true);
    if (!answer.available) return;
    expect(
      answer.models.map((model) => model.name),
      "fish-s2-pro is served by fish alone",
    ).not.toContain("fish-s2-pro");

    useEnvWithKeys(allProviderKeyNames());
    const withFish = modelsForMode("audio", "tts");
    expect(withFish.available && withFish.models.map((model) => model.name)).toContain(
      "fish-s2-pro",
    );
  });

  it("follows the catalog: a mode whose only models go, goes too", () => {
    const both = ["WAVESPEED_API_KEY"];
    useEnvWithKeys(allProviderKeyNames());
    expect(
      modesOfNode(getCanvasCapabilities(), "audio"),
      "a2m is offered while its models are reachable",
    ).toContain("a2m");

    useEnvWithKeys(allProviderKeyNames().filter((name) => !both.includes(name)));
    expect(
      modesOfNode(getCanvasCapabilities(), "audio"),
      "both music models are wavespeed-only",
    ).not.toContain("a2m");
  });
});

describe("what the answer is built out of", () => {
  it("names no model of its own", () => {
    // Every model reaching an answer comes from the catalog this deployment
    // can serve. A name written into the code serves a model whether or not
    // its provider key is set, and the key tests stay green because they
    // only watch one name disappear.
    useFullCatalog();
    const named = Object.values(getModelCatalog())
      .filter((bucket): bucket is ModelEntry[] => Array.isArray(bucket))
      .flatMap((bucket) => bucket.map((entry) => entry.name));
    expect(named.length, "the catalog names some models").toBeGreaterThan(0);
    for (const file of [
      "src/model-catalog/mode-catalog.ts",
      "src/agent/tools/canvas-capabilities.ts",
      "src/agent/tools/generation-models.ts",
    ]) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      for (const name of named) {
        expect(source, `${file} names ${name}`).not.toContain(name);
      }
    }
  });
});

/**
 * The capabilities with every provider key configured.
 *
 * Unit runs carry no vendor keys, so a bare call reads an empty catalog and
 * every assertion that walks the answer passes over nothing. `useFullCatalog`
 * throws when that is still the case after the keys are set.
 * @returns The full answer, measured with all keys present.
 */
function withEveryProviderKey(): CanvasCapabilities {
  useFullCatalog();
  return getCanvasCapabilities();
}

/**
 * The mode codes one node reports.
 * @param capabilities - The answer to read.
 * @param nodeType - The node to read it for.
 * @returns Its mode codes, or nothing when it reports no modes at all.
 */
function modesOfNode(
  capabilities: CanvasCapabilities,
  nodeType: GenerationNodeType,
): string[] {
  const node = capabilities.find((entry) => entry.nodeType === nodeType);
  return (node?.modes ?? []).map((mode) => mode.mode);
}
