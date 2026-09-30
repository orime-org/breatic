// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upstream calls one run makes, drawn from the model's declaration and
 * what this run carries (#2156, design §15.1).
 */

import { describe, it, expect } from "vitest";
import type { FullModelEntry } from "@breatic/domain";

import { planSteps } from "@worker/providers/plan-steps.js";

const PRICE = { base_price: 10_000, formula: "", discount_rate: 100 };

const SONG: FullModelEntry = {
  name: "mureka-v9.5-generate-song",
  takes_prompt: true,
  params: { song: {}, melody: {}, vocal: {}, lyrics: {} },
  extra_steps: [
    { endpoint: "mureka-ai/create-upload-id", at: "before", for_param: "song", pricing: PRICE },
    { endpoint: "mureka-ai/create-upload-id", at: "before", for_param: "melody", pricing: PRICE },
    { endpoint: "mureka-ai/vocal-clone", at: "before", for_param: "vocal", reused: true, pricing: PRICE },
  ],
  providers: [{ name: "wavespeed", model_id: "mureka-ai/mureka-v9.5/generate-song" }],
};

const VOICE_CLONE: FullModelEntry = {
  name: "minimax-voice-clone",
  takes_prompt: true,
  reused_by: "audio",
  params: { audio: {} },
  extra_steps: [{ endpoint: "minimax/speech-2.8-hd", at: "after", pricing: PRICE }],
  providers: [{ name: "wavespeed", model_id: "minimax/voice-clone" }],
};

const KLING: FullModelEntry = {
  name: "kling-video-o3-4k-image-to-video",
  takes_prompt: true,
  params: { image: {}, elements: { type: "list" } },
  extra_steps: [
    { endpoint: "kwaivgi/kling-elements", at: "before", for_param: "elements", per_item: true, reused: true, pricing: PRICE },
  ],
  providers: [{ name: "wavespeed", model_id: "kwaivgi/kling-video-o3-4k/image-to-video" }],
};

const PLAIN: FullModelEntry = {
  name: "plain",
  takes_prompt: true,
  providers: [{ name: "wavespeed", model_id: "vendor/plain" }],
};

/**
 * The plan as `kind@endpoint[#item]` strings, for compact assertions.
 * @param entry - The model.
 * @param params - The run's params.
 * @returns One string per step.
 */
function shape(entry: FullModelEntry, params: Record<string, unknown>): string[] {
  return planSteps(entry, params).map(
    (s) => `${s.kind}@${s.endpoint}${s.itemIndex === null ? "" : `#${s.itemIndex}`}`,
  );
}

describe("planSteps", () => {
  it("is the model's own call alone for a model with no extra steps", () => {
    expect(shape(PLAIN, { prompt: "x" })).toEqual(["generate@vendor/plain"]);
  });

  it("uploads each Mureka source the run carries, clones the vocal, then generates", () => {
    expect(shape(SONG, { song: "https://a/s.mp3", melody: "https://a/m.mp3", vocal: "https://a/v.mp3" })).toEqual([
      "upload_reference@mureka-ai/create-upload-id",
      "upload_melody@mureka-ai/create-upload-id",
      "vocal@mureka-ai/vocal-clone",
      "generate@mureka-ai/mureka-v9.5/generate-song",
    ]);
  });

  it("leaves out the steps for Mureka sources the run does not carry", () => {
    expect(shape(SONG, { vocal: "https://a/v.mp3", song: null, melody: "" })).toEqual([
      "vocal@mureka-ai/vocal-clone",
      "generate@mureka-ai/mureka-v9.5/generate-song",
    ]);
  });

  it("clones the voice with the model's own call, then speaks with it", () => {
    expect(shape(VOICE_CLONE, { audio: "https://a/v.mp3" })).toEqual([
      "voice@minimax/voice-clone",
      "speak@minimax/speech-2.8-hd",
    ]);
  });

  it("makes one element per reference image, before the video", () => {
    expect(shape(KLING, { image: "https://a/f.png", elements: ["https://a/1.png", "https://a/2.png"] })).toEqual([
      "element@kwaivgi/kling-elements#0",
      "element@kwaivgi/kling-elements#1",
      "generate@kwaivgi/kling-video-o3-4k/image-to-video",
    ]);
  });

  it("makes no element for a run without reference images", () => {
    expect(shape(KLING, { image: "https://a/f.png", elements: [] })).toEqual([
      "generate@kwaivgi/kling-video-o3-4k/image-to-video",
    ]);
  });

  it("refuses an extra step whose endpoint the worker cannot run", () => {
    const unknown: FullModelEntry = {
      ...PLAIN,
      extra_steps: [{ endpoint: "vendor/unknown", at: "before", pricing: PRICE }],
    };
    expect(() => planSteps(unknown, {})).toThrow("No step runs vendor/unknown");
  });
});
