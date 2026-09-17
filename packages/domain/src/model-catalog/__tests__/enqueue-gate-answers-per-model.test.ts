// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the pre-enqueue gate answers, model by model, once it reads the
 * declarations (#269).
 *
 * The gate reads `modes.yaml` through the catalog's `sourcesByMode`, so the
 * cases below are written out rather than derived from the same declarations
 * -- a check built out of the answer would agree with it whatever it says.
 *
 * Every case goes through `useFullCatalog()`: the catalog filters by provider
 * key with no exception and CI configures none, so without it the catalog is
 * empty here and every loop below would pass by having nothing to walk.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  MODALITIES,
  getModelCatalog,
  violatesSourceRequirementForModel,
} from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

/** One model the gate guards, with what its modes need. */
interface Guarded {
  /** The name a task names. */
  name: string;
  /** The bucket it came from. */
  modality: string;
  /** Every source type any of its modes needs. */
  needs: string[];
}

/**
 * Every model the gate guards: one whose every mode needs source material.
 *
 * A model with one source-less mode runs from words alone, and the gate lets
 * an empty submission through for it by design.
 * @returns Those models, with the types they need.
 */
function guardedModels(): Guarded[] {
  const found: Guarded[] = [];
  for (const modality of MODALITIES) {
    for (const entry of getModelCatalog()[modality]) {
      const byMode = Object.values(entry.sourcesByMode);
      if (byMode.length === 0 || byMode.some((types) => types.length === 0)) continue;
      found.push({ name: entry.name, modality, needs: [...new Set(byMode.flat())] });
    }
  }
  return found;
}

/**
 * A payload carrying one usable value for each type, under a name that model
 * declares.
 * @param model - The model the payload is for.
 * @param needs - The source types to carry.
 * @returns The params, or undefined when the model declares no carrier for one.
 */
function payloadCarrying(
  model: string,
  needs: readonly string[],
): Record<string, unknown> | undefined {
  const declared = MODALITIES.flatMap((modality) =>
    Object.entries(getModelCatalog()[modality].find((m) => m.name === model)?.params ?? {}),
  );
  const params: Record<string, unknown> = {};
  for (const type of needs) {
    // The carrier is whichever of this model's own params says it takes that
    // kind -- the same question the gate asks, so a payload built here is one
    // this model could really be sent.
    const carrier = declared.find(([, spec]) => spec.accepts === type);
    if (!carrier) return undefined;
    const [field, spec] = carrier;
    params[field] =
      spec.type === "list" ? ["https://example.invalid/a"] : "https://example.invalid/a";
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
      .map((m) => `${m.modality}/${m.name}`);

    expect(waved).toEqual([]);
  });

  it("accepts every guarded model a submission carrying what its modes need", () => {
    const refused: string[] = [];
    for (const model of guardedModels()) {
      const params = payloadCarrying(model.name, model.needs);
      if (params === undefined) {
        refused.push(`${model.modality}/${model.name}: declares no carrier for ${model.needs.join(", ")}`);
        continue;
      }
      if (violatesSourceRequirementForModel(model.name, params)) {
        refused.push(`${model.modality}/${model.name}: ${JSON.stringify(params)}`);
      }
    }

    expect(refused).toEqual([]);
  });

  it("refuses a submission whose only picture rides in a slot the run may skip", () => {
    // `style_images` is a source the vendor generates without, so it is not a
    // carrier the gate counts; a payload holding only that is a run with no
    // source at all.
    const editing = getModelCatalog().image.find(
      (m) =>
        Object.keys(m.params ?? {}).includes("style_images") &&
        Object.values(m.sourcesByMode).every((types) => types.length > 0),
    );
    expect(editing, "the catalog has an editing model offering style references").toBeDefined();

    expect(
      violatesSourceRequirementForModel(editing?.name, {
        style_images: ["https://example.invalid/style.png"],
      }),
    ).toBe(true);
  });

  it("refuses a bare string where the worker reads a list", () => {
    const pooled = guardedModels().find((m) =>
      Object.keys(
        getModelCatalog()[m.modality as "image"].find((e) => e.name === m.name)?.params ?? {},
      ).includes("images"),
    );
    expect(pooled, "the catalog has a guarded model reading its source from a list").toBeDefined();

    expect(
      violatesSourceRequirementForModel(pooled?.name, { images: "https://example.invalid/a.png" }),
    ).toBe(true);
  });
});
