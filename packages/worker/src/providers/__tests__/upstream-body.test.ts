// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The request body a WaveSpeed endpoint receives, built from the model's own
 * declarations (#2156): each param under the upstream name the yaml gives it,
 * the prompt under the model's prompt field, and nothing the upstream would
 * read as a value when the run carries none.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { initCore } from "@breatic/core";
import { dialogueText, extractPromptText } from "@breatic/shared";
import type { FullModelEntry } from "@breatic/domain";

import { upstreamBody } from "@worker/providers/upstream-body.js";
import { entryOf, validateModelParams, type CatalogModality } from "@worker/providers/generate.js";

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test" });
});

/**
 * The body a run of a catalog model sends: its params pass the worker's
 * validation (which resolves them as `resolveParams` does), then `upstreamBody`.
 * @param modality - The model's catalog.
 * @param name - The model.
 * @param given - The job's params, prompt already lifted out.
 * @param prompt - The cleaned prompt.
 * @returns The upstream body.
 * @throws {Error} When the catalog has no such model.
 */
function catalogBody(modality: CatalogModality, name: string, given: Record<string, unknown>, prompt = ""): Record<string, unknown> {
  const [, validated] = validateModelParams(modality, name, given);
  return upstreamBody(entryOf(modality, name), validated, prompt);
}

const REF: FullModelEntry = {
  name: "ref-model",
  takes_prompt: true,
  params: {
    images: { upstream: "reference_images", fill: "pool", type: "list", default: null },
    duration: { fill: "panel", default: 5 },
    output_format: { fill: "none", default: "png" },
  },
};

const SPEECH: FullModelEntry = {
  name: "speech",
  takes_prompt: true,
  prompt_upstream: "text",
  params: { voice: { upstream: "voice_id", fill: "remote", default: null } },
};

const DRIVEN: FullModelEntry = {
  name: "driven",
  takes_prompt: false,
  params: { image: { fill: "canvas", default: null } },
};

const DIALOGUE: FullModelEntry = {
  name: "dialogue",
  takes_prompt: true,
  params: {
    speakers: {
      fill: "panel",
      type: "items",
      default: null,
      fields: { speaker: { type: "text" }, voice: { values: ["Kore", "Puck"] } },
    },
  },
};

describe("upstreamBody", () => {
  // inner#1304: the multi-angle tool's note may stay empty; the endpoint then gets no prompt field.
  it("sends no prompt field when the prompt is empty", () => {
    expect(upstreamBody(REF, { images: ["https://a/i.png"] }, "")).not.toHaveProperty("prompt");
  });

  it("sends each param under the name the model declares upstream", () => {
    expect(
      upstreamBody(REF, { images: ["https://a/i.png"], duration: 8, output_format: "png" }, "a pan"),
    ).toEqual({
      reference_images: ["https://a/i.png"],
      duration: 8,
      output_format: "png",
      prompt: "a pan",
    });
  });

  it("sends the prompt under the model's own prompt field", () => {
    expect(upstreamBody(SPEECH, { voice: "Alice" }, "hello")).toEqual({
      voice_id: "Alice",
      text: "hello",
    });
  });

  it("leaves out a param the run carries nothing for", () => {
    expect(upstreamBody(REF, { images: [], duration: 5, output_format: null }, "a pan")).toEqual({
      duration: 5,
      prompt: "a pan",
    });
    expect(upstreamBody(SPEECH, { voice: "" }, "hello")).toEqual({ text: "hello" });
  });

  it("sends no prompt to a model that reads none", () => {
    expect(upstreamBody(DRIVEN, { image: "https://a/i.png" }, "ignored")).toEqual({
      image: "https://a/i.png",
    });
  });

  it("sends no param the model does not declare", () => {
    expect(upstreamBody(DRIVEN, { image: "https://a/i.png", seed: 3 }, "")).toEqual({
      image: "https://a/i.png",
    });
  });

  it("leaves out the params a model's family consumes itself", () => {
    const camera: FullModelEntry = {
      name: "camera",
      takes_prompt: true,
      params: { enable_camera: { fill: "panel", default: false }, camera: { fill: "panel", default: "A" } },
    };
    expect(
      upstreamBody(camera, { enable_camera: true, camera: "A" }, "p", new Set(["enable_camera", "camera"])),
    ).toEqual({ prompt: "p" });
  });

  it("leaves a param out when it holds the value declared as sending nothing", () => {
    // "auto" is the upstream's own behaviour when the ratio is absent: follow
    // the input image.
    const edit: FullModelEntry = {
      name: "edit",
      takes_prompt: true,
      params: {
        aspect_ratio: { fill: "panel", values: ["auto", "1:1"], default: "auto", absent_value: "auto" },
      },
    };
    expect(upstreamBody(edit, { aspect_ratio: "auto" }, "p")).toEqual({ prompt: "p" });
    expect(upstreamBody(edit, { aspect_ratio: "1:1" }, "p")).toEqual({ aspect_ratio: "1:1", prompt: "p" });
  });

  it("sends a value as the upstream's spelling, and a switch left off as nothing", () => {
    const kling: FullModelEntry = {
      name: "kling",
      takes_prompt: true,
      params: {
        auto_shots: {
          fill: "panel",
          values: [true, false],
          default: false,
          absent_value: false,
          upstream: "shot_type",
          upstream_values: { true: "intelligence" },
        },
      },
    };
    expect(upstreamBody(kling, { auto_shots: true }, "p")).toEqual({ shot_type: "intelligence", prompt: "p" });
    expect(upstreamBody(kling, { auto_shots: false }, "p")).toEqual({ prompt: "p" });
  });

  it("keeps a param off the wire when the one that replaces it is sent", () => {
    // Gemini ignores its single voice once speakers are given; sending both
    // says two things about who reads the script.
    const gemini: FullModelEntry = {
      name: "gemini",
      takes_prompt: true,
      params: {
        speakers: { ...DIALOGUE.params!.speakers!, replaces: "voice_id" },
        voice_id: { fill: "remote", upstream: "voice", default: "Kore" },
      },
    };
    const pair = [
      { speaker: "Ada", voice: "Kore" },
      { speaker: "Bo", voice: "Puck" },
    ];
    expect(upstreamBody(gemini, { speakers: pair, voice_id: "Kore" }, "hi")).toEqual({
      speakers: pair,
      prompt: "hi",
    });
    expect(upstreamBody(gemini, { speakers: [], voice_id: "Kore" }, "hi")).toEqual({
      voice: "Kore",
      prompt: "hi",
    });
  });

  it("sends only the list entries with every field filled, and no list when none is", () => {
    // The editor adds a row with the name empty; a row left that way names
    // nobody, and the vendor reads a speaker with no name as a bad request.
    const rows = [
      { speaker: "Ada", voice: "Kore" },
      { speaker: "  ", voice: "Puck" },
      { speaker: "Bo", voice: "Nobody" },
      { speaker: "Cy" },
      "Dee",
    ];
    expect(upstreamBody(DIALOGUE, { speakers: rows }, "hi")).toEqual({
      speakers: [{ speaker: "Ada", voice: "Kore" }],
      prompt: "hi",
    });
    expect(upstreamBody(DIALOGUE, { speakers: [{ speaker: "", voice: "Kore" }] }, "hi")).toEqual({
      prompt: "hi",
    });
  });

  it("cleans each speaker's name as the script is cleaned, so the names the script reads are the names sent (round 3)", () => {
    const speakers = [{ speaker: "Mary  Ann", voice: "Kore" }, { speaker: "Leo\u200b", voice: "Puck" }];
    const script = extractPromptText(dialogueText([{ speaker: 1, text: "hi" }, { speaker: 2, text: "hello" }], speakers));
    const body = catalogBody("tts", "gemini-3.1-flash-text-to-speech", { speakers }, script) as { speakers: { speaker: string }[]; text?: string; prompt?: string };
    const said = (body.text ?? body.prompt ?? "").split("\n").map((line) => line.slice(0, line.indexOf(":")));
    expect(body.speakers.map((one) => one.speaker)).toEqual(said);
    expect(body.speakers[1]?.speaker).toBe("Leo");
  });

  it("cleans each storyboard shot's prompt and keeps its seconds (#2218)", () => {
    const [, validated] = validateModelParams("video", "kling-v3.0-4k-text-to-video", {
      multi_prompt: [
        { prompt: "<b>a boat</b>", duration: 2 },
        { prompt: "the pond\u200b <!-- x -->", duration: 3 },
      ],
    });
    expect(validated.multi_prompt).toEqual([
      { prompt: "a boat", duration: 2 },
      { prompt: "the pond", duration: 3 },
    ]);
  });

  it("sends a speaker's name without the spaces around it, the name the script reads (inner#1825 design 8.5)", () => {
    const script = dialogueText([{ speaker: 1, text: "Hello." }], [{ speaker: "Ava " }]);
    expect(upstreamBody(DIALOGUE, { speakers: [{ speaker: "Ava ", voice: "Kore" }] }, script)).toEqual({
      speakers: [{ speaker: "Ava", voice: "Kore" }],
      prompt: "Ava: Hello.",
    });
  });

  it("wraps each entry of a list under its item_key", () => {
    const krea: FullModelEntry = {
      name: "krea",
      takes_prompt: true,
      params: { style_images: { upstream: "reference", item_key: "image", fill: "canvas", type: "list", default: null } },
    };
    expect(upstreamBody(krea, { style_images: ["s1", "s2"] }, "A lighthouse.")).toEqual({
      prompt: "A lighthouse.",
      reference: [{ image: "s1" }, { image: "s2" }],
    });
  });

  it("folds a joining style slot into its pool and names it in the prompt", () => {
    const edit: FullModelEntry = {
      name: "edit",
      takes_prompt: true,
      params: {
        images: { upstream: "images", fill: "pool", type: "list", mention: "image {n}", default: null },
        style_images: {
          fill: "canvas",
          type: "list",
          joins: "images",
          prompt_note: "Style references: {list}. Apply their style to the result.",
          default: null,
        },
      },
    };
    expect(upstreamBody(edit, { images: ["a"], style_images: ["s1"] }, "Turn image 1 into a poster.")).toEqual({
      images: ["a", "s1"],
      prompt: "Turn image 1 into a poster. Style references: image 2. Apply their style to the result.",
    });
  });
});

describe("upstreamBody — Seedance 2.5 image-to-video from the real catalog", () => {
  it("sends the end frame as last_image beside the first frame", () => {
    const body = upstreamBody(
      entryOf("video", "seedance-2.5-image-to-video"),
      { image: "https://a/first.png", end_image: "https://a/last.png", resolution: "720p", duration: 5, generate_audio: true },
      "a pan",
    );
    expect(body).toEqual({
      prompt: "a pan",
      image: "https://a/first.png",
      last_image: "https://a/last.png",
      resolution: "720p",
      duration: 5,
      generate_audio: true,
    });
  });

  it("sends no last_image when the run carries no end frame", () => {
    const body = upstreamBody(entryOf("video", "seedance-2.5-image-to-video"), { image: "https://a/first.png", resolution: "480p", duration: 4 }, "a pan");
    expect(body).not.toHaveProperty("last_image");
    expect(body).toMatchObject({ image: "https://a/first.png", resolution: "480p", duration: 4 });
  });
});

/**
 * Tripo H3.1 on the catalog lane (inner#1691, design sections 2.1, 2.3 and 3).
 *
 * The body is built the way a run builds it: the params pass the worker's
 * validation (which resolves them as `resolveParams` does) and then
 * `upstreamBody`. The job carries the images as registered addresses in
 * front, left, back, right order, and the asset ids beside them for the task
 * list; only the addresses go upstream.
 */
describe("upstreamBody — Tripo H3.1 from the real 3D catalog (inner#1691)", () => {
  const FRONT = "https://cdn.example/image/front.png";
  const LEFT = "https://cdn.example/image/left.png";
  const BACK = "https://cdn.example/image/back.png";
  const RIGHT = "https://cdn.example/image/right.png";

  it("sends the single image entry its registered address under image", () => {
    const body = catalogBody("three_d", "tripo-h3.1-i23d", { image: FRONT, input_asset_ids: ["asset-front"] });
    expect(body.image).toBe(FRONT);
    expect(body).not.toHaveProperty("images");
  });

  it("sends the multi-view entry its addresses under images in front, left, back, right order", () => {
    const body = catalogBody("three_d", "tripo-h3.1-multiview", {
      images: [FRONT, LEFT, BACK, RIGHT],
      input_asset_ids: ["asset-front", "asset-left", "asset-back", "asset-right"],
    });
    expect(body.images).toEqual([FRONT, LEFT, BACK, RIGHT]);
  });

  it("keeps the asset ids the task list reads off the wire", () => {
    const single = catalogBody("three_d", "tripo-h3.1-i23d", { image: FRONT, input_asset_ids: ["asset-front"] });
    const multi = catalogBody("three_d", "tripo-h3.1-multiview", { images: [FRONT, LEFT], input_asset_ids: ["asset-front", "asset-left"] });
    expect(single).not.toHaveProperty("input_asset_ids");
    expect(multi).not.toHaveProperty("input_asset_ids");
  });

  it("sends no texture setting when texture is off, whatever quality the job carries", () => {
    const body = catalogBody("three_d", 
      "tripo-h3.1-t23d",
      { texture: false, pbr: false, texture_quality: "extreme", texture_version: "v3.5", delight: true, auto_size: true },
      "a wooden chair",
    );
    expect(body).not.toHaveProperty("texture_quality");
    expect(body).not.toHaveProperty("texture_version");
    expect(body).not.toHaveProperty("delight");
    expect(body).not.toHaveProperty("auto_size");
    expect(body.prompt).toBe("a wooden chair");
  });

  it("sends no integer the user left blank", () => {
    const body = catalogBody("three_d", 
      "tripo-h3.1-t23d",
      { face_limit: "", model_seed: null, texture_seed: undefined },
      "a wooden chair",
    );
    expect(body).not.toHaveProperty("face_limit");
    expect(body).not.toHaveProperty("model_seed");
    expect(body).not.toHaveProperty("texture_seed");
    expect(catalogBody("three_d", "tripo-h3.1-t23d", { face_limit: 8000, model_seed: 0 }, "a wooden chair")).toMatchObject({
      face_limit: 8000,
      model_seed: 0,
    });
  });

  it("refuses a negative prompt over 255 characters and takes one at 255", () => {
    expect(() => validateModelParams("three_d", "tripo-h3.1-t23d", { negative_prompt: "a".repeat(256) })).toThrow(/negative_prompt.*255|255.*negative_prompt/s);
    expect(() => validateModelParams("three_d", "tripo-h3.1-t23d", { negative_prompt: "a".repeat(255) })).not.toThrow();
    // Judged on the cleaned text, the one sent.
    const [, cleaned] = validateModelParams("three_d", "tripo-h3.1-t23d", { negative_prompt: `<p>${"a".repeat(255)}</p><!-- x -->\u200b` });
    expect(cleaned.negative_prompt).toBe("a".repeat(255));
  });
});

/**
 * Qwen3 TTS Voice Design (inner#1825 §8): a voice described in words. The
 * description has a neutral English default, so a run that names none still
 * speaks; one that empties it is refused before any body is sent.
 */
describe("upstreamBody — Qwen3 TTS Voice Design from the real tts catalog (inner#1825)", () => {
  it("sends the voice description cleaned of markup and invisible characters, as every text setting is (round 2)", () => {
    expect(catalogBody("tts", "qwen3-tts-voice-design", { voice_description: "<b>An old man, slow</b>\u200b", language: "English" }, "Hi.")).toMatchObject({
      voice_description: "An old man, slow",
    });
  });

  it("never sends a body with the voice description emptied (inner#1825)", () => {
    expect(() => catalogBody("tts", "qwen3-tts-voice-design", { voice_description: "", language: "English" }, "The night was long.")).toThrow(/voice_description/);
  });

  it("sends the line as text, with the described voice and the language", () => {
    expect(
      catalogBody("tts", "qwen3-tts-voice-design", { voice_description: "An old man, slow and gravelly", language: "English" }, "The night was long."),
    ).toEqual({
      text: "The night was long.",
      voice_description: "An old man, slow and gravelly",
      language: "English",
    });
  });

  it("sends the default English description and auto language when the run names neither", () => {
    const body = catalogBody("tts", "qwen3-tts-voice-design", {}, "Hello there.");
    expect(body.text).toBe("Hello there.");
    expect(body.language).toBe("auto");
    expect(typeof body.voice_description).toBe("string");
    // English, and long enough to describe a voice.
    expect(body.voice_description).toMatch(/^[\x20-\x7E]{20,}$/);
  });
});

/**
 * A param that switches on a call made after the model's own (inner#1692,
 * design 6.1) is the next call's switch, not the model's input: it never goes
 * into the model's own body. A param a call before the model reads still does.
 */
describe("upstreamBody — params that switch on a later call (inner#1692)", () => {
  const PRICE = { base_price: 10_000, formula: "", discount_rate: 100 };

  const RIGGED: FullModelEntry = {
    name: "rigged",
    takes_prompt: true,
    params: {
      texture: { fill: "panel", default: true, values: [true, false] },
      rig_skeleton: { fill: "panel", default: false, values: [true, false] },
      elements: { fill: "pool", type: "list", default: null },
    },
    extra_steps: [
      { endpoint: "vendor/before", at: "before", for_param: "elements", pricing: PRICE },
      { endpoint: "tripo3d/rig", at: "after", for_param: "rig_skeleton", optional: true, pricing: PRICE },
    ],
  };

  it("keeps the after step's switch off the body, on or off", () => {
    for (const rig_skeleton of [true, false]) {
      const body = upstreamBody(RIGGED, { texture: true, rig_skeleton }, "a knight");
      expect(body).toEqual({ texture: true, prompt: "a knight" });
    }
  });

  it("still sends a param a step before the model's own call reads", () => {
    expect(upstreamBody(RIGGED, { elements: ["https://a/1.png"], rig_skeleton: true }, "x")).toMatchObject({
      elements: ["https://a/1.png"],
    });
  });

  it("keeps rig_skeleton off every Tripo entry's body in the real catalog", () => {
    for (const name of ["tripo-h3.1-t23d", "tripo-h3.1-i23d", "tripo-h3.1-multiview"]) {
      const entry = entryOf("three_d", name);
      expect(entry.params?.rig_skeleton, name).toMatchObject({ default: false, fill: "panel" });
      expect(upstreamBody(entry, { rig_skeleton: true, image: "https://a/f.png", images: ["https://a/f.png"] }, "x")).not.toHaveProperty("rig_skeleton");
    }
  });
});

/**
 * Seedream 5.5's transparent background toggle (inner#1809). The endpoint's
 * own default, auto, lets the model choose a transparent picture from the
 * prompt, so the toggle sends opaque when off and the off state stays solid.
 */
describe("upstreamBody — Seedream 5.5 background from the real image catalog (inner#1809)", () => {
  const IMAGE = "https://cdn.example/image/pet.png";

  it.each([
    ["seedream-v5.5-text-to-image", {}],
    ["seedream-v5.5-edit", { images: [IMAGE] }],
  ])("%s asks for transparent when on and opaque when off or left alone", (name, base) => {
    expect(catalogBody("image", name, { ...base, transparency: true }).background).toBe("transparent");
    expect(catalogBody("image", name, { ...base, transparency: false }).background).toBe("opaque");
    expect(catalogBody("image", name, base).background).toBe("opaque");
    expect(catalogBody("image", name, base)).not.toHaveProperty("transparency");
  });
});
