// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The models behind one mode of one generation node (#261).
 *
 * The answer is keyed by node type, not by catalog bucket, because that is
 * what the asker has: the agent knows it wants an audio node, and the models
 * for that node are catalogued under two different buckets.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { modelsForMode } from "../mode-catalog.js";
import { allProviderKeyNames, restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
  useEnvWithKeys(allProviderKeyNames());
});

afterAll(() => {
  restoreProcessEnv();
});

describe("modelsForMode", () => {
  it("answers with the models that declare the mode", () => {
    const answer = modelsForMode("image", "t2i");
    expect(answer.available).toBe(true);
    if (!answer.available) return;
    expect(answer.models.length).toBeGreaterThan(0);
    for (const model of answer.models) {
      expect(model.name.length, "model name").toBeGreaterThan(0);
      expect(model.what, `${model.name} description is one line`).not.toContain("\n");
      expect(typeof model.credits, `${model.name} credits`).toBe("number");
    }
  });

  it("describes each parameter well enough to fill it in", () => {
    const answer = modelsForMode("image", "t2i");
    if (!answer.available) throw new Error("t2i has models");
    const withParams = answer.models.filter((model) => Object.keys(model.params).length > 0);
    expect(withParams.length, "some t2i model declares params").toBeGreaterThan(0);
    for (const model of withParams) {
      for (const [name, spec] of Object.entries(model.params)) {
        expect(spec, `${model.name}.${name} carries a default`).toHaveProperty("default");
      }
    }
  });

  it("includes a model that reaches the mode through a multi-mode declaration", () => {
    // The edit models declare `["i2i", "edit"]`: they are offerable because of
    // the first, and a lookup that compares the field to the mode as a string
    // drops them from the only mode an image node can use them in.
    const answer = modelsForMode("image", "i2i");
    expect(answer.available).toBe(true);
    if (!answer.available) return;
    expect(answer.models.length).toBeGreaterThan(0);
  });

  it("reads the tts bucket for an audio node", () => {
    const answer = modelsForMode("audio", "tts");
    expect(answer.available).toBe(true);
    if (!answer.available) return;
    expect(answer.models.length).toBeGreaterThan(0);
  });

  it("reads the audio bucket for the same node", () => {
    const answer = modelsForMode("audio", "t2m");
    expect(answer.available).toBe(true);
    if (!answer.available) return;
    expect(answer.models.length).toBeGreaterThan(0);
  });

  it("refuses a mode the node's picker does not offer, and says what it does", () => {
    // `upscale` has models and is a mini-tool operation: an image node cannot
    // be set to it, so an empty model list would read as "nothing configured"
    // when the truth is "not something this node does".
    const answer = modelsForMode("image", "upscale");
    expect(answer.available).toBe(false);
    if (answer.available) return;
    expect(answer.offered).toContain("t2i");
    expect(answer.offered).not.toContain("upscale");
  });

  it("refuses a mode nothing backs, and says what the node does offer", () => {
    const answer = modelsForMode("image", "relight");
    expect(answer.available).toBe(false);
    if (answer.available) return;
    expect(answer.offered.length).toBeGreaterThan(0);
  });

  it("follows the catalog: with no keys, no mode is available", () => {
    useEnvWithKeys([]);
    const answer = modelsForMode("image", "t2i");
    expect(answer.available).toBe(false);
    if (answer.available) return;
    expect(answer.offered).toEqual([]);
  });
});
