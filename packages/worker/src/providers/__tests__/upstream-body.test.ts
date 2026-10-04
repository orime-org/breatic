// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The request body a WaveSpeed endpoint receives, built from the model's own
 * declarations (#2156): each param under the upstream name the yaml gives it,
 * the prompt under the model's prompt field, and nothing the upstream would
 * read as a value when the run carries none.
 */

import { describe, it, expect } from "vitest";
import type { FullModelEntry } from "@breatic/domain";

import { upstreamBody } from "@worker/providers/upstream-body.js";

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
