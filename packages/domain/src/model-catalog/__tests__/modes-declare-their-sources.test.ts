// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The yaml says what each mode needs, and says the same as the table it
 * replaces (#269).
 *
 * Migration scaffolding: `MODE_REQUIRED_SOURCES` is the answer in force
 * today, so filling `sources` in is a transcription and this holds the copy
 * to the original. It goes when the table does, and what carries the fact
 * afterwards is the guard that every mode's sources are carriable by every
 * model declaring that mode.
 *
 * Two rows differ on purpose. `understand` has no entry in the table at all,
 * so its four modes are unguarded today while their models declare source
 * parameters the gate recognises; a submission with no source there reaches
 * the worker and fails upstream. Writing what they need turns the gate on for
 * them, which is the change A8b names and the cases below pin.
 */

import { describe, it, expect } from "vitest";

import { MODALITIES, getFullModelConfig } from "../model-catalog.js";
import { getModeConfig } from "../mode-config.js";
import { MODE_REQUIRED_SOURCES } from "../source-requirement.js";

/** The modes whose declared need is wider than the table enforces today. */
const NEWLY_GUARDED: Readonly<Record<string, readonly string[]>> = {
  "understand.vi": ["image"],
  "understand.vv": ["video"],
  "understand.va": ["audio"],
  "understand.transcribe": ["audio"],
};

describe("every mode in the catalog", () => {
  const config = getModeConfig();

  it("declares the source types the execute gate requires of it today", () => {
    const declared: Record<string, readonly string[]> = {};
    for (const [bucket, modes] of Object.entries(config)) {
      for (const [mode, row] of Object.entries(modes)) {
        if (row.sources.length > 0) declared[`${bucket}.${mode}`] = [...row.sources].sort();
      }
    }

    const enforced: Record<string, readonly string[]> = {};
    for (const [bucket, modes] of Object.entries(MODE_REQUIRED_SOURCES)) {
      for (const [mode, sources] of Object.entries(modes)) {
        enforced[`${bucket}.${mode}`] = [...sources].sort();
      }
    }

    expect(declared).toEqual({ ...enforced, ...NEWLY_GUARDED });
  });

  it("is declared for every mode the gate has a row for", () => {
    const missing = Object.entries(MODE_REQUIRED_SOURCES).flatMap(([bucket, modes]) =>
      Object.keys(modes)
        .filter((mode) => config[bucket]?.[mode] === undefined)
        .map((mode) => `${bucket}.${mode}`),
    );

    expect(missing, "a mode the gate judges has to have a row of its own").toEqual([]);
  });

  it("takes any one of its slots only where a mode says so", () => {
    const anyOf = Object.entries(config).flatMap(([bucket, modes]) =>
      Object.entries(modes)
        .filter(([, row]) => row.sourceRule === "any_of")
        .map(([mode]) => `${bucket}.${mode}`),
    );

    // The audio panel refuses on an empty set rather than on an empty slot
    // (`required.some(...)`), and this is the one mode it does that for.
    expect(anyOf).toEqual(["audio.a2m"]);
  });

  it("has a model behind every mode it declares", () => {
    // Read off the yaml rather than off the loaded catalog: that one filters
    // by provider key, so a deployment with none configured would find every
    // mode orphaned and this would pass by having nothing to compare.
    const served = new Map<string, Set<string>>();
    for (const modality of MODALITIES) {
      const modes = new Set<string>();
      for (const model of getFullModelConfig(modality).models) {
        for (const mode of Array.isArray(model.mode) ? model.mode : [model.mode]) {
          if (mode) modes.add(mode);
        }
      }
      served.set(modality, modes);
    }

    const orphans = Object.entries(config).flatMap(([bucket, modes]) =>
      Object.keys(modes)
        .filter((mode) => !served.get(bucket)?.has(mode))
        .map((mode) => `${bucket}.${mode}`),
    );

    expect(orphans, "a mode no model serves is a row nothing can answer for").toEqual([]);
  });
});
