// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The music models, read off the real config.
 *
 * These read the config rather than a fixture because the failure they exist
 * to catch lives between two files: the worker builds its request from the
 * params a model DECLARES (`handlers/model-params.ts` drops anything else), so a
 * field the panel collects and the yaml does not name reaches the vendor as
 * nothing, and every browser-side test still passes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { getFullModelConfig, getModelCatalog, type FullModelEntry } from "@domain/model-catalog/model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeAll(useFullCatalog);
afterAll(restoreProcessEnv);

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
  // Music; each upstream's binding names the field it is sent as.
  it.each(["song", "melody", "vocal"])("takes %s as an optional audio slot of a2m", (param) => {
    expect(song().params?.[param]).toMatchObject({
      fill: "canvas",
      accepts: "audio",
      optional: true,
      modes: ["a2m"],
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

describe("every music model runs on WaveSpeed first", () => {
  it("puts WaveSpeed before every other upstream", () => {
    const music = getModelCatalog().audio.filter((m) =>
      (Array.isArray(m.mode) ? m.mode : [m.mode]).some((x) => x === "t2m" || x === "a2m"),
    );
    expect(music.length).toBeGreaterThan(0);
    for (const model of music) {
      expect(model.availability.upstreams[0]?.upstream, model.name).toBe("wavespeed");
    }
  });
});
