// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The music models, read off the real config.
 *
 * These read the config rather than a fixture because the failure they exist
 * to catch lives between two files: the worker builds its request from the
 * params a model DECLARES (`providers/shared.ts` drops anything else), so a
 * field the panel collects and the yaml does not name reaches the vendor as
 * nothing, and every browser-side test still passes.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig, type FullModelEntry } from "@domain/model-catalog/model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

/**
 * The audio bucket's entry for a model name.
 * @param name - Model id as the catalog spells it.
 * @returns The full config entry.
 * @throws {Error} When the catalog has no such audio model.
 */
function audioEntry(name: string): FullModelEntry {
  const found = getFullModelConfig("audio").models.find((m) => m.name === name);
  if (!found) throw new Error(`no audio model named ${name}`);
  return found;
}

describe("Mureka V9.5 Song", () => {
  const song = (): FullModelEntry => audioEntry("mureka-v9.5-generate-song");

  it("serves both music modes", () => {
    expect(song().mode).toEqual(["t2m", "a2m"]);
  });

  it("collects lyrics in the lyrics editor", () => {
    expect(song().params?.lyrics).toMatchObject({ fill: "editor" });
  });

  // Reference song, melody and vocal are three audio slots of Reference to
  // Music, each sent to the upstream under its own id field.
  it.each([
    ["song", "reference_id"],
    ["melody", "melody_id"],
    ["vocal", "vocal_id"],
  ])("takes %s as an optional audio slot of a2m, sent as %s", (param, upstream) => {
    expect(song().params?.[param]).toMatchObject({
      fill: "canvas",
      accepts: "audio",
      optional: true,
      modes: ["a2m"],
      upstream,
    });
  });

  it("needs at least one of the three in a2m", () => {
    expect(song().source_groups).toEqual([{ mode: "a2m", any_of: ["song", "vocal", "melody"] }]);
  });
});

describe("Lyria 3 Pro", () => {
  it("takes one optional reference image", () => {
    expect(audioEntry("lyria-3-pro-music").params?.image).toMatchObject({
      fill: "canvas",
      accepts: "image",
      optional: true,
    });
  });
});

describe("every music model runs on WaveSpeed", () => {
  it("lists WaveSpeed and nothing else", () => {
    const music = getFullModelConfig("audio").models.filter((m) =>
      (Array.isArray(m.mode) ? m.mode : [m.mode]).some((x) => x === "t2m" || x === "a2m"),
    );
    expect(music.length).toBeGreaterThan(0);
    for (const model of music) {
      expect((model.providers ?? []).map((p) => p.name), model.name).toEqual(["wavespeed"]);
    }
  });
});
