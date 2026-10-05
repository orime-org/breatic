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
import { GENERATION_NODE_MODES } from "@breatic/shared";
import type { GenerationNodeType } from "@breatic/shared";

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
      expect(model.what.length, `${model.name} says what it is good at`).toBeGreaterThan(0);
      expect(model.what, `${model.name} description is one line`).not.toContain("\n");
    }
  });

  it("describes each parameter well enough to fill it in", () => {
    const answer = modelsForMode("image", "t2i");
    if (!answer.available) throw new Error("t2i has models");
    const withParams = answer.models.filter((model) => Object.keys(model.params).length > 0);
    expect(withParams.length, "some t2i model declares params").toBeGreaterThan(0);
    for (const model of withParams) {
      for (const [name, spec] of Object.entries(model.params)) {
        expect(spec.default, `${model.name}.${name} carries a default`).toBeDefined();
        expect(spec.what.length, `${model.name}.${name} says what it does`).toBeGreaterThan(
          0,
        );
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
  it("says a model takes no prompt when it takes none", () => {
    // OmniHuman drives the face from the audio alone; the other talking-head
    // models also read a prompt.
    const answer = modelsForMode("video", "talking_head");
    if (!answer.available) throw new Error("talking_head has models");
    const omnihuman = answer.models.find((model) => model.name === "omnihuman-1.5");
    expect(omnihuman?.takesPrompt).toBe(false);
    expect(answer.models.some((model) => model.takesPrompt === true)).toBe(true);
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

  it("keeps the cap on how much prompt a model takes", () => {
    // One tts model states a per-request cap and the other states none; the
    // panel refuses the submit past it, so a reader choosing between them on
    // script length has nothing to choose with unless the answer says.
    const answer = modelsForMode("audio", "tts");
    if (!answer.available) throw new Error("tts has models");
    const capped = answer.models.filter((model) => model.maxInputChars !== undefined);
    expect(capped.length, "a tts model states its input cap").toBeGreaterThan(0);
  });

  it("keeps the bounds of a parameter whose domain is a range", () => {
    // kling states 3-15 and seedance 4-12 for the same param name, so there is
    // nothing to infer: a duration reported without them reads as unbounded,
    // and the panel's slider stops where the yaml says.
    const answer = modelsForMode("video", "t2v");
    if (!answer.available) throw new Error("t2v has models");
    const ranged = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([, spec]) => spec.min !== undefined);
    expect(ranged.length, "some t2v param declares a range").toBeGreaterThan(0);
    for (const [name, spec] of ranged) {
      expect(spec.max, `${name} states both ends`).toBeDefined();
    }
  });

  it("keeps the cap on a parameter that takes a list", () => {
    const answer = modelsForMode("video", "ref");
    if (!answer.available) throw new Error("ref has models");
    const capped = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([, spec]) => spec.maxItems !== undefined);
    expect(capped.length, "a reference list states its cap").toBeGreaterThan(0);
  });

  it.each([
    ["i2v", "Seedance 2.5"],
    ["first_last", "Seedance 2.5"],
    ["multi_shot", "Seedance 2.5 Image-to-Video"],
  ])("offers Seedance 2.5 image-to-video in %s, under the name the picker shows", (mode, shown) => {
    const answer = modelsForMode("video", mode);
    if (!answer.available) throw new Error(`${mode} has models`);
    const seedance = answer.models.find((model) => model.name === "seedance-2.5-image-to-video");
    expect(seedance?.displayName).toBe(shown);
  });

  it("carries the name the picker shows beside the name a node stores", () => {
    // The picker renders display_name and never the id, so an answer carrying
    // only the id asks the reader to map "kling-o3-pro" onto "Kling O3 Pro".
    const answer = modelsForMode("image", "t2i");
    if (!answer.available) throw new Error("t2i has models");
    for (const model of answer.models) {
      expect(model.displayName.length, `${model.name} display name`).toBeGreaterThan(0);
    }
    expect(
      answer.models.some((model) => model.displayName !== model.name),
      "at least one differs from its id",
    ).toBe(true);
  });

  it("marks an optional source slot the same as a required one", () => {
    // `ref` takes reference images and, on some models, reference videos; both
    // pools are optional one by one and arrive by wiring.
    const answer = modelsForMode("video", "ref");
    if (!answer.available) throw new Error("ref has models");
    const filledByWiring = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([, spec]) => spec.filledBySource === true)
      .map(([name]) => name);
    expect(filledByWiring).toContain("images");
    expect(filledByWiring).toContain("videos");
  });

  it("leaves out a slot the asked mode does not have", () => {
    // One entry serves image-to-video and first-last-frame and declares the
    // end frame for the second; asked about the first, the end frame is a
    // slot that mode's panel never draws.
    const answer = modelsForMode("video", "i2v");
    if (!answer.available) throw new Error("i2v has models");
    const named = answer.models.flatMap((model) => Object.keys(model.params));
    expect(named).toContain("image");
    expect(named).not.toContain("end_image");
  });

  it("says when the panel draws no control for a parameter", () => {
    // `output_format` is pinned on several image models and no panel offers
    // it: the run takes the default, and a reader told to set it has nothing
    // to set.
    const answer = modelsForMode("image", "i2i");
    if (!answer.available) throw new Error("i2i has models");
    const formats = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([name]) => name === "output_format");
    expect(formats.length, "some i2i model declares output_format").toBeGreaterThan(0);
    for (const [, spec] of formats) expect(spec.noControl).toBe(true);
  });

  it("leaves a parameter the panel does draw unmarked", () => {
    const answer = modelsForMode("video", "t2v");
    if (!answer.available) throw new Error("t2v has models");
    const ratios = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([name]) => name === "aspect_ratio");
    expect(ratios.length, "some t2v model declares aspect_ratio").toBeGreaterThan(0);
    for (const [, spec] of ratios) expect(spec.noControl).toBeUndefined();
  });

  it("offers the values the picker lists for a range it expands", () => {
    // The picker walks an unstepped range one whole step at a time, so a
    // reader told only the two ends asks for a value in between.
    const answer = modelsForMode("video", "t2v");
    if (!answer.available) throw new Error("t2v has models");
    const durations = answer.models
      .flatMap((model) => Object.entries(model.params))
      .filter(([name, spec]) => name === "duration" && spec.min !== undefined);
    expect(durations.length, "some t2v duration is a range").toBeGreaterThan(0);
    for (const [, spec] of durations) expect(spec.options).toContain(4);
  });

  it("leaves an ordinary setting unmarked", () => {
    const answer = modelsForMode("video", "talking_head");
    if (!answer.available) throw new Error("talking_head has models");
    const resolution = answer.models
      .flatMap((model) => Object.entries(model.params))
      .find(([name]) => name === "resolution");
    // Asserted found first: optional chaining on a missing entry passes the
    // next line without reading anything.
    expect(resolution, "talking_head declares resolution").toBeDefined();
    expect(resolution?.[1].filledBySource).toBeUndefined();
  });
});

describe("the gate a parameter reports", () => {
  it("names something that mode or that model has", () => {
    // A gate tells the reader to turn a switch on first, and names another
    // parameter of the same model. Naming anything else sends them after a
    // control that is not on their screen.
    let seen = 0;
    for (const nodeType of Object.keys(GENERATION_NODE_MODES) as GenerationNodeType[]) {
      for (const mode of GENERATION_NODE_MODES[nodeType]) {
        const answer = modelsForMode(nodeType, mode);
        if (!answer.available) continue;
        for (const model of answer.models) {
          for (const [name, spec] of Object.entries(model.params)) {
            if (spec.gate === undefined) continue;
            seen += 1;
            const reachable = spec.gate.param in model.params;
            expect(
              reachable,
              `${nodeType}/${mode} ${model.name}.${name} waits on ${spec.gate.param}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(seen, "some parameter reports a gate").toBeGreaterThan(0);
  });
});
