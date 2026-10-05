// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  CAMERA_COMMANDS,
  CAMERA_COMMAND_AXES,
  CAMERA_COMMANDS_PER_BRACKET,
  STATIC_SHOT,
} from "../camera-commands.js";
import { modelCatalogSchema } from "../types/model-catalog.js";

describe("the camera command vocabulary", () => {
  it("lists the fifteen commands MiniMax documents, once each", () => {
    expect([...CAMERA_COMMANDS].sort()).toEqual(
      [
        "Truck left", "Truck right", "Pan left", "Pan right", "Push in", "Pull out",
        "Pedestal up", "Pedestal down", "Tilt up", "Tilt down", "Zoom in", "Zoom out",
        "Shake", "Tracking shot", "Static shot",
      ].sort(),
    );
  });

  it("pairs the six axes from commands in the vocabulary, each command on one axis at most", () => {
    expect(CAMERA_COMMAND_AXES).toHaveLength(6);
    const onAxis = CAMERA_COMMAND_AXES.flat();
    expect(new Set(onAxis).size).toBe(onAxis.length);
    for (const name of onAxis) expect(CAMERA_COMMANDS).toContain(name);
  });

  it("names the still camera and the per-bracket cap MiniMax recommends", () => {
    expect(STATIC_SHOT).toBe("Static shot");
    expect(CAMERA_COMMANDS_PER_BRACKET).toBe(3);
  });
});

describe("camera commands on the wire", () => {
  /**
   * Parses one video entry carrying the given camera commands.
   * @param camera_commands - What the entry carries.
   * @returns The parsed entry.
   */
  const parse = (camera_commands: unknown): Record<string, unknown> => {
    const catalog = modelCatalogSchema.parse({
      video: [
        {
          name: "m",
          display_name: "M",
          modality: "video",
          mode: "t2v",
          description: "",
          guide: "",
          tier: "optional",
          generation_time: 60,
          params: {},
          providers: [],
          takes_prompt: true,
          camera_commands,
        },
      ],
    });
    return catalog.video[0] as unknown as Record<string, unknown>;
  };

  it("keeps each command's name and preview address", () => {
    const commands = [{ name: "Pan left", preview_url: "https://samples.test/camera-previews/h3/pan-left.mp4" }];
    expect(parse(commands).camera_commands).toEqual(commands);
  });

  it("drops a malformed list rather than the model", () => {
    expect(parse([{ name: 3 }]).camera_commands).toBeUndefined();
    expect(parse(undefined).camera_commands).toBeUndefined();
  });
});
