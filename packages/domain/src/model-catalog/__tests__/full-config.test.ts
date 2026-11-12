// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * getFullModelConfig (#1672 model-config unification) — the backend-only
 * full-config accessor that makes domain the single YAML reader. The
 * worker's param validation reads this instead of parsing config/models
 * itself, so these tests pin what it reads against the real config files.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initCore } from "@breatic/core";
import { useFullCatalog, restoreProcessEnv } from "./catalog-env.js";
import {
  getFullModelConfig,
  getModelCatalog,
  resetModelCatalog,
} from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("getFullModelConfig (#1672)", () => {
  it("preserves array modes as authored in yaml", () => {
    const config = getFullModelConfig("image");
    const arrayMode = config.models.some((m) => Array.isArray(m.mode));
    expect(arrayMode).toBe(true);
  });

  it("preserves param specs (values + default) the worker validates against", () => {
    const config = getFullModelConfig("image");
    const grok = config.models.find((m) => m.name === "grok-imagine-image-v2.0-text-to-image");
    const aspect = grok?.params?.["aspect_ratio"];
    expect(aspect?.values).toContain("16:9");
    expect(aspect?.default).toBe("1:1");
  });

  it("returns an empty config for an unknown modality", () => {
    expect(getFullModelConfig("no-such-modality")).toEqual({ models: [] });
  });

  it("caches per modality (same object identity across calls)", () => {
    expect(getFullModelConfig("image")).toBe(getFullModelConfig("image"));
  });

  it("stays consistent with the catalog projection (every catalog entry exists in full config)", () => {
    const fullNames = new Set(getFullModelConfig("image").models.map((m) => m.name));
    for (const entry of getModelCatalog().image) {
      expect(fullNames.has(entry.name)).toBe(true);
    }
  });

  it("resetModelCatalog clears the full-config cache too", () => {
    const before = getFullModelConfig("image");
    resetModelCatalog();
    const after = getFullModelConfig("image");
    expect(after).not.toBe(before);
    expect(after.models.length).toBe(before.models.length);
  });
});
