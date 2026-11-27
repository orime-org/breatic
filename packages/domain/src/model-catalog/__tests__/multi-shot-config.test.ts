// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Multi-shot as a control inside the modes, read off the real config: which
 * mode each model can write shots in, how it takes them (Kling through its own
 * `multi_prompt` field, the rest written into the prompt one timed line per
 * shot), and which model each mode opens on now that there is no separate
 * multi-shot mode (inner#2192).
 */

import { initCore } from "@breatic/core";
import { modelLabel, storyboardSpec, VIDEO_GENERATION_MODES, type ParamDescriptor } from "@breatic/shared";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig, type FullModelEntry } from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

/** Each model that takes shots, with the modes it takes them in. */
const SHOT_MODES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["gemini-omni-1.1-flash-text-to-video", ["t2v"]],
  ["wan-3.0-text-to-video", ["t2v"]],
  ["seedance-2.5-text-to-video", ["t2v", "ref"]],
  ["minimax-h3-text-to-video", ["t2v"]],
  ["kling-v3.0-4k-text-to-video", ["t2v"]],
  ["gemini-omni-1.1-flash-image-to-video", ["i2v"]],
  ["minimax-h3-image-to-video", ["i2v"]],
  ["wan-3.0-image-to-video", ["i2v"]],
  ["seedance-2.5-image-to-video", ["i2v"]],
  ["kling-video-o3-4k-image-to-video", ["i2v"]],
  ["minimax-h3-reference-to-video", ["ref"]],
  ["gemini-omni-1.1-flash-reference-to-video", ["ref"]],
  ["wan-3.0-reference-to-video", ["ref"]],
  ["happyhorse-1.1-reference-to-video", ["ref"]],
];

const KLING = new Set(["kling-v3.0-4k-text-to-video", "kling-video-o3-4k-image-to-video"]);

/**
 * The video bucket's entry for a model name.
 * @param name - Model id as the catalog spells it.
 * @returns The full config entry.
 * @throws {Error} When the catalog has no such video model.
 */
function videoEntry(name: string): FullModelEntry {
  const found = getFullModelConfig("video").models.find((m) => m.name === name);
  if (!found) throw new Error(`no video model named ${name}`);
  return found;
}

/**
 * A model's params as the shared helpers read them.
 * @param name - Model id.
 * @returns Its declared params.
 */
function paramsOf(name: string): Record<string, ParamDescriptor> {
  return (videoEntry(name).params ?? {}) as Record<string, ParamDescriptor>;
}

/**
 * The modes a model serves.
 * @param entry - The model's config entry.
 * @returns Its modes.
 */
function modesOf(entry: FullModelEntry): string[] {
  return [entry.mode].flat();
}

/**
 * The longest total a model's duration control offers.
 * @param entry - The model's config entry.
 * @returns Its largest value, or its max for a range.
 */
function longest(entry: FullModelEntry): number {
  const duration = entry.params?.duration;
  const values = (duration?.values ?? []).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : (duration?.max ?? 0);
}

describe("there is no multi-shot mode", () => {
  it("is not a video generation mode", () => {
    expect(VIDEO_GENERATION_MODES).not.toContain("multi_shot");
  });

  it("is served by no model and named by no source group", () => {
    for (const entry of getFullModelConfig("video").models) {
      expect(modesOf(entry), entry.name).not.toContain("multi_shot");
      for (const group of entry.source_groups ?? []) expect(group.mode, entry.name).not.toBe("multi_shot");
    }
  });
});

describe("the modes a model can write shots in", () => {
  it("is exactly these fourteen models", () => {
    const taking = getFullModelConfig("video")
      .models.filter((m) => modesOf(m).some((mode) => storyboardSpec(paramsOf(m.name), mode) !== undefined))
      .map((m) => m.name)
      .sort();
    expect(taking).toEqual(SHOT_MODES.map(([name]) => name).sort());
  });

  it.each(SHOT_MODES)("%s takes shots in %j and in no other mode it serves", (name, modes) => {
    const entry = videoEntry(name);
    for (const mode of modesOf(entry)) {
      expect(storyboardSpec(paramsOf(name), mode) !== undefined, `${name} in ${mode}`).toBe(modes.includes(mode));
    }
  });

  it.each(SHOT_MODES.filter(([name]) => !KLING.has(name)))("%s writes each shot into the prompt with its running seconds", (name, modes) => {
    const entry = videoEntry(name);
    expect(storyboardSpec(paramsOf(name), modes[0]!)).toMatchObject({
      shotsParam: "shots",
      fixed: {},
      secondsField: "duration",
      totalParam: "duration",
      maxShots: 6,
      intoPrompt: "Shot {n} [{start}-{end}s]: {prompt}",
      autoParam: undefined,
    });
    expect(entry.params?.shots?.fields?.duration?.values).toEqual(Array.from({ length: longest(entry) }, (_, index) => index + 1));
  });

  it.each(SHOT_MODES.filter(([name]) => KLING.has(name)))("%s sends its shots in multi_prompt and offers its own auto level", (name, modes) => {
    const params = paramsOf(name);
    expect(storyboardSpec(params, modes[0]!)).toMatchObject({
      shotsParam: "multi_prompt",
      fixed: { shot_type: "customize" },
      totalParam: "duration",
      maxShots: 6,
      intoPrompt: undefined,
      autoParam: "auto_shots",
    });
    expect(params.auto_shots).toMatchObject({ values: [true, false], default: false, absent_value: false, modes: [...modes], fill: "panel" });
  });
});

describe("Seedance 2.5 in text and reference to video", () => {
  const SOURCES = ["images", "videos", "audios", "style_images"] as const;

  it("serves text to video and reference to video", () => {
    expect(modesOf(videoEntry("seedance-2.5-text-to-video")).sort()).toEqual(["ref", "t2v"]);
  });

  it.each(SOURCES)("takes %s only in reference to video", (source) => {
    expect(paramsOf("seedance-2.5-text-to-video")[source]?.modes).toEqual(["ref"]);
  });

  it("needs at least one source in reference to video, a style picture counting as one", () => {
    expect(videoEntry("seedance-2.5-text-to-video").source_groups).toEqual([{ mode: "ref", any_of: [...SOURCES] }]);
  });
});

describe("the model each mode opens on", () => {
  // The panel opens a mode on the first model the catalog lists for it, so an
  // entry placed ahead of these would change what every user sees.
  it.each([
    ["t2v", "gemini-omni-1.1-flash-text-to-video"],
    ["i2v", "gemini-omni-1.1-flash-image-to-video"],
    ["first_last", "gemini-omni-1.1-flash-image-to-video"],
    ["ref", "minimax-h3-reference-to-video"],
  ])("%s opens on %s", (mode, name) => {
    const first = getFullModelConfig("video").models.find((m) => modesOf(m).includes(mode));
    expect(first?.name).toBe(name);
  });

  it("lists Seedance 2.5 last in reference to video", () => {
    const ref = getFullModelConfig("video").models.filter((m) => modesOf(m).includes("ref")).map((m) => m.name);
    expect(ref.at(-1)).toBe("seedance-2.5-text-to-video");
  });
});

describe("the names each mode shows", () => {
  /**
   * Each model a mode offers, by the name its list shows.
   * @param mode - The mode.
   * @returns The names, by model id.
   */
  function labelsIn(mode: string): Record<string, string> {
    const peers = getFullModelConfig("video").models.filter((m) => modesOf(m).includes(mode));
    const named = peers.map((m) => ({ ...m, display_name: m.display_name ?? m.name }));
    return Object.fromEntries(named.map((m) => [m.name, modelLabel(m, named)]));
  }

  it.each(["t2v", "i2v", "first_last", "ref"])("%s names each model once, by the vendor's name alone", (mode) => {
    const labels = labelsIn(mode);
    expect(new Set(Object.values(labels)).size).toBe(Object.keys(labels).length);
    for (const [name, label] of Object.entries(labels)) {
      expect(label, name).toBe(videoEntry(name).display_name);
    }
  });
});
