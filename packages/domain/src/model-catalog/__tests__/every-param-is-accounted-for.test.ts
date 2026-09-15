// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every parameter the catalog declares is reached one of three ways (#261).
 *
 * Models come and go without anyone touching code: a new yaml file is a new
 * model, and the answer the agent reads is built from it. What does not
 * follow automatically is a parameter nobody has built a control for -- the
 * answer says as much, truthfully, and the reader still cannot set it.
 *
 * So the fourth case is named here with the reason it has no control. A model
 * arriving with a parameter that is neither picked on the canvas, nor drawn
 * by its panel, nor listed below fails this: the choice is to build a control
 * or to write down why there is none.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  GENERATION_NODE_MODES,
  MODE_SOURCE_FIELDS,
  PANEL_PARAM_CONTROLS,
} from "@breatic/shared";
import type { GenerationNodeType, ModelEntry } from "@breatic/shared";

import { getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/**
 * Parameters the catalog declares that no panel offers, and why.
 *
 * A line here is a decision that this parameter runs at its default. Adding
 * one without a reason turns the check into a place to park a name.
 */
const NO_CONTROL_BY_DESIGN: Readonly<Record<string, string>> = {

  seed: "reproducibility plumbing; the product does not expose it",
  negative_prompt: "the prompt editor is the one place a reader writes words",
  generate_audio: "the video panel offers no audio track switch yet",
  keep_original_sound: "same switch as generate_audio, on the reference modes",
  camera_fixed: "part of the camera cluster, which the video panel does not mount",
  target_resolution: "upscaling is a mini-tool operation, not a generation setting",
  output_resolution: "same as target_resolution",
  source_width: "measured off the input, never chosen",
  source_height: "measured off the input, never chosen",
  stylize: "midjourney's three aesthetic dials have no control yet",
  chaos: "same cluster as stylize",
  weird: "same cluster as stylize",
  enable_web_search: "a model-side toggle the panel does not surface",
  duration_seconds: "the sound-effects length control is not built",
  prompt_influence: "the sound-effects adherence control is not built",
  loop: "the sound-effects loop switch is not built",
  audio_format: "output container, fixed by what the asset pipeline stores",
  lyrics: "the music panel writes lyrics through the prompt editor",
  mode: "a vendor-side switch the music panel pins",
  prompt: "the prompt editor, which is not one of a model's parameters",
};

/** The buckets each node type draws its models from, as the catalog names them. */
const BUCKET_NODE: Readonly<Record<string, GenerationNodeType>> = {
  image: "image",
  video: "video",
  audio: "audio",
  tts: "audio",
};

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("every parameter in the catalog", () => {
  it("is picked on the canvas, drawn by its panel, or named as having no control", () => {
    useFullCatalog();
    const catalog = getModelCatalog();
    const unaccounted: string[] = [];
    let seen = 0;
    for (const [bucket, nodeType] of Object.entries(BUCKET_NODE)) {
      const entries = (catalog as unknown as Record<string, ModelEntry[]>)[bucket] ?? [];
      const pickable = new Set(Object.values(MODE_SOURCE_FIELDS[nodeType]).flat());
      const panelModes: readonly string[] = GENERATION_NODE_MODES[nodeType];
      for (const entry of entries) {
        // A model whose every mode is a mini-tool operation never reaches a
        // generation node's answer, so its parameters are not this to answer.
        const modes = Array.isArray(entry.mode) ? entry.mode : [entry.mode];
        if (!modes.some((m) => panelModes.includes(m))) continue;
        for (const name of Object.keys(entry.params)) {
          seen += 1;
          if (pickable.has(name)) continue;
          if (PANEL_PARAM_CONTROLS[nodeType].includes(name)) continue;
          if (name in NO_CONTROL_BY_DESIGN) continue;
          unaccounted.push(`${bucket}/${entry.name}.${name}`);
        }
      }
    }
    expect(seen, "the catalog declares some parameters").toBeGreaterThan(0);
    expect(unaccounted, "build a control for these, or say why there is none").toEqual([]);
  });

  it("gives every named exemption a reason", () => {
    for (const [name, why] of Object.entries(NO_CONTROL_BY_DESIGN)) {
      expect(why.length, `${name} states why it has no control`).toBeGreaterThan(10);
    }
  });
});
