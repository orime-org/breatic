// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1241 — the MiniMax H3 entries declare the camera commands a reader can
 * write into the prompt, and the wire carries each one's preview address.
 *
 * Read off the real config: the point is that the three H3 entries declare all
 * fifteen, which only the real files can answer.
 */

import { CAMERA_COMMANDS } from "@breatic/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { assertCameraCommands } from "../camera-commands.js";
import { getFullModelConfig, getModelCatalog } from "../model-catalog.js";
import { voiceSampleUrl } from "../voice-sample-config.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

const H3 = ["minimax-h3-text-to-video", "minimax-h3-image-to-video", "minimax-h3-reference-to-video"];

describe("what the H3 entries declare", () => {
  it("declares every official command, each with a whitespace-free preview key", () => {
    const models = getFullModelConfig("video").models.filter((m) => H3.includes(m.name));
    expect(models.map((m) => m.name).sort()).toEqual([...H3].sort());
    for (const model of models) {
      const declared = model.camera_commands ?? [];
      expect(declared.map((c) => c.name).sort(), model.name).toEqual([...CAMERA_COMMANDS].sort());
      for (const command of declared) {
        expect(command.sample_key, `${model.name} ${command.name}`).toMatch(/^camera-previews\/\S+\.mp4$/);
      }
    }
  });

  it("gives every H3 entry the same clips, since one model makes them all", () => {
    const keys = getFullModelConfig("video").models
      .filter((m) => H3.includes(m.name))
      .map((m) => JSON.stringify(m.camera_commands));
    expect(new Set(keys).size).toBe(1);
  });
});

describe("the loader's check", () => {
  /**
   * Runs the check over one model declaring these commands.
   * @param commands - What the model declares.
   * @returns Nothing; throws when refused.
   */
  const check = (commands: unknown): void =>
    assertCameraCommands("video", [{ name: "m", camera_commands: commands }]);

  it("accepts a model with no commands and one with official ones", () => {
    expect(() => check(undefined)).not.toThrow();
    expect(() => check([{ name: "Pan left", sample_key: "camera-previews/m/pan-left.mp4" }])).not.toThrow();
  });

  it("refuses a name MiniMax does not document, naming the model and the name", () => {
    expect(() => check([{ name: "Dolly zoom", sample_key: "camera-previews/m/dolly.mp4" }])).toThrow(
      /config\/models\/video: m declares camera command 'Dolly zoom'/,
    );
  });

  it("refuses a duplicate, a missing key and a key with whitespace", () => {
    expect(() =>
      check([
        { name: "Pan left", sample_key: "camera-previews/m/a.mp4" },
        { name: "Pan left", sample_key: "camera-previews/m/b.mp4" },
      ]),
    ).toThrow(/Pan left/);
    expect(() => check([{ name: "Pan left" }])).toThrow(/Pan left/);
    expect(() => check([{ name: "Pan left", sample_key: "camera-previews/m/pan left.mp4" }])).toThrow(/Pan left/);
  });

  it("refuses two commands sharing one clip, which would preview one as the other", () => {
    expect(() =>
      check([
        { name: "Pan left", sample_key: "camera-previews/m/pan-left.mp4" },
        { name: "Pan right", sample_key: "camera-previews/m/pan-left.mp4" },
      ]),
    ).toThrow(/Pan right.*camera-previews\/m\/pan-left\.mp4/);
  });
});

describe("what the wire carries", () => {
  beforeEach(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("ships each H3 command with the address its clip plays from", () => {
    const declared = getFullModelConfig("video").models.find((m) => m.name === H3[0])?.camera_commands ?? [];
    const shipped = getModelCatalog().video.find((m) => m.name === H3[0])?.camera_commands;
    expect(shipped).toEqual(declared.map((c) => ({ name: c.name, preview_url: voiceSampleUrl(c.sample_key) })));
  });

  it("ships none for a model that declares none", () => {
    const others = getModelCatalog().video.filter((m) => !H3.includes(m.name));
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((m) => m.camera_commands !== undefined).map((m) => m.name)).toEqual([]);
  });
});
