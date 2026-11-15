// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from "vitest";

import {
  sanitizeModelCatalog,
  AUDIO_GENERATION_MODES,
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
  isGenerationNodeType,
} from "@shared/types/model-catalog.js";
import type { ModelCatalog, ModelEntry } from "@shared/types/model-catalog.js";

/**
 * Builds a well-formed image ModelEntry fixture.
 * @param name - Model id.
 * @param over - Field overrides.
 * @returns A valid ModelEntry (as a plain object, to be fed as untrusted input).
 */
function entry(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    display_name: name.toUpperCase(),
    modality: "image",
    mode: "generate",
    description: "",
    guide: "",
    tier: "optional",
    generation_time: 10,
    params: {
      aspect_ratio: { description: "", values: ["1:1", "16:9"], default: "1:1" },
    },
    availability: { upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] },
    pricing_rules: { model: name, upstreams: [] },
    ...over,
  };
}

/**
 * Builds a well-formed catalog wrapping the given image entries.
 * @param image - Image-modality entries (raw plain objects).
 * @returns A catalog-shaped plain object.
 */
function catalog(image: unknown[]): Record<string, unknown> {
  return {
    image,
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    total: image.length,
    credit_multiplier: 1,
  };
}

describe("sanitizeModelCatalog — boundary validation for the model catalog", () => {
  it("passes a well-formed catalog through intact", () => {
    const raw = catalog([entry("flux"), entry("sdxl", { tier: "recommended" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(2);
    expect(out.image[0]?.name).toBe("flux");
    expect(out.image[1]?.tier).toBe("recommended");
    expect(out.image[0]?.params.aspect_ratio?.values).toEqual(["1:1", "16:9"]);
    expect(out.total).toBe(2);
  });

  // inner#1305: the panel holds a run back by the source's size, and the
  // worker stores a result under the type its model returns.
  it("keeps a param's byte ceiling and the type an entry returns", () => {
    const out = sanitizeModelCatalog(
      catalog([
        entry("clean", {
          output_type: "audio/wav",
          params: { audio: { description: "", default: null, accepts: "audio", max_total_duration: 1800, max_bytes: 536_870_912 } },
        }),
        entry("plain", { output_type: 7 }),
      ]),
    );
    expect(out.image[0]?.params.audio?.max_bytes).toBe(536_870_912);
    expect(out.image[0]?.output_type).toBe("audio/wav");
    expect(out.image[1]?.output_type).toBeUndefined();
  });

  it("keeps the variant that tells a model apart from a namesake, and drops one that is not text", () => {
    const out = sanitizeModelCatalog(catalog([entry("a", { variant: "Reference" }), entry("b", { variant: 3 }), entry("c")]));
    expect(out.image.map((m) => m.variant)).toEqual(["Reference", undefined, undefined]);
  });

  it("preserves a valid icon name on an entry", () => {
    const raw = catalog([entry("flux", { icon: "nano-banana" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.icon).toBe("nano-banana");
  });

  // `takes_prompt` falls back to TRUE, and the direction is the whole point
  // (#1966). This field decides whether the panel demands a prompt; falling
  // back to `false` would not block anything — the execute gate reads
  // `!promptRequired || promptText.trim()`, so `false` REMOVES the demand.
  // The panel would then hide the editor and submit a paid generation with an
  // empty prompt to a model that actually wanted one. Falling back to `true`
  // costs at worst one demand too many, which the user can see and act on.
  it("falls back takes_prompt to true when the field is missing", () => {
    const raw = catalog([entry("flux", { takes_prompt: undefined })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.takes_prompt).toBe(true);
  });

  it("falls back takes_prompt to true when the field is not a boolean", () => {
    const raw = catalog([entry("flux", { takes_prompt: "false" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.takes_prompt).toBe(true);
  });

  it("keeps a declared takes_prompt: false — the fallback must not overwrite it", () => {
    const raw = catalog([entry("flux", { takes_prompt: false })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.takes_prompt).toBe(false);
  });

  it("coerces a non-string icon to undefined but keeps the entry", () => {
    const raw = catalog([entry("flux", { icon: 123 })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.icon).toBeUndefined();
  });

  it("leaves icon undefined when the field is absent (icon is optional)", () => {
    const out = sanitizeModelCatalog(catalog([entry("flux")]));
    expect(out.image[0]?.icon).toBeUndefined();
  });

  it("drops an entry whose name is not a string (identity is required)", () => {
    const raw = catalog([entry("good"), entry("x", { name: 123 }), entry("also-good")]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image.map((m) => m.name)).toEqual(["good", "also-good"]);
  });

  it("drops an entry whose name is an empty string", () => {
    const raw = catalog([entry("good"), entry("", { name: "" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image.map((m) => m.name)).toEqual(["good"]);
  });

  it("keeps a model's availability and pricing rules, which the estimate reads", () => {
    const out = sanitizeModelCatalog(catalog([entry("flux")]));
    expect(out.image[0]?.availability).toEqual({ upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] });
    expect(out.image[0]?.pricing_rules).toEqual({ model: "flux", upstreams: [] });
  });

  // A malformed availability degrades to none configured, and keeps the entry: the panel then names no upstream it
  // cannot vouch for. The pricing rules are checked where an estimate is made.
  it("degrades a malformed availability to none configured but keeps the entry", () => {
    const out = sanitizeModelCatalog(catalog([entry("flux", { availability: { upstreams: "all" } })]));
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.availability).toEqual({ upstreams: [] });
  });

  it("leaves behind what goes upstream, which the browser never reads", () => {
    const out = sanitizeModelCatalog(catalog([entry("flux", { pricing: { base_price: 1, formula: "", discount_rate: 100 }, prompt_upstream: "text", providers: [] })])).image[0];
    expect(out).not.toHaveProperty("pricing");
    expect(out).not.toHaveProperty("prompt_upstream");
    expect(out).not.toHaveProperty("providers");
  });

  it("keeps the credit multiplier the estimate converts by", () => {
    const raw = catalog([entry("flux")]);
    raw.credit_multiplier = 1.5;
    expect(sanitizeModelCatalog(raw).credit_multiplier).toBe(1.5);
  });

  it("falls back to a multiplier of 1 when the wire carries none", () => {
    const raw = catalog([entry("flux")]);
    delete raw.credit_multiplier;
    expect(sanitizeModelCatalog(raw).credit_multiplier).toBe(1);
  });

  it("coerces a non-object params to an empty object but keeps the entry", () => {
    const raw = catalog([entry("flux", { params: "not-an-object" })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toHaveLength(1);
    expect(out.image[0]?.params).toEqual({});
  });

  it("coerces a malformed single descriptor to a safe descriptor (keeps siblings)", () => {
    const raw = catalog([
      entry("flux", {
        params: {
          good: { description: "ok", values: ["a"], default: "a" },
          bad: "i-am-a-string-not-a-descriptor",
        },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    const p = out.image[0]?.params;
    expect(p?.good?.values).toEqual(["a"]);
    // the bad descriptor is coerced to a safe empty descriptor, not dropped or crashing
    expect(p?.bad).toBeDefined();
    expect(p?.bad?.values).toBeUndefined();
  });

  it("coerces a non-array descriptor.values to undefined but keeps the descriptor", () => {
    const raw = catalog([
      entry("flux", {
        params: { aspect_ratio: { description: "", values: "1:1", default: "1:1" } },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.params.aspect_ratio?.values).toBeUndefined();
  });

  it("coerces a non-array modality bucket to an empty array", () => {
    const raw = catalog([]);
    raw.image = "not-an-array";
    const out = sanitizeModelCatalog(raw);
    expect(out.image).toEqual([]);
  });

  it("fills a missing modality bucket with an empty array", () => {
    const raw = catalog([entry("flux")]);
    delete raw.tts;
    const out = sanitizeModelCatalog(raw);
    expect(out.tts).toEqual([]);
    expect(out.image).toHaveLength(1);
  });

  it("coerces a non-number total to 0", () => {
    const raw = catalog([entry("flux")]);
    raw.total = "lots";
    const out = sanitizeModelCatalog(raw);
    expect(out.total).toBe(0);
  });

  it("returns a safe empty catalog when the whole response is not an object", () => {
    for (const garbage of [null, undefined, "string", 42, [], true]) {
      const out = sanitizeModelCatalog(garbage);
      expect(out.image).toEqual([]);
      expect(out.video).toEqual([]);
      expect(out.audio).toEqual([]);
      expect(out.tts).toEqual([]);
      expect(out.three_d).toEqual([]);
      expect(out.total).toBe(0);
    }
  });

  it("never throws on arbitrarily nested garbage", () => {
    const raw = {
      image: [{ name: "ok" }, null, 42, "str", { name: {} }, []],
      video: { not: "an-array" },
      total: {},
    };
    expect(() => sanitizeModelCatalog(raw)).not.toThrow();
    const out = sanitizeModelCatalog(raw);
    // only the one entry with a valid string name survives
    expect(out.image.map((m) => m.name)).toEqual(["ok"]);
    expect(out.video).toEqual([]);
  });

  it("guarantees a ModelCatalog-typed result (compile-time contract)", () => {
    const out: ModelCatalog = sanitizeModelCatalog(catalog([entry("flux")]));
    const first: ModelEntry | undefined = out.image[0];
    expect(first?.name).toBe("flux");
  });

  // Adversarial round 1 (2026-07-09): the following edge cases were probed and
  // confirmed safe; locked in as permanent guards because the whole app trusts
  // this boundary — a future change to z.number() or the params transform that
  // reintroduced a non-finite number or a prototype-pollution vector must fail.

  it("coerces a non-finite total to 0", () => {
    const raw = catalog([entry("a")]);
    raw.total = NaN;
    expect(sanitizeModelCatalog(raw).total).toBe(0);
  });

  it("lists the seven video modes the panel offers, and no mini-tool mode (#1896)", () => {
    // A product decision (user 2026-08-08), not a formula: what this list
    // contains IS the rule, and there is no separate predicate. Most of what
    // was left out works on a video that already exists, which is the shape of
    // the decision — but `motion` takes a character image and is out anyway,
    // so a reader who re-derives the list from that shape gets it wrong. The
    // panel narrows its picker to these seven, which is what keeps a mini-tool
    // entry out of the model list.
    expect([...IMAGE_GENERATION_MODES]).toEqual(["t2i", "i2i"]);
    expect([...AUDIO_GENERATION_MODES]).toEqual([
      "tts",
      "voice_clone",
      "sfx",
      "t2m",
      "a2m",
    ]);
    expect([...VIDEO_GENERATION_MODES]).toEqual([
      "t2v",
      "i2v",
      "first_last",
      "animate",
      "ref",
      "multi_shot",
      "talking_head",
    ]);

    // The five that belong to the mini-tool system. Offering one in the
    // Generate picker would let a user submit a text-to-video request against
    // a model that needs a source this panel does not collect, which the
    // backend source gate rejects with a 400.
    for (const miniTool of ["extend", "edit", "motion", "upscale", "interpolate"]) {
      expect(VIDEO_GENERATION_MODES).not.toContain(miniTool);
    }

    // The image list is an independent product decision that happens to share
    // a shape: neither list may leak into the other.
    for (const imageMode of IMAGE_GENERATION_MODES) {
      expect(VIDEO_GENERATION_MODES).not.toContain(imageMode);
    }
  });

  // The source-image predicates (requiresSourceImage / supportsTextToImage)
  // moved to the cross-modality gate (#1675): the rule now lives backend-side
  // in domain (source-requirement.ts, tested there) and reaches the frontend as
  // the precomputed ModelEntry.sourcesByMode wire field.

  it("drops a __proto__ param key without polluting the result prototype", () => {
    // JSON.parse yields a REAL own "__proto__" property (an object literal would
    // instead set the prototype at author time). The sanitizer must neither
    // crash, pollute the prototype, nor drop the legit sibling param.
    const raw = JSON.parse(
      '{"image":[{"name":"flux","display_name":"F","modality":"image","mode":"generate","description":"","guide":"","tier":"optional","cost_per_call":5,"generation_time":10,"params":{"__proto__":{"description":"","values":["x"],"default":"x"},"aspect_ratio":{"description":"","values":["1:1"],"default":"1:1"}},"providers":[]}],"video":[],"audio":[],"tts":[],"three_d":[],"total":1}',
    ) as unknown;
    const out = sanitizeModelCatalog(raw);
    const params = out.image[0]?.params;
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype); // not polluted
    expect(params?.aspect_ratio?.values).toEqual(["1:1"]); // legit sibling kept
  });

  // #1960 — two fields the audio panel reads. Both schemas here are plain
  // `z.object`s with no passthrough, so a field the backend sends but this
  // file never declares is stripped silently: the panel then renders without
  // it, typecheck stays green and no test elsewhere notices. These two cases
  // are the only place the wire→browser half of that chain is pinned.
  it("keeps the source groups the gate reads", () => {
    const groups = [{ mode: "a2m", any_of: ["song", "vocal", "melody"] }];
    const out = sanitizeModelCatalog(catalog([entry("mureka", { source_groups: groups })])).image[0];
    expect(out?.source_groups).toEqual(groups);
  });

  it("leaves the source groups undefined when a model declares none", () => {
    expect(sanitizeModelCatalog(catalog([entry("flux")])).image[0]?.source_groups).toBeUndefined();
  });

  it("keeps a model's input cap, which the panel refuses longer text by", () => {
    const raw = catalog([entry("elevenlabs-v3", { max_input_chars: 5000 })]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.max_input_chars).toBe(5000);
  });

  // Absent means uncapped, and a malformed one has to read the same way: a cap
  // invented here would refuse text the vendor accepts.
  it("leaves the cap undefined when a model declares none or a bad one", () => {
    expect(sanitizeModelCatalog(catalog([entry("flux")])).image[0]?.max_input_chars)
      .toBeUndefined();
    const bad = catalog([entry("flux", { max_input_chars: "lots" })]);
    expect(sanitizeModelCatalog(bad).image[0]?.max_input_chars).toBeUndefined();
  });

  // #269: the panel builds its controls out of these, and the schema strips
  // every key it does not name -- so a field missing from it reaches the
  // browser as absent and the control it describes is never drawn.
  it("keeps what a param declares about how it gets filled", () => {
    const raw = catalog([
      entry("kling", {
        params: {
          image: { description: "", default: null, fill: "canvas", accepts: "image" },
          video: {
            description: "",
            default: null,
            fill: "canvas",
            accepts: "video",
            optional: true,
            modes: ["ref"],
          },
          keep_original_sound: {
            description: "",
            default: true,
            fill: "panel",
            when: { flag_on: "enable_audio" },
          },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;

    expect(params?.image).toMatchObject({ fill: "canvas", accepts: "image" });
    expect(params?.video).toMatchObject({ optional: true, modes: ["ref"] });
    expect(params?.keep_original_sound?.when).toEqual({ flag_on: "enable_audio" });
  });

  it("draws no control for a fill it does not recognise", () => {
    // A name from a newer catalog than this build: drawing nothing is the
    // honest answer, where guessing a control would put a field on screen the
    // panel cannot fill.
    const raw = catalog([
      entry("flux", { params: { seed: { description: "", default: 0, fill: "telepathy" } } }),
    ]);

    expect(sanitizeModelCatalog(raw).image[0]?.params.seed?.fill).toBeUndefined();
  });

  it("keeps the storyboard fill and a list field's character cap", () => {
    // The storyboard control is drawn only for a param declaring this fill,
    // and each shot's cap comes from the catalog, not from the code.
    const raw = catalog([
      entry("kling", {
        params: {
          multi_prompt: {
            description: "",
            type: "items",
            max_items: 6,
            fill: "storyboard",
            fields: { prompt: { type: "text", max_chars: 512 }, duration: { values: [1, 2] } },
            default: null,
          },
        },
      }),
    ]);
    const shots = sanitizeModelCatalog(raw).image[0]?.params.multi_prompt;
    expect(shots?.fill).toBe("storyboard");
    expect(shots?.fields?.prompt?.max_chars).toBe(512);
  });

  it("keeps a param's remote_source, which names the picker that fills it", () => {
    const raw = catalog([
      entry("elevenlabs-v3", {
        params: {
          voice_id: { description: "", default: null, remote_source: "voices" },
        },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.params.voice_id?.remote_source).toBe("voices");
  });

  it("coerces an unknown remote_source to undefined but keeps the descriptor", () => {
    // An unrecognised name would send the panel looking for a picker that does
    // not exist; the param stays, it just renders as an ordinary one.
    const raw = catalog([
      entry("flux", {
        params: {
          seed: { description: "", default: 0, remote_source: "wat" },
        },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.params.seed?.remote_source).toBeUndefined();
    expect(out.image[0]?.params.seed?.default).toBe(0);
  });

  it("keeps a param's step, the increment a continuous control moves by", () => {
    // Bounds alone do not say how finely a value may be set: 0 to 1 is a
    // handful of stops for one param and a hundred for another, and the answer
    // belongs to the model, not to whichever control happens to render it.
    const raw = catalog([
      entry("elevenlabs-v3", {
        params: {
          similarity: { description: "", default: 0.75, min: 0, max: 1, step: 0.05 },
        },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.params.similarity?.step).toBe(0.05);
  });

  it("keeps a param's English label, shape and list fields, and leaves its upstream name behind", () => {
    const fields = { prompt: { type: "text" }, duration: { values: [1, 2, 3], default: 2 } };
    const raw = catalog([
      entry("kling", {
        params: {
          multi_prompt: {
            description: "",
            upstream: "multi_prompt",
            label: "Storyboard",
            type: "items",
            max_items: 6,
            fields,
            default: null,
          },
          negative_prompt: { description: "", type: "text", default: null },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;
    expect(params?.multi_prompt).not.toHaveProperty("upstream");
    expect(params?.multi_prompt).toMatchObject({
      label: "Storyboard",
      type: "items",
      max_items: 6,
      fields,
    });
    expect(params?.negative_prompt?.type).toBe("text");
  });

  it("keeps how shots are written into the prompt, and leaves what a value is sent as upstream behind", () => {
    const raw = catalog([
      entry("kling", {
        params: {
          auto_shots: {
            description: "",
            values: [true, false],
            upstream: "shot_type",
            upstream_values: { true: "intelligence" },
            default: false,
          },
          shots: { description: "", type: "items", into_prompt: "Shot {n}: {prompt}", default: null },
          broken: { description: "", values: ["a"], upstream_values: "a", into_prompt: 3, default: "a" },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;
    expect(params?.auto_shots).not.toHaveProperty("upstream_values");
    expect(params?.shots?.into_prompt).toBe("Shot {n}: {prompt}");
    expect(params?.broken?.into_prompt).toBeUndefined();
    expect(params?.broken?.values).toEqual(["a"]);
  });

  it("keeps how each value of a choice reads, and drops a malformed map", () => {
    const labels = { meanwhile: "Together", left_right: "Left first" };
    const raw = catalog([
      entry("talk", {
        params: {
          order: { description: "", values: ["meanwhile", "left_right"], value_labels: labels, default: "left_right" },
          motion: { description: "", values: ["low"], value_labels: "Low", default: "low" },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;
    expect(params?.order?.value_labels).toEqual(labels);
    expect(params?.motion?.value_labels).toBeUndefined();
    expect(params?.motion?.values).toEqual(["low"]);
  });

  it("keeps how a pool writes its chips, and drops a mention that is not text", () => {
    const raw = catalog([
      entry("seedance", {
        params: {
          images: { description: "", default: null, fill: "pool", accepts: "image", mention: "@image{n}" },
          videos: { description: "", default: null, fill: "pool", accepts: "video", mention: 3 },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;
    expect(params?.images?.mention).toBe("@image{n}");
    expect(params?.videos?.mention).toBeUndefined();
    expect(params?.videos?.accepts).toBe("video");
  });

  it("keeps how a style slot joins its pool, drops fields that are not text, and leaves item keys behind", () => {
    const raw = catalog([
      entry("gpt-edit", {
        params: {
          style_images: {
            description: "", default: null, fill: "canvas", accepts: "image", type: "list", max_items: 3,
            joins: "images", prompt_note: "{list} are style references.",
          },
          refs: { description: "", default: null, fill: "canvas", accepts: "image", type: "list", max_items: 3, item_key: "image" },
          broken: { description: "", default: null, fill: "canvas", accepts: "image", item_key: 1, joins: [], prompt_note: false },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;
    expect(params?.style_images?.joins).toBe("images");
    expect(params?.style_images?.prompt_note).toBe("{list} are style references.");
    expect(params?.refs).not.toHaveProperty("item_key");
    expect(params?.broken?.joins).toBeUndefined();
    expect(params?.broken?.prompt_note).toBeUndefined();
  });

  it("drops a non-numeric step but keeps the descriptor", () => {
    const raw = catalog([
      entry("flux", {
        params: { seed: { description: "", default: 0, min: 0, max: 1, step: "fine" } },
      }),
    ]);
    const out = sanitizeModelCatalog(raw);
    expect(out.image[0]?.params.seed?.step).toBeUndefined();
    expect(out.image[0]?.params.seed?.max).toBe(1);
  });
});

// inner#1691 (design 2.3): the 3D entries' conditions, conditional bounds,
// blank integers, text caps and forced values reach the panel intact.
describe("sanitizeModelCatalog — the declarations 3D generation adds", () => {
  const FORCES = [
    { id: "parts_geometry_only", when: { flag_on: "generate_parts" }, set: { texture: false, pbr: false }, lock: true },
    { id: "pbr_needs_texture", when: { flag_on: "pbr" }, set: { texture: true }, lock: true },
    {
      id: "fast_uses_v35",
      when: { flag_on: "texture", equals: { texture_quality: "fast" } },
      set: { texture_version: "v3.5" },
      lock: true,
    },
  ];

  it("keeps a condition on another param's value, conditional bounds, an integer type and a text cap", () => {
    const bounds = [
      { when: { flag_on: "smart_low_poly" }, min: 500, max: 20_000 },
      { when: { equals: { geometry_quality: "detailed" } }, max: 2_000_000 },
    ];
    const raw = catalog([
      entry("tripo-h3.1-t23d", {
        modality: "three_d",
        params: {
          delight: {
            description: "", default: true, fill: "panel", values: [true, false],
            when: { flag_on: "texture", equals: { texture_version: "v3.5" } },
          },
          face_limit: { description: "", default: null, fill: "panel", type: "integer", min: 1, max: 1_500_000, bounds },
          negative_prompt: { description: "", default: null, fill: "panel", type: "text", max_length: 255 },
        },
      }),
    ]);
    const params = sanitizeModelCatalog(raw).image[0]?.params;
    expect(params?.delight?.when).toEqual({ flag_on: "texture", equals: { texture_version: "v3.5" } });
    expect(params?.face_limit?.type).toBe("integer");
    expect(params?.face_limit?.bounds).toEqual(bounds);
    expect([params?.face_limit?.min, params?.face_limit?.max]).toEqual([1, 1_500_000]);
    expect(params?.negative_prompt?.max_length).toBe(255);
  });

  it("keeps a model's forced values in order and its prompt cap", () => {
    const out = sanitizeModelCatalog(catalog([entry("tripo-h3.1-t23d", { forces: FORCES, prompt_max_length: 1024 })]));
    expect(out.image[0]?.forces).toEqual(FORCES);
    expect(out.image[0]?.prompt_max_length).toBe(1024);
  });

  it.each([
    ["not a list", "parts_geometry_only"],
    ["a forced value with no id", [{ when: { flag_on: "pbr" }, set: { texture: true }, lock: true }]],
    ["a forced value with no set", [{ id: "pbr_needs_texture", when: { flag_on: "pbr" }, lock: true }]],
  ])("drops forced values that are %s and keeps the entry", (_case, forces) => {
    const out = sanitizeModelCatalog(catalog([entry("tripo-h3.1-t23d", { forces, prompt_max_length: "long" })]));
    expect(out.image.map((m) => m.name)).toEqual(["tripo-h3.1-t23d"]);
    expect(out.image[0]?.forces).toBeUndefined();
    expect(out.image[0]?.prompt_max_length).toBeUndefined();
    expect(out.image[0]?.params.aspect_ratio?.values).toEqual(["1:1", "16:9"]);
  });
});

describe("a node type that generates", () => {
  it("is image, video or audio", () => {
    expect(["image", "video", "audio"].map(isGenerationNodeType)).toEqual([true, true, true]);
  });

  it("is not any other node type, nor a name an object carries by inheritance", () => {
    expect(["text", "group", "annotation", "3d", "toString"].map(isGenerationNodeType)).toEqual([
      false, false, false, false, false,
    ]);
  });
});
