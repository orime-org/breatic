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

describe("facts the catalog carries that change what to propose", () => {
  it("states the rate for a model that bills by usage", () => {
    // `cost_per_call` on these is the pre-enqueue balance floor, and the panel
    // prices the run off `rate` -- sonilo's own yaml says so, and says the
    // longest preset comes to 36 against a floor of 5.
    const answer = modelsForMode("audio", "sfx");
    if (!answer.available) throw new Error("sfx has models");
    const sonilo = answer.models.find((model) => model.name === "sonilo-sfx-v1");
    expect(sonilo?.rate, "sonilo bills per second").toBeDefined();
    expect(sonilo?.rate?.unit).toBe("seconds");
  });

  it("says a model takes no prompt when it takes none", () => {
    // The only talking-head model, and its panel mounts no prompt editor.
    const answer = modelsForMode("video", "talking_head");
    if (!answer.available) throw new Error("talking_head has models");
    expect(answer.models.every((model) => model.takesPrompt === false)).toBe(true);
  });

  it("keeps a parameter's declared type", () => {
    const answer = modelsForMode("image", "i2i");
    if (!answer.available) throw new Error("i2i has models");
    const listed = answer.models.flatMap((model) => Object.entries(model.params));
    const lists = listed.filter(([, spec]) => spec.type === "list");
    expect(lists.length, "some i2i param is declared a list").toBeGreaterThan(0);
  });

  it("marks a parameter whose values come from elsewhere", () => {
    const answer = modelsForMode("audio", "tts");
    if (!answer.available) throw new Error("tts has models");
    const voices = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([, spec]) => spec.valuesFrom !== undefined);
    expect(voices.length, "a voice param names where its values live").toBeGreaterThan(0);
  });

  it("marks the parameters a wired node fills rather than the asker", () => {
    // talking_head needs an image and an audio, and both arrive by wiring a
    // node in. Presented as ordinary parameters they read as fields to fill.
    const answer = modelsForMode("video", "talking_head");
    if (!answer.available) throw new Error("talking_head has models");
    const filledByWiring = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([, spec]) => spec.filledBySource === true)
      .map(([name]) => name);
    expect(filledByWiring).toContain("image");
    expect(filledByWiring).toContain("audio");
  });

  it("leaves an ordinary setting unmarked", () => {
    const answer = modelsForMode("video", "talking_head");
    if (!answer.available) throw new Error("talking_head has models");
    const seed = answer.models.flatMap((m) => Object.entries(m.params)).find(([n]) => n === "seed");
    expect(seed?.[1].filledBySource).toBeUndefined();
  });
});
