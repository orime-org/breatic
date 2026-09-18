// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a parameter declares about how it gets filled (#269).
 *
 * A declaration that contradicts itself is worse than one that is missing:
 * the panel, the proposal tool and the enqueue gate all read it, and each
 * quietly answers around the contradiction in its own way. Refused while the
 * catalog loads, it is one message on the machine that ships the yaml.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { assertParamDeclarations } from "../param-declaration.js";

/**
 * One model with the parameters a case wants to hold up.
 * @param params - The parameter declarations under test.
 * @param mode - The modes the model serves.
 * @returns A single-model list shaped the way the catalog holds it.
 */
function modelWith(
  params: Record<string, unknown>,
  mode: string | string[] = "i2v",
): Array<{ name: string; mode: string | string[]; params: Record<string, unknown> }> {
  return [{ name: "a-model", mode, params }];
}

describe("a parameter declaration", () => {
  it("passes when every field agrees with the model around it", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          image: { fill: "canvas", accepts: "image" },
          duration: { fill: "panel" },
          keep_original_sound: { fill: "panel", when: { source: "image" } },
          end_image: { fill: "canvas", accepts: "image", modes: ["first_last"] },
          seed: { fill: "none", note: "reproducibility plumbing" },
        }, ["i2v", "first_last"]),
      ),
    ).not.toThrow();
  });

  it("is refused when a slot does not say which kind of node it takes", () => {
    expect(() => assertParamDeclarations("video", modelWith({ image: { fill: "canvas" } }))).toThrow(
      /a-model.*image.*accepts/s,
    );
  });

  it("is refused when a pool does not say which kind of node it takes", () => {
    // The gate finds a carrier by what it accepts, so a pool that says nothing
    // carries nothing and every submission through it is refused before it is
    // sent.
    expect(() => assertParamDeclarations("video", modelWith({ images: { fill: "pool" } }))).toThrow(
      /a-model.*images.*accepts/s,
    );
  });

  it("is refused when a gate names a parameter the model does not declare", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ keep_original_sound: { fill: "panel", when: { source: "video" } } }),
      ),
    ).toThrow(/a-model.*keep_original_sound.*video/s);
  });

  it("is refused when it limits itself to a mode the model does not serve", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ end_image: { fill: "canvas", accepts: "image", modes: ["first_last"] } }),
      ),
    ).toThrow(/a-model.*end_image.*first_last/s);
  });

  it("is refused when a slot is capped above the one file it can carry", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3 } },
          "i2i",
        ),
      ),
    ).toThrow(/a-model.*style_images.*max_items/s);
  });

  it("is refused when it caps how many it takes without saying it takes a list", () => {
    // A cap counts entries, and only a list has entries. The gate reads a
    // param that does not say `list` as one URL string, so a declaration
    // carrying both reads as a single string to the gate and as an array to
    // the cap check and the transport -- the same submission judged by two
    // shapes of the same field.
    expect(() =>
      assertParamDeclarations(
        "understand",
        modelWith({ images: { fill: "none", note: "no panel", accepts: "image", max_items: 20 } }, "vi"),
      ),
    ).toThrow(/a-model.*images.*max_items.*list/s);
  });

  it("is refused when its conditional cap is set on something that is not a list", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          video: { fill: "canvas", accepts: "video", optional: true },
          images: {
            fill: "pool",
            accepts: "image",
            max_items_when_present: { video: 4 },
          },
        }),
      ),
    ).toThrow(/a-model.*images.*max_items_when_present.*list/s);
  });

  it("is refused when it does not say how it gets filled at all", () => {
    expect(() => assertParamDeclarations("video", modelWith({ seed: {} }))).toThrow(
      /a-model.*seed.*fill/s,
    );
  });

  it("is refused when it says it has no control without saying why", () => {
    expect(() =>
      assertParamDeclarations("video", modelWith({ seed: { fill: "none" } })),
    ).toThrow(/a-model.*seed.*note/s);
  });

  it("is refused when its conditional cap names a parameter the model does not declare", () => {
    // The cap is read by looking that name up among the submitted params, so a
    // misspelling reads as "nothing is there" and the wider cap stands. Every
    // gate below it already gets this check; the cap did not.
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          video: { fill: "canvas", accepts: "video", optional: true },
          images: {
            fill: "pool",
            accepts: "image",
            type: "list",
            max_items: 7,
            max_items_when_present: { video_url: 4 },
          },
        }),
      ),
    ).toThrow(/a-model.*images.*video_url/s);
  });

  it("is refused when its conditional cap has no cap to narrow", () => {
    // The field states a LOWER cap that takes over, so it needs one to be
    // lower than. Without it the reader of the number treats the param as
    // uncapped and this narrowing never applies to anything.
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          video: { fill: "canvas", accepts: "video", optional: true },
          images: {
            fill: "pool",
            accepts: "image",
            type: "list",
            max_items_when_present: { video: 4 },
          },
        }),
      ),
    ).toThrow(/a-model.*images.*max_items/s);
  });

  it("is refused when it spells the one shape a list can be any other way", () => {
    // Readers compare this field against that exact string: anything else is
    // read as one URL, so a capitalised spelling turns a list into a string
    // the source gate then finds empty.
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ images: { fill: "pool", accepts: "image", type: "List" } }),
      ),
      // The field it is about, not just the model and the param: a declaration
      // has three closed sets in it and a bare message fits any of them.
    ).toThrow(/a-model\.images: type .*"list"/s);
  });

  it("names every field the parser refused, not just the first", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ images: { fill: "nowhere", accepts: "image", type: "List" } }),
      ),
    ).toThrow(/fill[\s\S]*type|type[\s\S]*fill/);
  });

  it("is refused when a cap is zero, negative or fractional", () => {
    // Every reader takes a cap it cannot use as no cap at all, so a typo here
    // widens the limit instead of narrowing it.
    for (const bad of [0, -14, 1.5]) {
      expect(() =>
        assertParamDeclarations(
          "image",
          modelWith({ images: { fill: "pool", accepts: "image", type: "list", max_items: bad } }, "i2i"),
        ),
      ).toThrow(/a-model.*images/s);
    }
  });

  it("is refused when a list slot does not cap itself at the one file it carries", () => {
    // The payload builders write a single string into a slot, so a list slot
    // without a cap states a limit no reader can use.
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ image: { fill: "canvas", accepts: "image", type: "list" } }),
      ),
    ).toThrow(/a-model.*image.*max_items/s);
  });

  it("is refused when it names a field no declaration has", () => {
    // A misspelled key used to be dropped in silence, and the param then read
    // as whatever the missing field defaults to.
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ image: { fill: "canvas", accepts: "image", when: { sources: "video" } } }),
      ),
    ).toThrow(/a-model.*image/s);
  });

  it("lets the reference pool carry as many as the model says", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { images: { fill: "pool", accepts: "image", type: "list", max_items: 13 } },
          "i2i",
        ),
      ),
    ).not.toThrow();
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

  it("throws on a slot that does not say which kind of node it takes", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () =>
      fsWith(
        [
          "models:",
          '  - name: "no-kind"',
          '    mode: "t2v"',
          "    takes_prompt: true",
          "    params:",
          "      image:",
          '        fill: "canvas"',
        ].join("\n"),
      ),
    );
    const mod = await import("../model-catalog.js");
    expect(() => mod.getFullModelConfig("video")).toThrow(/no-kind.*image.*accepts/s);
  });
});
