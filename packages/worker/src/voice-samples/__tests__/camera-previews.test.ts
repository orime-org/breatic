// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import type { FullModelEntry } from "@breatic/domain";

import { CAMERA_PREVIEW_SCENE, planCameraPreviews, previewTranscodeArgs } from "@worker/voice-samples/camera-previews.js";

const COMMANDS = [
  { name: "Pan left", sample_key: "camera-previews/h3/pan-left.mp4" },
  { name: "Static shot", sample_key: "camera-previews/h3/static-shot.mp4" },
];

const PARAMS = {
  aspect_ratio: { default: "16:9", values: ["16:9", "9:16"], fill: "panel" },
  duration: { default: 5, values: [5, 10], fill: "panel" },
  shots: { default: null, type: "items", modes: ["multi_shot"], fill: "storyboard" },
};

/**
 * A video entry as the yaml declares it.
 * @param name - Its name.
 * @param mode - Its modes.
 * @param commands - Its camera commands, if any.
 * @returns The entry.
 */
const entry = (name: string, mode: string[], commands?: typeof COMMANDS): FullModelEntry =>
  ({ name, mode, takes_prompt: true, params: PARAMS, camera_commands: commands });

describe("planCameraPreviews", () => {
  it("makes one clip per key with the text-to-video entry, at its own defaults", () => {
    const jobs = planCameraPreviews([
      entry("h3-i2v", ["i2v"], COMMANDS),
      entry("h3-t2v", ["t2v", "multi_shot"], COMMANDS),
      entry("veo", ["t2v"]),
    ]);
    expect(jobs).toEqual([
      {
        model: "h3-t2v",
        key: "camera-previews/h3/pan-left.mp4",
        body: { prompt: `${CAMERA_PREVIEW_SCENE} [Pan left]`, aspect_ratio: "16:9", duration: 5 },
      },
      {
        model: "h3-t2v",
        key: "camera-previews/h3/static-shot.mp4",
        body: { prompt: `${CAMERA_PREVIEW_SCENE} [Static shot]`, aspect_ratio: "16:9", duration: 5 },
      },
    ]);
  });

  it("sends the scene under the field the entry names for its prompt", () => {
    const named = { ...entry("h3-t2v", ["t2v"], COMMANDS), prompt_upstream: "text" } as FullModelEntry;
    const [job] = planCameraPreviews([named]);
    expect(job?.body.text).toBe(`${CAMERA_PREVIEW_SCENE} [Pan left]`);
    expect(job?.body).not.toHaveProperty("prompt");
  });

  it("refuses commands no text-to-video entry can make, naming the key", () => {
    expect(() => planCameraPreviews([entry("h3-i2v", ["i2v"], COMMANDS)])).toThrow(/camera-previews\/h3\/pan-left\.mp4/);
  });
});

describe("previewTranscodeArgs", () => {
  it("makes a small silent clip every browser plays, whose index sits at the front", () => {
    const args = previewTranscodeArgs("in.mp4", "out.mp4");
    expect(args[args.indexOf("-i") + 1]).toBe("in.mp4");
    expect(args.at(-1)).toBe("out.mp4");
    expect(args).toContain("-an");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=640:-2");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    // 4:2:0 chroma keeps the stream in a profile Safari and Firefox decode (High, not High 4:4:4); a 4:4:4 source would otherwise carry through.
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.indexOf("-crf") + 1]).toBe("30");
  });
});
