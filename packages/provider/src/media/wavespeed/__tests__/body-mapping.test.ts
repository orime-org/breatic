// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import type { MediaBinding } from "../../../config/schema.js";
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

