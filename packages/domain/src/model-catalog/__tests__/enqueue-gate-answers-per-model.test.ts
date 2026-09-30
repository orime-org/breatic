// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the pre-enqueue gate answers, model by model, once it reads each
 * model's own declarations (#2156).
 *
 * These walk the real catalog and hold the gate to one thing: a model none of
 * whose modes runs without material refuses an empty submission and accepts
 * one carrying what one of its modes needs. Both the guarded list and the
 * payloads come from the declarations, which is what makes them cover every
 * model in the catalog rather than the handful someone thought to write down.
 * Which declarations count is held by `missingSources`' own tests.
 *
 * Every case goes through `useFullCatalog()`: the catalog filters by provider
 * key with no exception and CI configures none, so without it the catalog is
 * empty here and every loop below would pass by having nothing to walk.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { missingSources, type ModelEntry } from "@breatic/shared";

import {
  MODALITIES,
  getModelCatalog,
  violatesSourceRequirementForModel,
} from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/**
 * The modes a catalog entry serves.
 * @param entry - The entry.
 * @returns Its modes as a list.
 */
function modesOf(entry: ModelEntry): string[] {
  return Array.isArray(entry.mode) ? entry.mode : [entry.mode];
}

/**
 * Every model the gate guards: one none of whose modes runs from nothing.
 * @returns Those entries.
 */
function guardedModels(): ModelEntry[] {
  return MODALITIES.flatMap((modality) => getModelCatalog()[modality]).filter((entry) =>
    modesOf(entry).every((mode) => missingSources(entry, mode, {}).length > 0),
  );
}

/**
 * A payload filling what the model's first mode needs, one value per
 * requirement, shaped the way that param declares.
 * @param entry - The model.
 * @returns The params.
 */
function payloadFor(entry: ModelEntry): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [field] of missingSources(entry, modesOf(entry)[0] ?? "", {})) {
    if (field === undefined) continue;
    const type = entry.params[field]?.type;
    params[field] =
      type === "items"
        ? [{ name: "a" }]
        : type === "list"
          ? ["https://example.invalid/a"]
          : "https://example.invalid/a";
  }
  return params;
}

describe("the pre-enqueue source gate, model by model", () => {
  beforeAll(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("refuses every guarded model a submission carrying nothing", () => {
    const guarded = guardedModels();
    expect(guarded.length, "the catalog has models this gate guards").toBeGreaterThan(0);

    const waved = guarded
      .filter((m) => !violatesSourceRequirementForModel(m.name, {}))
      .map((m) => m.name);

    expect(waved).toEqual([]);
  });

  it("accepts every guarded model a submission carrying what one of its modes needs", () => {
    const refused = guardedModels()
      .filter((m) => violatesSourceRequirementForModel(m.name, payloadFor(m)))
      .map((m) => `${m.name}: ${JSON.stringify(payloadFor(m))}`);

    expect(refused).toEqual([]);
  });

  it("refuses a bare string where the model reads a list", () => {
    // The first model whose only requirement is one list: a bare string in
    // it is the whole payload, so nothing else can satisfy the gate.
    const pooled = guardedModels().find((m) =>
      modesOf(m).every((mode) => {
        const missing = missingSources(m, mode, {});
        const field = missing[0]?.[0];
        return missing.length === 1 && field !== undefined && m.params[field]?.type === "list";
      }),
    );
    expect(pooled, "the catalog has a guarded model reading its source from a list").toBeDefined();
    if (!pooled) return;
    const field = missingSources(pooled, modesOf(pooled)[0] ?? "", {})[0]?.[0] ?? "";

    expect(
      violatesSourceRequirementForModel(pooled.name, { [field]: "https://example.invalid/a.png" }),
    ).toBe(true);
  });

  it("lets a model with a mode that runs from words alone through empty", () => {
    const song = getModelCatalog().audio.find((m) => m.name === "mureka-v9.5-generate-song");
    expect(song, "Mureka Song serves text-to-music and reference-to-music").toBeDefined();
    expect(violatesSourceRequirementForModel(song?.name, {})).toBe(false);
  });
});
