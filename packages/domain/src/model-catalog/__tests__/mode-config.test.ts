// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a mode declares: its name and what it is for (#269). The material a
 * run needs is on each model (#2156), so a mode row carrying a source list is
 * refused while the catalog loads rather than read by nobody.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { assertModesDeclared, parseModeConfig } from "../mode-config.js";

describe("a mode's declaration", () => {
  it("carries its label and what it is for", () => {
    const config = parseModeConfig({
      video: {
        modes: {
          first_last: { label: "first-last frame", description: "Interpolate between two frames." },
        },
      },
    });

    expect(config.video?.modes.first_last).toEqual({
      label: "first-last frame",
      description: "Interpolate between two frames.",
    });
  });

  it("is refused when it still names the sources it needs", () => {
    expect(() =>
      parseModeConfig({
        video: {
          modes: { i2v: { label: "image to video", description: "Animate.", sources: ["image"] } },
        },
      }),
    ).toThrow(/video\.i2v.*sources/s);
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

// The cases above hold up the check itself. These hold up its place in the
// loading path: take that call out of the loader and every case above stays
// green, because no declaration in the real yaml breaks one today.
describe("the loader refuses what these checks refuse", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  /**
   * A filesystem serving one modality fixture and the mode declarations.
   * @param fixture - The modality yaml this filesystem serves.
   * @returns A `node:fs` double over those two files.
   */
  function fsWith(fixture: string): Record<string, unknown> {
    const modes = ["video:", "  modes:", "    t2v:", "      label: text-to-video"].join("\n");
    return {
      readdirSync: () => ["fixture.yaml"],
      existsSync: (path: string) => String(path).endsWith("modes.yaml"),
      readFileSync: (path: string) => (String(path).endsWith("modes.yaml") ? modes : fixture),
    };
  }

  it("throws on a model naming a mode no row describes", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () =>
      fsWith(
        ["models:", '  - name: "off-menu"', '    mode: "teleport"', "    takes_prompt: true"].join(
          "\n",
        ),
      ),
    );
    const mod = await import("../model-catalog.js");
    expect(() => mod.getFullModelConfig("video")).toThrow(/off-menu.*teleport/s);
  });
});

describe("a model that says nothing about its mode", () => {
  it("is named when the field holds an empty list", () => {
    // Saying nothing has three spellings and they all have to reach the walk
    // as something: a walk over zero modes agrees with anything.
    expect(() =>
      assertModesDeclared("video", [{ name: "no-mode", mode: [] }], {
        video: { modes: {}, selectionGuide: "" },
      }),
    ).toThrow(/no-mode/);
  });

  it("is named rather than passed over", () => {
    // An empty answer used to be filtered out with the declared ones, so a
    // model missing the field left every mode of it unguarded downstream.
    expect(() =>
      assertModesDeclared("video", [{ name: "no-mode" }], {
        video: { modes: {}, selectionGuide: "" },
      }),
    ).toThrow(/no-mode/);
  });
});

describe("a mode row with a key nobody reads", () => {
  it("is refused rather than dropped in silence", () => {
    // A misspelled `sources` read as needing no material, which takes the
    // enqueue gate off every model declaring that mode.
    expect(() =>
      parseModeConfig({ video: { modes: { i2v: { label: "x", source: ["image"] } } } }),
    ).toThrow(/source/);
  });
});
