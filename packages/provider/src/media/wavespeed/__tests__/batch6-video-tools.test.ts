// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 §11.2: the batch 6 video tools' model calls, sent through provider in our param names, reach WaveSpeed
 * with the same bodies the tools sent before provider.
 */

import { describe, expect, it } from "vitest";
import { catalog, resolvedParams, shipped } from "../../../config/__tests__/shipped.js";
import { buildBody } from "../../body.js";

const VIDEO = "https://cdn.example/video/clip.mp4";
const MASK = "https://cdn.example/video/mask.mp4";

/**
 * The WaveSpeed body of one run of a catalog model.
 * @param model - The model.
 * @param given - Our params.
 * @param prompt - The prompt.
 * @returns The body.
 */
function bodyOf(model: string, given: Record<string, unknown>, prompt = ""): Record<string, unknown> {
  const entry = catalog().models.find((m) => m.name === model);
  const binding = shipped().media.models[model]?.upstreams.find((b) => b.upstream === "wavespeed");
  if (!entry || !binding) throw new Error(`${model} has no catalog entry or WaveSpeed binding`);
  return buildBody(binding, { params: resolvedParams(entry, given), prompt });
}

describe("batch 6 video tool bodies", () => {
  it("erase sends the clip, its mask and no audio copy", () => {
    expect(bodyOf("bria-video-eraser-mask", { video: VIDEO, mask_video: MASK, copy_audio: false })).toEqual({ video: VIDEO, mask_video: MASK, copy_audio: false });
  });

  it("background removal asks for a transparent VP9 WebM keeping the audio", () => {
    expect(bodyOf("bria-fibo-video-background-remover", { video: VIDEO, background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true }))
      .toEqual({ video: VIDEO, background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true });
  });

  it("tracking sends one box on frame 0 with the prompt and reads the RLE", () => {
    const box = { frame_index: 0, object_id: 1, x_min: 10, y_min: 20, x_max: 110, y_max: 220 };
    expect(bodyOf("sam3-video-rle", { video: VIDEO, apply_mask: false, box_prompts: [box] }, "person"))
      .toMatchObject({ video: VIDEO, apply_mask: false, box_prompts: [box], prompt: "person" });
  });

  it("expansion sends the window, its mask, the frozen seed and the fixed inpainting settings", () => {
    const given = { video: VIDEO, mask_video: MASK, task: "inpainting", num_inference_steps: 30, guidance_scale: 5, flow_shift: 16, context_scale: 1, size: "832*480", duration: 5, seed: 1234 };
    expect(bodyOf("wan-2.1-14b-vace", given, "a beach")).toMatchObject({ ...given, prompt: "a beach" });
  });
});
