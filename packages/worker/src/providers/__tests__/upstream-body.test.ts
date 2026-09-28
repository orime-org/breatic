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
});
