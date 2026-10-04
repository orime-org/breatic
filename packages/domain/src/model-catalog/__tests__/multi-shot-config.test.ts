// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The multi-shot mode, read off the real config: which models run it, and how
 * each one takes its shots — Kling through its own `multi_prompt` field, the
 * rest written into the prompt one timed line per shot.
 */

import { initCore } from "@breatic/core";
import { modelLabel, storyboardSpec, type ParamDescriptor } from "@breatic/shared";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig, type FullModelEntry } from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

const KLING: ReadonlyArray<readonly [string, string]> = [
  ["kling-v3.0-4k-text-to-video", "t2v"],
  ["kling-video-o3-4k-image-to-video", "i2v"],
];

const PROMPT_WRITTEN = [
  "seedance-2.5-text-to-video",
  "seedance-2.5-image-to-video",
  "gemini-omni-1.1-flash-text-to-video",
  "gemini-omni-1.1-flash-image-to-video",
  "gemini-omni-1.1-flash-reference-to-video",
  "wan-3.0-text-to-video",
  "wan-3.0-image-to-video",
  "wan-3.0-reference-to-video",
  "minimax-h3-text-to-video",
  "minimax-h3-image-to-video",
  "minimax-h3-reference-to-video",
  "happyhorse-1.1-reference-to-video",
];

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
 * The longest total a model's duration control offers.
 * @param entry - The model's config entry.
 * @returns Its largest value, or its max for a range.
 */
function longest(entry: FullModelEntry): number {
  const duration = entry.params?.duration;
  const values = (duration?.values ?? []).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : (duration?.max ?? 0);
}

describe("the models the multi-shot mode offers", () => {
  it("is exactly the two Kling models and the twelve that take their shots in the prompt", () => {
    const running = getFullModelConfig("video")
      .models.filter((m) => [m.mode].flat().includes("multi_shot"))
      .map((m) => m.name)
      .sort();
    expect(running).toEqual([...KLING.map(([name]) => name), ...PROMPT_WRITTEN].sort());
  });

  it.each(PROMPT_WRITTEN)("%s writes each shot into the prompt with its running seconds", (name) => {
    const entry = videoEntry(name);
    const spec = storyboardSpec((entry.params ?? {}) as Record<string, ParamDescriptor>, "multi_shot");
    expect(spec).toMatchObject({
      shotsParam: "shots",
      fixed: {},
      secondsField: "duration",
      totalParam: "duration",
      maxShots: 6,
      intoPrompt: "Shot {n} [{start}-{end}s]: {prompt}",
    });
    const seconds = entry.params?.shots?.fields?.duration?.values;
    expect(seconds).toEqual(Array.from({ length: longest(entry) }, (_, index) => index + 1));
  });

  it.each(KLING)("%s sends its shots in multi_prompt under the customize tier", (name) => {
    const params = (videoEntry(name).params ?? {}) as Record<string, ParamDescriptor>;
    expect(storyboardSpec(params, "multi_shot")).toMatchObject({
      shotsParam: "multi_prompt",
      fixed: { shot_type: "customize" },
      totalParam: "duration",
      maxShots: 6,
      intoPrompt: undefined,
    });
    expect(params.shot_type?.values).toEqual(["customize"]);
  });

  it.each(KLING)("%s offers auto multi-shot as a switch only in %s", (name, mode) => {
    expect(videoEntry(name).params?.auto_shots).toMatchObject({
      upstream: "shot_type",
      upstream_values: { true: "intelligence" },
      values: [true, false],
      default: false,
      absent_value: false,
      modes: [mode],
      fill: "panel",
    });
  });
});

describe("the names the multi-shot mode shows", () => {
  /**
   * Each model a mode offers, by the name its list shows.
   * @param mode - The mode.
   * @returns The names, by model id.
   */
  function labelsIn(mode: string): Record<string, string> {
    const peers = getFullModelConfig("video").models.filter((m) => [m.mode].flat().includes(mode));
    const named = peers.map((m) => ({ ...m, display_name: m.display_name ?? m.name }));
    return Object.fromEntries(named.map((m) => [m.name, modelLabel(m, named)]));
  }

  it("tells a model's text, image and reference versions apart where all three appear", () => {
    expect(labelsIn("multi_shot")).toMatchObject({
      "gemini-omni-1.1-flash-text-to-video": "Gemini Omni 1.1 Flash Text-to-Video",
      "gemini-omni-1.1-flash-image-to-video": "Gemini Omni 1.1 Flash Image-to-Video",
      "gemini-omni-1.1-flash-reference-to-video": "Gemini Omni 1.1 Flash Reference",
      "kling-v3.0-4k-text-to-video": "Kling 3.0 4K",
      "happyhorse-1.1-reference-to-video": "HappyHorse 1.1",
      "seedance-2.5-text-to-video": "Seedance 2.5 Text-to-Video",
      "seedance-2.5-image-to-video": "Seedance 2.5 Image-to-Video",
    });
  });

  it("names each version by the vendor's name alone in a mode where it appears once", () => {
    expect(labelsIn("i2v")["gemini-omni-1.1-flash-image-to-video"]).toBe("Gemini Omni 1.1 Flash");
    expect(labelsIn("ref")["wan-3.0-reference-to-video"]).toBe("Wan 3.0");
    expect(labelsIn("first_last")["flux-3-start-end-to-video"]).toBe("FLUX 3");
    expect(labelsIn("i2v")["seedance-2.5-image-to-video"]).toBe("Seedance 2.5");
    expect(labelsIn("t2v")["seedance-2.5-text-to-video"]).toBe("Seedance 2.5");
  });
});

describe("which model each image mode opens with", () => {
  // The panel opens a mode on the first model the catalog lists for it, so a
  // new entry placed ahead of these would change what every reader sees.
  it.each([
    ["i2v", "gemini-omni-1.1-flash-image-to-video"],
    ["first_last", "gemini-omni-1.1-flash-image-to-video"],
    ["multi_shot", "gemini-omni-1.1-flash-text-to-video"],
  ])("%s opens on %s", (mode, name) => {
    const first = getFullModelConfig("video").models.find((m) => [m.mode].flat().includes(mode));
    expect(first?.name).toBe(name);
  });
});
