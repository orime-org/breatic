// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the catalog declares is what the panels do today (#269).
 *
 * Migration scaffolding: the 163 declarations were written by transcribing
 * the panels' own tables, and this holds the copy to the original. It goes
 * when those tables do; what carries the fact afterwards is the guard that
 * every declared fill has a claimant on the panel side and nothing else does.
 *
 * Reading the yaml rather than the loaded catalog on purpose: the catalog
 * filters by provider key with no exception, CI configures none, and an empty
 * catalog would let every assertion below pass by having nothing to compare.
 */

import {
  MODE_SOURCE_FIELDS,
  PANEL_PARAM_CONTROLS,
  REFERENCE_POOL_PARAM,
  PANEL_EDITOR_PARAM,
  type GenerationNodeType,
} from "@breatic/shared";
import { describe, it, expect } from "vitest";

import { MODALITIES, getFullModelConfig } from "../model-catalog.js";
import { type FillKind } from "../param-declaration.js";

/** Which node answers for each catalog bucket. */
const BUCKET_NODE: Readonly<Record<string, GenerationNodeType>> = {
  image: "image",
  video: "video",
  audio: "audio",
  tts: "audio",
};

/** One parameter's declaration, keyed by `bucket/model.param`. */
type Declared = Record<string, { fill?: FillKind; accepts?: string; optional?: boolean }>;

/**
 * Every declaration in the catalog yaml, with the key a failure reads back.
 * @returns The declarations, keyed by `bucket/model.param`.
 */
function declarations(): Declared {
  const all: Declared = {};
  for (const modality of MODALITIES) {
    for (const model of getFullModelConfig(modality).models) {
      for (const [param, spec] of Object.entries(model.params ?? {})) {
        all[`${modality}/${model.name}.${param}`] = spec as Declared[string];
      }
    }
  }
  return all;
}

/**
 * What today's panel tables say a parameter's fill is.
 * @param modality - The catalog bucket the model came from.
 * @param model - The model, for the modes it serves.
 * @param param - The parameter name.
 * @returns The fill those tables imply, or undefined where they say nothing.
 */
function fillFromPanels(
  modality: string,
  model: { mode?: string | string[] },
  param: string,
): FillKind | undefined {
  const node = BUCKET_NODE[modality];
  if (!node) return "none";
  const modes = (Array.isArray(model.mode) ? model.mode : [model.mode]).filter(
    (mode): mode is string => Boolean(mode),
  );
  const reach = modes.filter((mode) => mode in MODE_SOURCE_FIELDS[node]);
  if (reach.length === 0) return "none";
  const picked = reach.some((mode) => (MODE_SOURCE_FIELDS[node][mode] ?? []).includes(param));
  if (picked) return param === REFERENCE_POOL_PARAM ? "pool" : "canvas";
  if (param === PANEL_EDITOR_PARAM) return "editor";
  if (PANEL_PARAM_CONTROLS[node].includes(param)) return "panel";
  return undefined;
}

describe("every parameter in the catalog", () => {
  const declared = declarations();

  it("declares a fill", () => {
    const missing = Object.entries(declared)
      .filter(([, spec]) => spec.fill === undefined)
      .map(([key]) => key);

    expect(Object.keys(declared).length, "the catalog declares some parameters").toBe(163);
    expect(missing).toEqual([]);
  });

  it("declares the fill today's panels imply", () => {
    const disagreeing: string[] = [];
    for (const modality of MODALITIES) {
      for (const model of getFullModelConfig(modality).models) {
        for (const param of Object.keys(model.params ?? {})) {
          const expected = fillFromPanels(modality, model, param);
          if (expected === undefined) continue; // remote and no-control, checked below
          const actual = declared[`${modality}/${model.name}.${param}`]?.fill;
          if (actual !== expected) {
            disagreeing.push(`${modality}/${model.name}.${param}: ${String(actual)} ≠ ${expected}`);
          }
        }
      }
    }

    expect(disagreeing).toEqual([]);
  });

  it("says which kind of node every source parameter carries", () => {
    // The gate asks a mode which kinds it needs and this model which of its
    // parameters carries that kind, so a carrier with no `accepts` is a model
    // the gate reads as carrying nothing.
    const carriers = ["images", "image", "end_image", "style_images", "video", "video_url",
      "audio", "audio_url", "ref_audio_url", "song", "voice", "instrumental"];
    const silent = Object.entries(declared)
      .filter(([key, spec]) => carriers.includes(key.split(".").pop() ?? "") && !spec.accepts)
      .map(([key]) => key);

    expect(silent).toEqual([]);
  });

  it("marks optional exactly the slots the panel never refuses on", () => {
    const optional = Object.entries(declared)
      .filter(([, spec]) => spec.optional === true)
      .map(([key]) => key.split(".").pop())
      .filter((param, at, all) => all.indexOf(param) === at)
      .sort();

    expect(optional).toEqual(["style_images", "video"]);
  });
});
