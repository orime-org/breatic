// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import type { MediaBinding } from "../../config/schema.js";
import { buildBody } from "../body.js";

describe("buildBody — one binding at a time", () => {
  const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
  const binding: MediaBinding = {
    upstream: "wavespeed",
    weight: 1,
    model_id: "m",
    prompt_field: "text",
    params: {
      ratio: { field: "aspect_ratio", absent_value: "auto" },
      audio: { field: "generate_audio", values: { true: "on" }, absent_value: false },
      refs: { field: "images", item_key: "image" },
      dict: { field: "pronunciation_dict", transform: "pronunciation_pairs" },
    },
    pricing,
  };

  it("sends the prompt under the binding's prompt field, and none when it is empty", () => {
    expect(buildBody(binding, { prompt: "hi", params: {} })).toEqual({ text: "hi" });
    expect(buildBody(binding, { prompt: "", params: {} })).toEqual({});
  });

  it("sends no prompt for a binding without a prompt field", () => {
    expect(buildBody({ ...binding, prompt_field: undefined }, { prompt: "hi", params: {} })).toEqual({});
  });

  it("sends each param under its field and leaves out a param the binding does not name", () => {
    expect(buildBody(binding, { prompt: "", params: { ratio: "16:9", seed: 7 } })).toEqual({ aspect_ratio: "16:9" });
  });

  it("leaves a param out when it holds the binding's absent value", () => {
    expect(buildBody(binding, { prompt: "", params: { ratio: "auto", audio: false } })).toEqual({});
  });

  it("spells a value the upstream's way", () => {
    expect(buildBody(binding, { prompt: "", params: { audio: true } })).toEqual({ generate_audio: "on" });
  });

  it("wraps each list entry under the item key", () => {
    expect(buildBody(binding, { prompt: "", params: { refs: ["u1", "u2"] } })).toEqual({ images: [{ image: "u1" }, { image: "u2" }] });
  });

  it("writes each complete pronunciation entry as text/pronunciation, in order, and leaves the field out when none is complete", () => {
    expect(buildBody(binding, { prompt: "", params: { dict: [{ text: "Breatic", pronunciation: "bree-attic" }, { text: "x", pronunciation: "" }, { text: " a ", pronunciation: " b " }] } })).toEqual({
      pronunciation_dict: ["Breatic/bree-attic", "a/b"],
    });
    expect(buildBody(binding, { prompt: "", params: { dict: [{ text: "x", pronunciation: "" }] } })).toEqual({});
  });
});


describe("buildBody — reseller binding vocabulary", () => {
  const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
  const base = { upstream: "fal", weight: 2, model_id: "m", pricing };

  it("writes a dotted field under nested objects and merges fields of one object", () => {
    const binding = {
      ...base,
      params: {
        voice_id: { field: "voice_setting.voice_id" },
        speed: { field: "voice_setting.speed" },
        emotion: { field: "voice_setting.emotion" },
      },
    } as MediaBinding;
    expect(buildBody(binding, { prompt: "", params: { voice_id: "Wise_Woman", speed: 1.2, emotion: "happy" } })).toEqual({
      voice_setting: { voice_id: "Wise_Woman", speed: 1.2, emotion: "happy" },
    });
  });

  it("writes a transformed value under a dotted field", () => {
    const binding = { ...base, params: { dict: { field: "pronunciation_dict.tone_list", transform: "pronunciation_pairs" } } } as MediaBinding;
    expect(buildBody(binding, { prompt: "", params: { dict: [{ text: "Breatic", pronunciation: "bree-attic" }] } })).toEqual({
      pronunciation_dict: { tone_list: ["Breatic/bree-attic"] },
    });
  });

  it("converts a value to a string, a number or a one-item list after mapping it", () => {
    const binding = {
      ...base,
      params: {
        duration: { field: "duration", as: "string" },
        seconds: { field: "seconds", values: { short: "5" }, as: "number" },
        video: { field: "video_urls", as: "list" },
      },
    } as MediaBinding;
    expect(buildBody(binding, { prompt: "", params: { duration: 7, seconds: "short", video: "https://v.example/a.mp4" } })).toEqual({
      duration: "7",
      seconds: 5,
      video_urls: ["https://v.example/a.mp4"],
    });
  });

  it("renames, maps and converts the sub-fields of every item, and leaves out sub-fields the binding does not name", () => {
    const binding = {
      ...base,
      params: {
        speakers: { field: "speakers", item_fields: { speaker: { field: "speaker_id" }, voice: { field: "voice", values: { Kore: "kore" } } } },
        shots: { field: "multi_prompt", item_fields: { prompt: { field: "prompt" }, duration: { field: "duration", as: "string" } } },
      },
    } as MediaBinding;
    const body = buildBody(binding, {
      prompt: "",
      params: {
        speakers: [{ speaker: "Ann", voice: "Kore", note: "x" }, { speaker: "Bo", voice: "Puck" }],
        shots: [{ prompt: "a", duration: 3 }],
      },
    });
    expect(body).toEqual({
      speakers: [{ speaker_id: "Ann", voice: "kore" }, { speaker_id: "Bo", voice: "Puck" }],
      multi_prompt: [{ prompt: "a", duration: "3" }],
    });
  });

  it("writes a dotted fixed field into the object it names, beside a param's field there", () => {
    const binding = { ...base, params: { voice: { field: "voice_setting.voice_id" } }, fixed: { "voice_setting.emotion": "happy" } } as MediaBinding;
    expect(buildBody(binding, { prompt: "", params: { voice: "v1" } })).toEqual({ voice_setting: { voice_id: "v1", emotion: "happy" } });
  });

  it("adds the binding's fixed fields to every body", () => {
    const binding = { ...base, prompt_field: "prompt", fixed: { rendering_speed: "QUALITY", mode: "async" } } as MediaBinding;
    expect(buildBody(binding, { prompt: "a cat", params: {} })).toEqual({ prompt: "a cat", rendering_speed: "QUALITY", mode: "async" });
  });
});

describe("buildBody — a dialogue script sent as turns (#1521)", () => {
  const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
  const binding: MediaBinding = {
    upstream: "wavespeed",
    weight: 1,
    model_id: "m",
    prompt_field: "text",
    params: {
      speakers: { field: "speakers", item_fields: { speaker: { field: "speaker_id" }, voice: { field: "voice" } } },
      voice_id: { field: "voice" },
    },
    dialogue: { speakers: "speakers", name: "speaker", field: "turns", speaker_field: "speaker_id", text_field: "text" },
    pricing,
  };
  const pair = [{ speaker: "Ava", voice: "Kore" }, { speaker: "Leo", voice: "Puck" }];

  it("sends each `Name: line` as a turn of that speaker and leaves the prompt field out", () => {
    expect(buildBody(binding, { prompt: "Ava: Hi there.\nLeo: Hello, Ava.", params: { speakers: pair } })).toEqual({
      speakers: [{ speaker_id: "Ava", voice: "Kore" }, { speaker_id: "Leo", voice: "Puck" }],
      turns: [{ speaker_id: "Ava", text: "Hi there." }, { speaker_id: "Leo", text: "Hello, Ava." }],
    });
  });

  it("matches a name with spaces, and the longer of two names that share a start", () => {
    const speakers = [{ speaker: "Al", voice: "Kore" }, { speaker: "Al Smith", voice: "Puck" }];
    expect(buildBody(binding, { prompt: "Al Smith: One.\nAl: Two: three.", params: { speakers } }).turns).toEqual([
      { speaker_id: "Al Smith", text: "One." },
      { speaker_id: "Al", text: "Two: three." },
    ]);
  });

  it("matches a name with spaces around it as the script writes it, trimmed, and sends it as the speakers list carries it", () => {
    const speakers = [{ speaker: "Ava", voice: "Kore" }, { speaker: " Leo ", voice: "Puck" }];
    expect(buildBody(binding, { prompt: "Ava: Hi.\nLeo: Hello.", params: { speakers } }).turns).toEqual([
      { speaker_id: "Ava", text: "Hi." },
      { speaker_id: " Leo ", text: "Hello." },
    ]);
  });

  it("skips blank lines and gives a line naming no speaker to the first one, whole", () => {
    expect(buildBody(binding, { prompt: "\nAva: Hi.\n  \nSomeone: who?\n", params: { speakers: pair } }).turns).toEqual([
      { speaker_id: "Ava", text: "Hi." },
      { speaker_id: "Ava", text: "Someone: who?" },
    ]);
  });

  it("sends the prompt as it is when the run names no speakers", () => {
    expect(buildBody(binding, { prompt: "Hello.", params: { voice_id: "Kore" } })).toEqual({ text: "Hello.", voice: "Kore" });
    expect(buildBody(binding, { prompt: "Hello.", params: { speakers: [], voice_id: "Kore" } })).toEqual({ text: "Hello.", voice: "Kore" });
  });

  it("sends no turns when the script has no words", () => {
    expect(buildBody(binding, { prompt: "", params: { speakers: pair } })).toEqual({
      speakers: [{ speaker_id: "Ava", voice: "Kore" }, { speaker_id: "Leo", voice: "Puck" }],
    });
  });

  it("reads speakers that are not what they claim to be as no speakers, as collaborative data can be anything", () => {
    expect(buildBody(binding, { prompt: "Hi.", params: { speakers: "Ava" } })).toEqual({ text: "Hi.", speakers: "Ava" });
    expect(buildBody(binding, { prompt: "Ava: Hi.", params: { speakers: [null, { speaker: 3 }] } }).turns).toBeUndefined();
  });
});
