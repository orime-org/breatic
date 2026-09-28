// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * resolveModel / validateParams behavior pins (#1672 model-config
 * unification). Written GREEN against the pre-migration worker loader,
 * then kept green across the switch to domain's getFullModelConfig — the
 * transport connection fields (baseUrl / apiKey / timeout / ...) are the
 * worker's production critical path, so every field is pinned against the
 * real config/models yaml.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";
import { resolveModel, validateParams } from "@worker/providers/shared.js";

// Stand in for the worker entry (composition root): inject the schema's
// required vars plus deterministic API keys so provider resolution is
// reproducible regardless of the developer's real .env.
beforeAll(() => {
  initCore({
    DATABASE_URL: "postgres://localhost:5432/breatic_test",
    WAVESPEED_API_KEY: "test-wavespeed-key",
  });
});

describe("resolveModel (#1672 behavior pins)", () => {
  it("resolves every transport connection field for image/midjourney", () => {
    const resolved = resolveModel("image", "midjourney");
    expect(resolved).toMatchObject({
      modelName: "midjourney",
      providerName: "wavespeed",
      modelId: "midjourney/text-to-image",
      baseUrl: "https://api.wavespeed.ai/api/v3",
      apiKey: "test-wavespeed-key",
      timeout: 120,
      maxConcurrency: 50,
      mode: "t2i",
    });
    expect(resolved.tokenPrice).toBeUndefined();
    expect(resolved.creditPrice).toBeUndefined();
    expect(resolved.litellmModel).toBeUndefined();
  });

  it("throws for an unknown model", () => {
    expect(() => resolveModel("image", "no-such-model")).toThrow(/not found/);
  });
});

describe("validateParams (#1672 behavior pins)", () => {
  it("drops unknown params, keeps valid ones, and fills defaults", () => {
    const [name, cleaned] = validateParams("image", "midjourney", {
      aspect_ratio: "16:9",
      bogus_param: 1,
    });
    expect(name).toBe("midjourney");
    expect(cleaned.aspect_ratio).toBe("16:9");
    expect("bogus_param" in cleaned).toBe(false);
    expect(cleaned.stylize).toBe(0);
    expect(cleaned.chaos).toBe(0);
  });

  it("replaces out-of-enum values with the default", () => {
    const [, cleaned] = validateParams("image", "midjourney", {
      aspect_ratio: "5:4",
    });
    expect(cleaned.aspect_ratio).toBe("1:1");
  });

  it("pins the talking-head model's declaration: two sources, no params pill (#1935)", () => {
    // The model's declared set is its contract with `validateParams`, which
    // keeps a declared key and drops an undeclared one. The prompt in the
    // input is synthetic on purpose: production lifts the prompt out of the
    // params before validating (`takePromptAndValidate`), so this is a claim
    // about the catalog, not about where a typed prompt goes.
    const [name, cleaned] = validateParams("video", "omnihuman-1.5", {
      image: "https://cdn/portrait.png",
      audio: "https://cdn/speech.mp3",
      prompt: "a drone shot over a canyon",
    });
    expect(name).toBe("omnihuman-1.5");
    expect(cleaned).toEqual({ image: "https://cdn/portrait.png", audio: "https://cdn/speech.mp3" });
  });
});
