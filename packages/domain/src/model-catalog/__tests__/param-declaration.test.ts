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
          enable_camera: { fill: "panel" },
          lens: { fill: "panel", when: { flag_on: "enable_camera" } },
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

  it("takes a pool's mention with one position placeholder", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          images: { fill: "pool", accepts: "image", type: "list", mention: "@image{n}" },
          videos: { fill: "pool", accepts: "video", type: "list", mention: "<VIDEO_{i}>" },
        }),
      ),
    ).not.toThrow();
  });

  it("is refused when a mention sits on a param the pool does not fill", () => {
    // Only a chip picked from the pool is written with it; anywhere else it is
    // a spelling nothing reads.
    expect(() =>
      assertParamDeclarations("video", modelWith({ image: { fill: "canvas", accepts: "image", mention: "image {n}" } })),
    ).toThrow(/a-model\.image: only a pool param writes its chips with a mention/);
  });

  it.each([
    ["no placeholder", "the image"],
    ["both placeholders", "{n} of {i}"],
    ["the same placeholder twice", "{n}{n}"],
  ])("is refused when a mention has %s", (_case, mention) => {
    expect(() =>
      assertParamDeclarations("video", modelWith({ images: { fill: "pool", accepts: "image", type: "list", mention } })),
    ).toThrow(/a-model\.images: a mention holds exactly one \{n\} or \{i\}/);
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
        modelWith({ lens: { fill: "panel", when: { flag_on: "enable_camera" } } }),
      ),
    ).toThrow(/a-model.*lens.*enable_camera/s);
  });

  it("is refused when it limits itself to a mode the model does not serve", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ end_image: { fill: "canvas", accepts: "image", modes: ["first_last"] } }),
      ),
    ).toThrow(/a-model.*end_image.*first_last/s);
  });

  it("passes a style slot that holds three files", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3, optional: true } },
          "t2i",
        ),
      ),
    ).not.toThrow();
  });

  it("is refused when the style slot holds anything but three files", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 2 } },
          "t2i",
        ),
      ),
    ).toThrow(/a-model.*style_images.*3/s);
  });

  it("passes a style slot that joins the model's own pool with a prompt note", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          {
            images: { fill: "pool", accepts: "image", type: "list", max_items: 13, mention: "image {n}" },
            style_images: {
              fill: "canvas",
              accepts: "image",
              type: "list",
              max_items: 3,
              optional: true,
              joins: "images",
              prompt_note: "{list} are style references.",
            },
          },
          "i2i",
        ),
      ),
    ).not.toThrow();
  });

  it("is refused when a slot joins a param that is not one of the model's pools", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          {
            ratio: { fill: "panel", values: ["1:1"], default: "1:1" },
            style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3, joins: "ratio", prompt_note: "{list}" },
          },
          "i2i",
        ),
      ),
    ).toThrow(/a-model.*style_images.*joins/s);
  });

  it("is refused when a slot joins a pool that does not say how its files are named", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          {
            images: { fill: "pool", accepts: "image", type: "list", max_items: 13 },
            style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3, joins: "images", prompt_note: "{list}" },
          },
          "i2i",
        ),
      ),
    ).toThrow(/a-model.*style_images.*mention/s);
  });

  it("is refused when a joining slot has no prompt note naming the list", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          {
            images: { fill: "pool", accepts: "image", type: "list", max_items: 13, mention: "image {n}" },
            style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3, joins: "images", prompt_note: "Use the style." },
          },
          "i2i",
        ),
      ),
    ).toThrow(/a-model.*style_images.*\{list\}/s);
  });

  it("passes an item_key that wraps each entry of a list", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3, upstream: "reference", item_key: "image" } },
          "t2i",
        ),
      ),
    ).not.toThrow();
  });

  it("is refused when it caps how many it takes without saying it takes a list", () => {
    // A cap counts entries, and only a list has entries. The gate reads a
    // param that does not say `list` as one URL string, so a declaration
    // carrying both reads as a single string to the gate and as an array to
    // the cap check and the transport -- the same submission judged by two
    // shapes of the same field.
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith({ images: { fill: "none", note: "no panel", accepts: "image", max_items: 20 } }, "generate"),
      ),
    ).toThrow(/a-model.*images.*max_items.*list/s);
  });

  it("is refused when it still declares a conditional cap", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          images: {
            fill: "pool",
            accepts: "image",
            type: "list",
            max_items: 7,
            max_items_when_present: { video: 4 },
          },
        }),
      ),
    ).toThrow(/a-model.*images.*max_items_when_present/s);
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

  it("is refused when a list slot does not say how many files it holds", () => {
    // The slot's thumbnails, its "+ N/max" and the gate all read the cap, so a
    // list slot without one has no limit any of them can show.
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

  it("lets a storyboard declare its shots and its tier (#2218)", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          multi_prompt: {
            fill: "storyboard",
            type: "items",
            max_items: 6,
            fields: { prompt: { type: "text", max_chars: 512 }, duration: { values: [1, 2, 3] } },
          },
          shot_type: { fill: "storyboard", values: ["intelligence", "customize"] },
        }),
      ),
    ).not.toThrow();
  });

  it("lets a list editor state a floor and name the param it stands in for", () => {
    expect(() =>
      assertParamDeclarations(
        "tts",
        modelWith({
          voice_id: { fill: "remote", remote_source: "voices" },
          speakers: { fill: "panel", type: "items", min_items: 2, max_items: 2, replaces: "voice_id" },
        }, "tts"),
      ),
    ).not.toThrow();
  });

  it("is refused when it stands in for a param the model does not declare", () => {
    expect(() =>
      assertParamDeclarations(
        "tts",
        modelWith({ speakers: { fill: "panel", type: "items", replaces: "voice" } }, "tts"),
      ),
    ).toThrow(/a-model\.speakers.*replaces "voice"/s);
  });

  it("is refused when its floor sits above its cap", () => {
    expect(() =>
      assertParamDeclarations(
        "tts",
        modelWith({ speakers: { fill: "panel", type: "items", min_items: 3, max_items: 2 } }, "tts"),
      ),
    ).toThrow(/a-model\.speakers.*min_items/s);
  });

  it("lets a choice name the language each of its values is, one for one", () => {
    const language = {
      fill: "panel",
      values: ["English (United States)", "Japanese (Japan)"],
      default: "English (United States)",
    };
    expect(() =>
      assertParamDeclarations("tts", modelWith({ language: { ...language, value_locales: ["en-US", "ja-JP"] } }, "tts")),
    ).not.toThrow();
    expect(() =>
      assertParamDeclarations("tts", modelWith({ language: { ...language, value_locales: ["en-US"] } }, "tts")),
    ).toThrow(/a-model\.language.*value_locales/s);
  });

  it("lets a choice name how each of its values reads", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          order: {
            fill: "panel",
            values: ["meanwhile", "left_right"],
            default: "meanwhile",
            value_labels: { meanwhile: "Together", left_right: "Left first" },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("is refused when it names how a value reads that it does not offer", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          order: {
            fill: "panel",
            values: ["meanwhile"],
            default: "meanwhile",
            value_labels: { right_left: "Right first" },
          },
        }),
      ),
    ).toThrow(/a-model.*order.*value_labels.*right_left/s);
  });

  it("names the steps of a range", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith({
          tilt: {
            fill: "panel",
            min: -30,
            max: 60,
            step: 30,
            default: 0,
            value_labels: { "-30": "Low angle", "0": "Eye level", "30": "Elevated", "60": "High angle" },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("is refused when it names a number the range never steps on", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith({
          tilt: {
            fill: "panel",
            min: -30,
            max: 60,
            step: 30,
            default: 0,
            value_labels: { "15": "Slightly elevated" },
          },
        }),
      ),
    ).toThrow(/a-model.*tilt.*value_labels.*15/s);
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
describe("a panel parameter's default", () => {
  // User 2026-09-29: a control the panel draws always stands on a value, and
  // that value is the one the catalog declares, so a new node reads it there.
  it("passes when a choice defaults to one of its values and a range to a number inside it", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith({
          quality: { fill: "panel", values: ["low", "high"], default: "low" },
          chaos: { fill: "panel", min: 0, max: 100, default: 0 },
          transparency: { fill: "panel", values: [false, true], default: false },
        }, "t2i"),
      ),
    ).not.toThrow();
  });

  it("is refused when a choice declares no default, or one it does not offer", () => {
    expect(() =>
      assertParamDeclarations("image", modelWith({ aspect_ratio: { fill: "panel", values: ["1:1"], default: null } }, "t2i")),
    ).toThrow(/a-model\.aspect_ratio.*default/s);
    expect(() =>
      assertParamDeclarations("image", modelWith({ quality: { fill: "panel", values: ["low"] } }, "t2i")),
    ).toThrow(/a-model\.quality.*default/s);
    expect(() =>
      assertParamDeclarations("image", modelWith({ quality: { fill: "panel", values: ["low"], default: "max" } }, "t2i")),
    ).toThrow(/a-model\.quality.*default/s);
  });

  it("is refused when a range defaults outside itself", () => {
    expect(() =>
      assertParamDeclarations("image", modelWith({ chaos: { fill: "panel", min: 0, max: 100, default: 101 } }, "t2i")),
    ).toThrow(/a-model\.chaos.*default/s);
  });

  it("lets a choice name the value that is sent as nothing, when it offers it", () => {
    const ratio = { fill: "panel", values: ["auto", "1:1"], default: "auto" };
    expect(() =>
      assertParamDeclarations("image", modelWith({ aspect_ratio: { ...ratio, absent_value: "auto" } }, "t2i")),
    ).not.toThrow();
    expect(() =>
      assertParamDeclarations("image", modelWith({ aspect_ratio: { ...ratio, absent_value: "match" } }, "t2i")),
    ).toThrow(/a-model\.aspect_ratio.*absent_value/s);
  });

  it("lets a switch name false as the value that is sent as nothing", () => {
    const toggle = { fill: "panel", values: [true, false], default: false, absent_value: false };
    expect(() => assertParamDeclarations("video", modelWith({ auto_shots: toggle }, "t2v"))).not.toThrow();
  });

  it("lets a value be sent as another spelling only when the choice offers that value", () => {
    const toggle = { fill: "panel", values: [true, false], default: false, upstream: "shot_type" };
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ auto_shots: { ...toggle, upstream_values: { true: "intelligence" } } }, "t2v"),
      ),
    ).not.toThrow();
    expect(() =>
      assertParamDeclarations("video", modelWith({ auto_shots: { ...toggle, upstream_values: { on: "x" } } }, "t2v")),
    ).toThrow(/a-model\.auto_shots.*upstream_values/s);
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ seed: { fill: "panel", min: 0, max: 9, default: 0, upstream_values: { "1": "x" } } }, "t2v"),
      ),
    ).toThrow(/a-model\.seed.*upstream_values/s);
  });

  it("lets only a list of entries write them into the prompt, and only with a place for each one's text", () => {
    const shots = {
      fill: "storyboard",
      type: "items",
      default: null,
      modes: ["multi_shot"],
      fields: { prompt: { type: "text" }, duration: { values: [1, 2] } },
    };
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ shots: { ...shots, into_prompt: "Shot {n} [{start}-{end}s]: {prompt}" } }, ["t2v", "multi_shot"]),
      ),
    ).not.toThrow();
    expect(() =>
      assertParamDeclarations("video", modelWith({ shots: { ...shots, into_prompt: "Shot {n}" } }, ["t2v", "multi_shot"])),
    ).toThrow(/a-model\.shots.*into_prompt/s);
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ tone: { fill: "panel", values: ["a"], default: "a", into_prompt: "{prompt}" } }, "t2v"),
      ),
    ).toThrow(/a-model\.tone.*into_prompt/s);
  });
});

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

describe("a parameter declaration with a key nobody reads", () => {
  it("is refused rather than dropped in silence", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ images: { fill: "pool", accepts: "image", max_item: 7 } }),
      ),
    ).toThrow(/max_item/);
  });
});
