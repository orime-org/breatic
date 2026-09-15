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
  GENERATION_NODE_BUCKETS,
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
  camera_fixed: "part of the camera cluster, which the video panel does not mount",
  stylize: "midjourney's three aesthetic dials have no control yet",
  chaos: "same cluster as stylize",
  weird: "same cluster as stylize",
  enable_web_search: "a model-side toggle the panel does not surface",
  duration_seconds: "the sound-effects length control is not built",
  prompt_influence: "the sound-effects adherence control is not built",
  loop: "the sound-effects loop switch is not built",
  audio_format: "output container, fixed by what the asset pipeline stores",
};

/**
 * Which node a catalog bucket's models answer for, read off the shared map.
 *
 * Inverted rather than written out, so a bucket added to a node is walked here
 * without anyone remembering to add a row: a bucket this check does not name
 * is a bucket whose parameters it silently passes over.
 */
const BUCKET_NODE: Readonly<Record<string, GenerationNodeType>> = Object.fromEntries(
  Object.entries(GENERATION_NODE_BUCKETS).flatMap(([nodeType, buckets]) =>
    buckets.map((bucket) => [bucket, nodeType as GenerationNodeType]),
  ),
);

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("every parameter in the catalog", () => {
  it("is picked on the canvas, drawn by its panel, or named as having no control", () => {
    const { seen, unaccounted } = walk();
    expect(seen.size, "the catalog declares some parameters").toBeGreaterThan(0);
    expect(unaccounted, "build a control for these, or say why there is none").toEqual([]);
  });

  it("names only parameters that reach this answer and have no control", () => {
    // Two ways a row goes stale, and both read exactly like a live row sitting
    // next to them: the parameter stopped being declared by anything this
    // answer reaches, or someone built the control and left the row saying
    // there is none. The second is the one that costs something, because the
    // row is then the reason nobody notices the control is missing from the
    // table the answer does read.
    const { seen } = walk();
    const controlled = new Set([
      ...Object.values(PANEL_PARAM_CONTROLS).flat(),
      ...Object.values(MODE_SOURCE_FIELDS).flatMap((byMode) =>
        Object.values(byMode).flat(),
      ),
    ]);
    expect(
      Object.keys(NO_CONTROL_BY_DESIGN).filter(
        (name) => !seen.has(name) || controlled.has(name),
      ),
      "drop these: nothing this answer reaches declares them, or they have a control",
    ).toEqual([]);
  });
});

/**
 * Every parameter every model this answer reaches declares, and which of them
 * nothing accounts for.
 * @returns The names seen, and the unaccounted ones as `bucket/model.param`.
 */
function walk(): { seen: Set<string>; unaccounted: string[] } {
  useFullCatalog();
  const catalog = getModelCatalog();
  const seen = new Set<string>();
  const unaccounted: string[] = [];
  for (const [bucket, nodeType] of Object.entries(BUCKET_NODE)) {
    const entries = (catalog as unknown as Record<string, ModelEntry[]>)[bucket] ?? [];
    const pickable = new Set(Object.values(MODE_SOURCE_FIELDS[nodeType]).flat());
    const panelModes: readonly string[] = GENERATION_NODE_MODES[nodeType];
    for (const entry of entries) {
      // A model whose every mode is a mini-tool operation never reaches a
      // generation node's answer, so its parameters are not this to answer.
      const modes = Array.isArray(entry.mode) ? entry.mode : [entry.mode];
      if (!modes.some((m) => panelModes.includes(m))) continue;
      for (const [name, descriptor] of Object.entries(entry.params)) {
        seen.add(name);
        if (pickable.has(name)) continue;
        // The voice picker locates its param by this marker rather than by
        // name, so a vendor's spelling of it is drawn without being listed.
        if (descriptor.remote_source !== undefined) continue;
        if (PANEL_PARAM_CONTROLS[nodeType].includes(name)) continue;
        if (name in NO_CONTROL_BY_DESIGN) continue;
        unaccounted.push(`${bucket}/${entry.name}.${name}`);
      }
    }
  }
  return { seen, unaccounted };
}
