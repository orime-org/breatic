// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Mureka V9.5 Song composes either from style and references or from a melody
 * (breatic#1393): Mureka's melody_id "cannot be combined with prompt,
 * reference_id, or vocal_id", while the other three combine freely, so the
 * choice is one setting of the Reference to Music mode.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promptTaken, resolveParams, sanitizeModelCatalog, type ModelEntry } from "@breatic/shared";

import { getFullModelConfig, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

const NAME = "mureka-v9.5-generate-song";

describe("Mureka V9.5 Song's compose-from setting", () => {
  beforeAll(() => {
    useFullCatalog();
  });
  afterAll(() => {
    restoreProcessEnv();
  });

  const entry = (): ModelEntry => {
    const found = sanitizeModelCatalog(JSON.parse(JSON.stringify(getModelCatalog()))).audio.find((m) => m.name === NAME);
    if (!found) throw new Error(`${NAME} missing from the audio catalog`);
    return found;
  };

  it("is a two-value panel setting of Reference to Music, on style and references by default", () => {
    expect(getFullModelConfig("audio").models.find((m) => m.name === NAME)?.params?.compose_from).toMatchObject({
      modes: ["a2m"],
      values: ["references", "melody"],
      default: "references",
      fill: "panel",
      label: "Compose from",
      value_labels: { references: "Style & references", melody: "Melody" },
    });
  });

  it("sends song and vocals only with style and references, and the melody only on its own", () => {
    const model = entry();
    const all = { lyrics: "la", song: "s", vocal: "v", melody: "m" };
    expect(Object.keys(resolveParams(model, { ...all, compose_from: "references" })).sort()).toEqual(["compose_from", "lyrics", "song", "vocal"]);
    expect(Object.keys(resolveParams(model, { ...all, compose_from: "melody" })).sort()).toEqual(["compose_from", "lyrics", "melody"]);
  });

  it("takes the style prompt except when composing from a melody in Reference to Music", () => {
    const model = entry();
    expect(promptTaken(model, "a2m", { compose_from: "references" })).toBe(true);
    expect(promptTaken(model, "a2m", { compose_from: "melody" })).toBe(false);
    expect(promptTaken(model, "t2m", { compose_from: "melody" })).toBe(true);
  });
});
