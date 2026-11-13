// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the catalog answers a deployment with no upstream key configured (#1951, inner#1743): every model is listed,
 * each saying no upstream can serve it here and naming the variables its keys are read from, so the deployment is
 * told what to set rather than shown an empty picker. Availability asks only whether the variable is non-empty, never
 * whether the key works (user 2026-08-18).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { getFullModelConfig, getModelCatalog, MODALITIES } from "../model-catalog.js";
import { allProviderKeyNames, restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("a deployment with no upstream key", () => {
  it("lists every model of the catalog, none of them configured", () => {
    useEnvWithKeys([]);
    const catalog = getModelCatalog();
    for (const modality of MODALITIES) {
      expect(catalog[modality].map((m) => m.name), modality).toEqual(getFullModelConfig(modality).models.map((m) => m.name));
      for (const model of catalog[modality]) {
        expect(model.availability.upstreams.some((u) => u.configured), model.name).toBe(false);
        expect(model.availability.upstreams.length, `${model.name} names the variables to set`).toBeGreaterThan(0);
      }
    }
  });

  it("marks configured exactly the upstreams whose key is set", () => {
    useEnvWithKeys(["WAVESPEED_API_KEY"]);
    const models = MODALITIES.flatMap((m) => getModelCatalog()[m]);
    expect(allProviderKeyNames()).toContain("WAVESPEED_API_KEY");
    for (const model of models) {
      for (const u of model.availability.upstreams) {
        expect(u.configured, `${model.name} on ${u.upstream}`).toBe(u.envVar === "WAVESPEED_API_KEY");
      }
    }
    expect(models.some((m) => m.availability.upstreams.some((u) => u.configured))).toBe(true);
  });
});
