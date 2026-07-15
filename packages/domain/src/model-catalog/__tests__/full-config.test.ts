// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * getFullModelConfig (#1672 model-config unification) — the backend-only
 * full-config accessor that makes domain the single YAML reader. The
 * worker's resolveModel/validateParams consume this instead of parsing
 * config/models themselves, so these tests pin exactly the fields the
 * worker's transport connection building depends on (base_url,
 * api_key_env, timeout, token_price, extra_params, ...) against the real
 * config files.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";
import {
  getFullModelConfig,
  getModelCatalog,
  resetModelCatalog,
} from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

describe("getFullModelConfig (#1672)", () => {
  it("exposes provider connection fields (base_url + api_key_env) for image/wavespeed", () => {
    const config = getFullModelConfig("image");
    const wavespeed = config.providers["wavespeed"];
    expect(wavespeed).toBeTruthy();
    expect(typeof wavespeed!.base_url).toBe("string");
    expect(wavespeed!.base_url!.startsWith("https://")).toBe(true);
    expect(typeof wavespeed!.api_key_env).toBe("string");
    expect(wavespeed!.api_key_env!.length).toBeGreaterThan(0);
  });

  it("keeps full per-provider model fields the catalog projection drops", () => {
    const config = getFullModelConfig("image");
    const midjourney = config.models.find((m) => m.name === "midjourney-v7");
    expect(midjourney).toBeTruthy();
    expect(midjourney!.providers?.[0]?.model_id).toBe("midjourney/text-to-image");
    const anyTokenPriced = config.models.some((m) =>
      (m.providers ?? []).some((p) => typeof p.token_price === "number"),
    );
    expect(anyTokenPriced).toBe(true);
  });

  it("preserves array modes as authored in yaml", () => {
    const config = getFullModelConfig("image");
    const arrayMode = config.models.some((m) => Array.isArray(m.mode));
    expect(arrayMode).toBe(true);
  });

  it("preserves param specs (values + default) the worker validates against", () => {
    const config = getFullModelConfig("image");
    const midjourney = config.models.find((m) => m.name === "midjourney-v7");
    const aspect = midjourney?.params?.["aspect_ratio"];
    expect(aspect?.values).toContain("16:9");
    expect(aspect?.default).toBe("1:1");
  });

  it("returns an empty config for an unknown modality", () => {
    expect(getFullModelConfig("no-such-modality")).toEqual({ models: [], providers: {} });
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
