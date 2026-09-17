// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a mode declares about the material it needs (#269).
 *
 * The source requirement is indexed by mode, not by model: one row says what
 * a first-and-last-frame run needs, and every model offering that mode is
 * held to it. Deriving it from each model's parameters instead reaches only
 * the models a generation panel reaches, which is ten short of the models the
 * enqueue gate actually guards.
 *
 * So the rows live beside the modes they describe, and a row that names a
 * source type nothing can carry, or a rule nothing can read, is refused while
 * the catalog loads rather than answered around at request time.
 */

import { describe, it, expect } from "vitest";

import { assertModesDeclared, parseModeConfig } from "../mode-config.js";

describe("a mode's declaration", () => {
  it("carries the source types it needs and the rule over its slots", () => {
    const config = parseModeConfig({
      video: {
        modes: {
          first_last: {
            label: "first-last frame",
            description: "Interpolate between two frames.",
            sources: ["image"],
          },
        },
      },
      audio: {
        modes: {
          a2m: {
            label: "reference to music",
            description: "Write music from a reference.",
            sources: ["audio"],
            source_rule: "any_of",
          },
        },
      },
    });

    expect(config.video?.first_last).toEqual({
      label: "first-last frame",
      description: "Interpolate between two frames.",
      sources: ["image"],
      sourceRule: "all_of",
    });
    expect(config.audio?.a2m?.sourceRule).toBe("any_of");
  });

  it("needs no material when it names no source", () => {
    const config = parseModeConfig({
      image: { modes: { t2i: { label: "text to image", description: "From words." } } },
    });

    expect(config.image?.t2i?.sources).toEqual([]);
    expect(config.image?.t2i?.sourceRule).toBe("all_of");
  });

  it("is refused when it names a source type nothing can carry", () => {
    expect(() =>
      parseModeConfig({
        video: {
          modes: {
            i2v: { label: "image to video", description: "Animate.", sources: ["hologram"] },
          },
        },
      }),
    ).toThrow(/video\.i2v.*hologram/s);
  });

  it("is refused when its rule is one no reader knows", () => {
    expect(() =>
      parseModeConfig({
        audio: {
          modes: {
            a2m: {
              label: "reference to music",
              description: "From a reference.",
              sources: ["audio"],
              source_rule: "at_least_two",
            },
          },
        },
      }),
    ).toThrow(/audio\.a2m.*at_least_two/s);
  });

  it("is refused when it has no label to put on a picker", () => {
    expect(() =>
      parseModeConfig({ image: { modes: { t2i: { description: "From words." } } } }),
    ).toThrow(/image\.t2i/s);
  });

  it("is refused when its label is blank, which a picker would render as nothing", () => {
    expect(() =>
      parseModeConfig({ image: { modes: { t2i: { label: "", description: "From words." } } } }),
    ).toThrow(/image\.t2i/s);
  });
});

describe("a model's mode", () => {
  const config = parseModeConfig({
    image: { modes: { t2i: { label: "text to image", description: "From words." } } },
  });

  it("passes when the mode config declares every mode the models name", () => {
    expect(() =>
      assertModesDeclared("image", [{ name: "some-model", mode: "t2i" }], config),
    ).not.toThrow();
  });

  it("is refused when nothing declares it, naming the model and the mode", () => {
    expect(() =>
      assertModesDeclared("image", [{ name: "some-model", mode: ["t2i", "relight"] }], config),
    ).toThrow(/some-model.*relight/s);
  });

  it("reads a bucket the mode config says nothing about as declaring nothing", () => {
    expect(() =>
      assertModesDeclared("three_d", [{ name: "a-3d-model", mode: "i23d" }], config),
    ).toThrow(/a-3d-model.*i23d/s);
  });
});
