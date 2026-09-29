// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A mini-tool request carries the fields the slot's model reads (#2156,
 * design §7). The worker drops any field the model does not declare, so a
 * field under an old model's name reaches nobody.
 */

import { describe, it, expect } from "vitest";

import { audioToolSchema, imageToolSchema, videoToolSchema } from "@server/routes/schemas.js";

const BINDING = {
  project_id: "00000000-0000-4000-8000-000000000001",
  space_id: "00000000-0000-4000-8000-000000000002",
  target_node_id: "00000000-0000-4000-8000-000000000003",
};

describe("image mini-tool requests", () => {
  it("turns a target resolution into the megapixels the upscaler reads, by the source's shape", () => {
    // The long edge becomes the target; the short edge follows the ratio.
    const wide = imageToolSchema.parse({
      ...BINDING,
      tool: "upscale",
      image: "https://cdn/i.png",
      output_resolution: "4k",
      source_width: 2000,
      source_height: 1000,
    });
    expect(wide).toMatchObject({ target_megapixels: (4096 * 2048) / 1_000_000 });
    expect(wide).not.toHaveProperty("output_resolution");
    expect(wide).not.toHaveProperty("source_width");

    const square = imageToolSchema.parse({ ...BINDING, tool: "upscale", image: "https://cdn/i.png", output_resolution: "2k" });
    expect(square).toMatchObject({ target_megapixels: (2048 * 2048) / 1_000_000 });

    const plain = imageToolSchema.parse({ ...BINDING, tool: "upscale", image: "https://cdn/i.png" });
    expect(plain).not.toHaveProperty("target_megapixels");
  });
});

describe("video mini-tool requests", () => {
  it("names the edit's reference pictures the way the model reads them", () => {
    const edit = videoToolSchema.parse({
      ...BINDING,
      tool: "edit",
      video: "https://cdn/v.mp4",
      prompt: "make it night",
      reference_images: ["https://cdn/r.png"],
    });
    expect(edit).toMatchObject({ reference_images: ["https://cdn/r.png"] });
  });

  it("requires what the extend and motion models cannot run without", () => {
    expect(() => videoToolSchema.parse({ ...BINDING, tool: "extend", video: "https://cdn/v.mp4" })).toThrow();
    expect(() => videoToolSchema.parse({ ...BINDING, tool: "motion", image: "https://cdn/i.png" })).toThrow();
  });

  // Each against the endpoint's own `required` list: Wan 3.0 video edit needs
  // a prompt, Wan 2.2 Animate needs the picture as well as the clip.
  it("requires what the edit and animate models cannot run without", () => {
    expect(() => videoToolSchema.parse({ ...BINDING, tool: "edit", video: "https://cdn/v.mp4", prompt: "" })).toThrow();
    expect(() => videoToolSchema.parse({ ...BINDING, tool: "animate", video: "https://cdn/v.mp4" })).toThrow();
  });

  it("takes the upscale's target resolution and carries no interpolation multiplier", () => {
    const upscale = videoToolSchema.parse({ ...BINDING, tool: "upscale", video: "https://cdn/v.mp4", target_resolution: "4k" });
    expect(upscale).toMatchObject({ target_resolution: "4k" });
    const interpolate = videoToolSchema.parse({ ...BINDING, tool: "interpolate", video: "https://cdn/v.mp4", multiplier: 4 });
    expect(interpolate).not.toHaveProperty("multiplier");
  });
});

describe("audio mini-tool requests", () => {
  // SFX 1.6 needs its text prompt; both speech models need the words to say.
  it("refuses an empty prompt or text the model cannot run without", () => {
    expect(() => audioToolSchema.parse({ ...BINDING, tool: "sfx", prompt: "" })).toThrow();
    expect(() => audioToolSchema.parse({ ...BINDING, tool: "tts", text: "" })).toThrow();
    expect(() => audioToolSchema.parse({ ...BINDING, tool: "voice-clone", text: "", audio: "https://cdn/a.mp3" })).toThrow();
  });

  it("names the sound effect's length the way the model reads it", () => {
    const sfx = audioToolSchema.parse({ ...BINDING, tool: "sfx", prompt: "rain", duration: 6, loop: true, prompt_influence: 0.5 });
    expect(sfx).toMatchObject({ duration: 6, loop: true });
    expect(sfx).not.toHaveProperty("prompt_influence");
  });

  it("leaves the voice to the model's own default and carries no reference text", () => {
    const tts = audioToolSchema.parse({ ...BINDING, tool: "tts", text: "hello" });
    expect(tts).not.toHaveProperty("voice_id");
    const clone = audioToolSchema.parse({
      ...BINDING,
      tool: "voice-clone",
      text: "hello",
      audio: "https://cdn/a.mp3",
      reference_text: "hi",
    });
    expect(clone).not.toHaveProperty("reference_text");
  });
});
