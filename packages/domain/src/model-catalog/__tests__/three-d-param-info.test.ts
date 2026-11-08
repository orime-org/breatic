// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the agent is told about the 3D entries' settings (inner#1691, design
 * 2.3): a condition on another param's value, bounds that depend on other
 * params, and the model's forced values, read off the real catalog.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { sceneModelsForMode, type ModelInfo } from "../mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

beforeEach(useFullCatalog);
afterAll(restoreProcessEnv);

/**
 * The models the 3D answer gives for one mode.
 * @param mode - `t23d` or `i23d`.
 * @returns The models.
 * @throws {Error} When the answer says the mode is unavailable.
 */
function modelsIn(mode: string): ModelInfo[] {
  const answer = sceneModelsForMode(mode);
  if (!answer.available) throw new Error(`3D mode ${mode} is unavailable: ${JSON.stringify(answer)}`);
  return answer.models;
}

describe("the 3D settings as the agent reads them", () => {
  it("says delight counts only while texture is on at version v3.5", () => {
    for (const mode of ["t23d", "i23d"]) {
      for (const model of modelsIn(mode)) {
        expect(model.params.delight?.gate, model.name).toEqual({
          flag_on: "texture",
          equals: { texture_version: "v3.5" },
        });
        expect(model.params.texture_quality?.gate, model.name).toEqual({ flag_on: "texture" });
      }
    }
  });

  it("gives the face limit its own range and the ranges other settings switch to", () => {
    for (const mode of ["t23d", "i23d"]) {
      for (const model of modelsIn(mode)) {
        expect(model.params.face_limit, model.name).toMatchObject({
          type: "integer",
          min: 1,
          max: 1_500_000,
          bounds: [
            { when: { flag_on: "smart_low_poly" }, min: 500, max: 20_000 },
            { when: { equals: { geometry_quality: "detailed" } }, max: 2_000_000 },
          ],
        });
      }
    }
  });

  it("names the forced values every model applies, in order", () => {
    const names: string[] = [];
    for (const mode of ["t23d", "i23d"]) {
      for (const model of modelsIn(mode)) {
        names.push(model.name);
        const forces = (model as { forces?: Array<{ id: string; set: Record<string, unknown> }> }).forces ?? [];
        expect(
          forces.map((f) => ({ id: f.id, set: f.set })),
          model.name,
        ).toEqual([
          { id: "parts_geometry_only", set: { texture: false, pbr: false } },
          { id: "pbr_needs_texture", set: { texture: true } },
          { id: "fast_uses_v35", set: { texture_version: "v3.5" } },
        ]);
      }
    }
    expect(names.sort()).toEqual(["tripo-h3.1-i23d", "tripo-h3.1-multiview", "tripo-h3.1-t23d"]);
  });
});
